/**
 * Security sanitizer + frontmatter normalizer for LLM-produced markdown
 * (carnet Stage 2, branch B3). This is the gate that makes it safe to hand a
 * model's raw output straight into an Obsidian-style vault.
 *
 * THREAT MODEL — the vault is a code-execution surface. Obsidian executes:
 *   - ```dataviewjs fenced blocks (Dataview plugin — near-ubiquitous)
 *   - ```dataview / inline `=…` DQL and `$=…` DataviewJS queries (any <code>)
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
 *   - Neutralize raw HTML (<script>/<iframe> removed, on*= handlers stripped,
 *     <code> escaped), javascript: link targets, and data: targets in
 *     NON-image link contexts.
 *   - Inline Dataview query spans are made INERT, content kept visible:
 *     `= x` → `inert: = x` (sanitizeInlineCode.ts).
 *   - #60 inline images (`![alt](data:image/…)`) MUST survive — data: rewriting
 *     is scoped to `[text](data:…)` links only, never image sources.
 *
 * This module is a PURE function (no async, no file I/O, no native imports) so
 * it unit-tests in plain Node. All async happens at the omniroute call site.
 */

import { parseFrontmatter, splitFrontmatter } from "./frontmatter";
import { certainlyFencedLines, isFenceLike, renameExecutableFence } from "./sanitizeFences";
import { makeInlineQueriesInert } from "./sanitizeInlineCode";

export type NoteType = "idea" | "journal" | "person" | "shared";

/**
 * Canonical top-level frontmatter key order per note type, mirroring the exact
 * shape prompts.ts asks the model to emit. A valid, prompt-shaped note is thus
 * re-serialized BYTE-FOR-BYTE. It is also the ALLOWLIST for model output
 * (B3 decision 1): any other key a model emits — `dg-publish`, `publish`,
 * `cssclasses`, or a custom key a prompt override asks for — is dropped.
 * App-owned keys (`location`, `fallback`, `rev`, …) are all added after this
 * gate, so it never sees them.
 */
export const CANONICAL_ORDER: Record<NoteType, readonly string[]> = {
  idea: ["created", "status", "tags"],
  journal: ["date", "tags", "people", "ideas"],
  person: ["name", "company", "title", "email", "phone", "linkedin", "met", "where", "tags"],
  shared: ["created", "kind", "tags"],
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
};

// ── Sanitize (neutralize executable content) ──────────────────────────────────

const TEMPLATER = /<%[\s\S]*?%>/g;
const TEMPLATER_REMOVED = "[templater expression removed]";

/**
 * Neutralize executable content in a markdown document. Frontmatter-aware and
 * fence-aware: the header is neutralized line by line and re-emitted with
 * exact `---` delimiters, then the body is scanned for fences from a clean
 * state. The HTML / link transforms skip only lines that are CERTAINLY inside
 * a fenced code block (see sanitizeFences.ts), so a user's captured ```js or
 * ```html snippet is never mutated. Executable fence languages are renamed on
 * every line. The pass repeats to a fixed point and fails closed at the cap,
 * so the result is idempotent: s(s(x)) === s(x). Pure and total — never
 * returns null, never throws.
 */
export function sanitizeMarkdown(markdown: string): string {
  let current = markdown;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = sanitizePass(current);
    if (next === current) return current;
    current = next;
  }
  return failClosed(current);
}

/**
 * Passes allowed to reach a fixed point. One pass can ASSEMBLE a live construct
 * by deleting what separated its halves (`<sc onx="y"ript>` → `<script>`), so
 * the whole pass — fence classification included — repeats until the output
 * stops changing. Benign text converges on the first repeat.
 */
const MAX_PASSES = 8;

/**
 * Reached only when MAX_PASSES did not converge, i.e. adversarial input. The
 * last iteration is NEVER returned (the next pass might still have changed
 * it); every trigger the pass reacts to is removed bluntly instead, so the
 * result is inert AND itself a fixed point (idempotence holds here too):
 * `<` is escaped (no tag, no Templater, no raw <code>), every backtick becomes
 * U+02CB ˋ (no code span, no backtick fence), the `=` after an on* name is
 * entity-encoded (that rule needs no `<` to fire), executable ~~~ fences are
 * renamed, and the link rules run once more.
 */
function failClosed(text: string): string {
  const blunt = text
    .replace(/</g, "&lt;")
    .replace(/`/g, "\u02CB")
    .replace(/(on[a-z]+\s*)=/gi, "$1&#61;");
  return neutralizeLinks(blunt.split("\n").map(renameExecutableFence).join("\n"));
}

/**
 * One full pass. Line endings are normalized to LF first: Obsidian treats a
 * lone CR or CRLF as a line break, so a `\r`-terminated ```dataviewjs line
 * is a live fence there but was invisible to a `\n`-only scan.
 *
 * Templater `<%…%>` executes JS and ignores code fences (raw find-and-replace),
 * so it must die EVERYWHERE — inside ```js/```html/```dataviewjs bodies and the
 * frontmatter too. Strip it globally before anything is preserved verbatim.
 */
function sanitizePass(markdown: string): string {
  const text = markdown.replace(/\r\n?/g, "\n").replace(TEMPLATER, TEMPLATER_REMOVED);
  const { header, body } = splitFrontmatter(text);
  return header ? sanitizeHeader(header) + sanitizeBody(body) : sanitizeBody(text);
}

/**
 * Neutralize a frontmatter block one line at a time and re-emit it with
 * exact `---` delimiters (splitFrontmatter accepts a loose `----` closer that
 * Obsidian does not). A header line that is — or becomes, once neutralized —
 * a `---` line or a fence marker is dropped: parseFrontmatter would drop it
 * anyway, and a fence line here used to flip the body scan's fence parity so
 * the whole body shipped unsanitized.
 */
function sanitizeHeader(header: string): string {
  const closedByNewline = header.endsWith("\n");
  const lines = (closedByNewline ? header.slice(0, -1) : header).split("\n");
  const inner = lines
    .slice(1, -1)
    .map(neutralizeSegment)
    .filter((line) => !line.trimStart().startsWith("---") && !isFenceLike(line));
  return ["---", ...inner, "---"].join("\n") + (closedByNewline ? "\n" : "");
}

/** Rename executable fences everywhere, then neutralize every line that is not
 * certainly inside a fenced code block, one contiguous text run at a time (so
 * multi-line constructs such as a `<script>` body are seen whole). */
function sanitizeBody(body: string): string {
  const lines = body.split("\n").map(renameExecutableFence);
  const fenced = certainlyFencedLines(lines);
  const runs: Array<{ fenced: boolean; lines: string[] }> = [];
  lines.forEach((line, i) => {
    const last = runs[runs.length - 1];
    if (last && last.fenced === fenced[i]) last.lines.push(line);
    else runs.push({ fenced: fenced[i], lines: [line] });
  });
  return runs
    .map((run) => (run.fenced ? run.lines.join("\n") : neutralizeSegment(run.lines.join("\n"))))
    .join("\n");
}

/** Everything that neutralizes a non-code text segment. */
function neutralizeSegment(text: string): string {
  return makeInlineQueriesInert(neutralizeText(text));
}

/**
 * Neutralize executable patterns in a NON-code text segment. Order matters:
 * multi-line constructs (templater, script/iframe bodies) are collapsed before
 * attribute- and link-level rewrites.
 */
function neutralizeText(text: string): string {
  let s = text;

  // Templater — executes JS. `<%= tp.date.now() %>`, `<% … %>`.
  s = s.replace(TEMPLATER, TEMPLATER_REMOVED);

  // <script>…</script> and a lone/unclosed opening tag.
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "[script removed]");
  s = s.replace(/<script\b[^>]*>/gi, "[script removed]");

  // <iframe>…</iframe> and a lone/unclosed opening tag.
  s = s.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "[iframe removed]");
  s = s.replace(/<iframe\b[^>]*>/gi, "[iframe removed]");

  // on*= inline event-handler attributes (onclick=, onload=, …). Strip the
  // whole attribute, quoted or bare, leaving the surrounding tag inert. The
  // leading delimiter is whitespace, `/` (`<svg/onload=…>`) or the closing
  // quote of the previous attribute (`src="x"onerror=…`, no space at all). A
  // quote delimiter is kept so the previous attribute stays balanced.
  s = s.replace(/([\s/"'])on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (_attr, delim: string) =>
    delim === '"' || delim === "'" ? delim : "",
  );

  // Raw HTML <code> element: Dataview evaluates EVERY rendered <code> whose
  // text starts with `=` / `$=`, not only markdown code spans. Escape the tag
  // opener rather than inspecting the content — entities (`&#61;`) and nested
  // tags defeat any content check. Markdown spans: makeInlineQueriesInert.
  s = s.replace(/<code\b/gi, "&lt;code");

  return neutralizeLinks(s);
}

/**
 * Link-target rewrites. Each only REPLACES a scheme with `#` (never deletes),
 * so it cannot assemble a new construct and applying it twice is a no-op.
 */
function neutralizeLinks(text: string): string {
  // javascript: targets in ANY markdown link/image → replace the scheme so the
  // target becomes inert while keeping paren balance (`](javascript:x)` →
  // `](#x)`). Also covers a raw href="javascript:…".
  const noJs = text
    .replace(/(\]\(\s*)javascript:/gi, "$1#")
    .replace(/(\bhref\s*=\s*["']?)javascript:/gi, "$1#");

  // data: targets in NON-image links only. `[text](data:…)` → neutralized. The
  // image exception is MIME-GATED: only `![alt](data:image/…)` (a genuine inline
  // image — #60) is left untouched. A `data:text/html` (or any non-image mime)
  // disguised with a leading `!` is NOT a safe image and is neutralized too.
  return noJs.replace(
    /(!?)(\[[^\]]*\]\(\s*)data:(image\/)?/gi,
    (full, bang: string, mid: string, image: string | undefined) =>
      bang && image ? full : `${bang}${mid}#`,
  );
}

// ── Normalize frontmatter ─────────────────────────────────────────────────────

/**
 * Validate + canonicalize the frontmatter of a (already-sanitized) note.
 * Returns the note with frontmatter re-serialized in canonical key order —
 * non-canonical keys dropped (see CANONICAL_ORDER) — or
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

  const block = ordered
    .map(([key, value]) => (value ? `${key}: ${value}` : `${key}:`))
    .join("\n");
  return `---\n${block}\n---\n${body}`;
}

/** A column-0 `key:` line for exactly this key (YAML needs space or EOL after the colon). */
function isKeyLine(line: string, key: string): boolean {
  return line.startsWith(`${key}:`) && /^(\s|$)/.test(line.slice(key.length + 1));
}

/**
 * Keep only `allowed` keys' lines. Deny by default at column 0: a canonical
 * `key:` line opens a kept group; ANY other column-0 line — another key, a
 * quoted `"dg-publish":` or explicit `? key` / `: value` form, a comment, a
 * flow mapping — closes it and is dropped. Indented and `- ` item lines
 * follow the group above them.
 */
function keepAllowedKeyLines(inner: readonly string[], allowed: readonly string[]): string[] {
  const kept: string[] = [];
  let keeping = false;
  for (const line of inner) {
    const continuation = /^\s/.test(line) || line === "" || line === "-" || line.startsWith("- ");
    if (!continuation) keeping = allowed.some((key) => isKeyLine(line, key));
    if (keeping) kept.push(line);
  }
  return kept;
}

/**
 * Drop every frontmatter key a note of this type does not own (B3 decision 1),
 * together with its continuation lines, and re-emit exact `---` delimiters.
 * Unlike normalizeFrontmatter this never rejects and never reorders, so it is
 * the allowlist for executeChat's fallback branch, where normalization
 * failed. A note without frontmatter is returned unchanged.
 */
export function filterFrontmatterKeys(markdown: string, noteType: NoteType): string {
  const { header, body } = splitFrontmatter(markdown);
  if (!header) return markdown;
  const closedByNewline = header.endsWith("\n");
  const lines = (closedByNewline ? header.slice(0, -1) : header).split("\n");
  const kept = keepAllowedKeyLines(lines.slice(1, -1), CANONICAL_ORDER[noteType]);
  return ["---", ...kept, "---"].join("\n") + (closedByNewline ? "\n" : "") + body;
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
