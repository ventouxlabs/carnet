/**
 * Security sanitizer + frontmatter normalizer for LLM-produced markdown
 * (carnet Stage 2, branch B3). This is the gate that makes it safe to hand a
 * model's raw output straight into an Obsidian-style vault.
 *
 * THREAT MODEL — the vault is a code-execution surface. Obsidian executes:
 *   - ```dataviewjs fenced blocks (Dataview plugin — near-ubiquitous)
 *   - ```dataview / inline `=…` DQL queries
 *   - Templater `<%…%>` expressions (executes JS)
 *   - raw <script>/<iframe>, on*= handler attributes, javascript: link targets
 *
 * POLICY — NEUTRALIZE, DO NOT DELETE. A knowledge vault legitimately holds
 * user-captured code snippets, so blunt deletion is silent data loss. Instead:
 *   - RENAME executable fence languages to inert ones (```dataviewjs → ```text).
 *   - ```js and ```html fenced blocks survive BYTE-FOR-BYTE — they are not an
 *     execution surface in Obsidian; the threat is Dataview + Templater. HTML
 *     neutralization therefore never reaches inside a fenced code block.
 *   - EXCEPTION: Templater `<%…%>` is stripped EVERYWHERE, fence or no fence.
 *     Templater does a raw find-and-replace over the whole file and ignores
 *     code fences, so a `<%…%>` hidden inside ```js / ```dataviewjs executes
 *     regardless. It is Templater's own execution syntax, never legitimate
 *     captured content, so byte-for-byte fence preservation does not apply to it.
 *   - Neutralize raw HTML (<script>/<iframe> removed, on*= handlers stripped),
 *     javascript: link targets, and data: targets in NON-image link contexts.
 *   - #60 inline images (`![alt](data:image/…)`) MUST survive — data: rewriting
 *     is scoped to `[text](data:…)` links only, never image sources.
 *
 * This module is a PURE function (no async, no file I/O, no native imports) so
 * it unit-tests in plain Node. All async happens at the omniroute call site.
 */

import { parseFrontmatter, splitFrontmatter } from "./frontmatter";

export type NoteType = "idea" | "journal" | "person" | "shared" | "note";

/**
 * Canonical top-level frontmatter key order per note type, mirroring the exact
 * shape prompts.ts asks the model to emit. A valid, prompt-shaped note is thus
 * re-serialized BYTE-FOR-BYTE; unknown extra keys are appended in their
 * original order so nothing is dropped.
 */
const CANONICAL_ORDER: Record<NoteType, readonly string[]> = {
  idea: ["created", "status", "tags"],
  journal: ["date", "tags", "people", "ideas"],
  person: ["name", "company", "title", "email", "phone", "linkedin", "met", "where", "tags"],
  shared: ["created", "kind", "tags"],
  // buildNotePrompt's template emits exactly these two keys. No `status`: a
  // note has no seedling/developing/mature maturity.
  note: ["created", "tags"],
};

/**
 * Keys that MUST be present for a note of each type to be considered
 * well-formed. Derived from the required structure prompts.ts defines. A note
 * missing any of these fails normalization (returns null) so the caller can
 * fall into its degraded path rather than persist a malformed note.
 */
const REQUIRED_KEYS: Record<NoteType, readonly string[]> = {
  idea: ["created", "status", "tags"],
  journal: ["date", "tags", "people"],
  person: ["name"],
  shared: ["kind"],
  note: ["created", "tags"],
};

// ── Sanitize (neutralize executable content) ──────────────────────────────────

/** Matches a fenced-code opening line: optional indent, ``` or ~~~ (>=3), info. */
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** Fence languages Obsidian executes — renamed to `text` (body preserved). */
const EXECUTABLE_FENCE_LANGS = new Set(["dataviewjs", "dataview"]);

/**
 * Neutralize executable content in a markdown document. Fence-aware: the HTML /
 * templater / link transforms run ONLY on text OUTSIDE fenced code blocks, so a
 * user's captured ```js or ```html snippet is never mutated. Executable fence
 * languages are renamed in place. Pure and total — never returns null.
 */
export function sanitizeMarkdown(markdown: string): string {
  // Templater `<%…%>` executes JS and ignores code fences (raw find-and-replace),
  // so it must die EVERYWHERE — inside ```js/```html/```dataviewjs bodies too,
  // not just the outside-fence text neutralizeText() handles. Strip it globally
  // up front, before the fence-aware pass preserves any remaining fence bodies.
  const lines = markdown
    .replace(/<%[\s\S]*?%>/g, "[templater expression removed]")
    .split("\n");
  const out: string[] = [];
  let textBuf: string[] = [];

  const flushText = (): void => {
    if (textBuf.length > 0) {
      out.push(neutralizeText(textBuf.join("\n")));
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flushText();
      const [, indent, marker, info] = fence;
      const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const isExecutable = EXECUTABLE_FENCE_LANGS.has(lang);
      out.push(isExecutable ? `${indent}${marker}text` : line);
      i++;
      // Consume the block body verbatim up to (and including) a matching close.
      const closeRe = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        out.push(lines[i]); // closing fence
        i++;
      }
      continue;
    }
    textBuf.push(line);
    i++;
  }
  flushText();
  return out.join("\n");
}

/**
 * Neutralize executable patterns in a NON-code text segment. Order matters:
 * multi-line constructs (templater, script/iframe bodies) are collapsed before
 * attribute- and link-level rewrites.
 */
function neutralizeText(text: string): string {
  let s = text;

  // Templater — executes JS. `<%= tp.date.now() %>`, `<% … %>`.
  s = s.replace(/<%[\s\S]*?%>/g, "[templater expression removed]");

  // <script>…</script> and a lone/unclosed opening tag.
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "[script removed]");
  s = s.replace(/<script\b[^>]*>/gi, "[script removed]");

  // <iframe>…</iframe> and a lone/unclosed opening tag.
  s = s.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "[iframe removed]");
  s = s.replace(/<iframe\b[^>]*>/gi, "[iframe removed]");

  // on*= inline event-handler attributes (onclick=, onload=, …). Strip the
  // whole attribute, quoted or bare, leaving the surrounding tag inert. The
  // leading delimiter is whitespace OR `/` so tag-slash forms without a space
  // (`<svg/onload=…>`, `<img/onerror=…>`) are caught, not just ` onload=…`.
  s = s.replace(/[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Inline Dataview DQL query span: a code span whose content starts with `=`.
  s = s.replace(/`=\s*[^`]*`/g, "`[inline dataview removed]`");

  // javascript: targets in ANY markdown link/image → replace the scheme so the
  // target becomes inert while keeping paren balance (`](javascript:x)` →
  // `](#x)`). Also covers a raw href="javascript:…".
  s = s.replace(/(\]\(\s*)javascript:/gi, "$1#");
  s = s.replace(/(\bhref\s*=\s*["']?)javascript:/gi, "$1#");

  // data: targets in NON-image links only. `[text](data:…)` → neutralized. The
  // image exception is MIME-GATED: only `![alt](data:image/…)` (a genuine inline
  // image — #60) is left untouched. A `data:text/html` (or any non-image mime)
  // disguised with a leading `!` is NOT a safe image and is neutralized too.
  s = s.replace(
    /(!?)(\[[^\]]*\]\(\s*)data:(image\/)?/gi,
    (full, bang: string, mid: string, image: string | undefined) =>
      bang && image ? full : `${bang}${mid}#`,
  );

  return s;
}

// ── Normalize frontmatter ─────────────────────────────────────────────────────

/**
 * Validate + canonicalize the frontmatter of a (already-sanitized) note.
 * Returns the note with frontmatter re-serialized in canonical key order, or
 * null when the block is missing/empty or a required key is absent. The body is
 * preserved byte-for-byte (splitFrontmatter guarantees header + body === input).
 */
export function normalizeFrontmatter(
  markdown: string,
  noteType: NoteType,
): string | null {
  const { header, body } = splitFrontmatter(markdown);
  if (!header) return null; // no frontmatter block at all

  const { fields, hasBlock } = parseFrontmatter(markdown);
  if (!hasBlock || fields.length === 0) return null;

  const present = new Set(fields.map(([key]) => key));
  for (const required of REQUIRED_KEYS[noteType]) {
    if (!present.has(required)) return null;
  }

  const ordered: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const key of CANONICAL_ORDER[noteType]) {
    if (seen.has(key)) continue;
    const field = fields.find(([k]) => k === key);
    if (field) {
      ordered.push(field);
      seen.add(key);
    }
  }
  for (const [key, value] of fields) {
    if (seen.has(key)) continue;
    ordered.push([key, value]);
    seen.add(key);
  }

  const block = ordered
    .map(([key, value]) => (value ? `${key}: ${value}` : `${key}:`))
    .join("\n");
  return `---\n${block}\n---\n${body}`;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Sanitize then normalize an LLM markdown response. Neutralization ALWAYS runs
 * (the security gate); normalization returns null when the frontmatter is
 * malformed so the omniroute caller can fall back to a degraded path.
 *
 * Signature matches the B3 wire-up contract:
 *   sanitizeAndNormalize(markdown, noteType): string | null
 */
export function sanitizeAndNormalize(
  markdown: string,
  noteType: NoteType,
): string | null {
  return normalizeFrontmatter(sanitizeMarkdown(markdown), noteType);
}
