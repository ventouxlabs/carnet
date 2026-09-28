/**
 * Deterministic YAML frontmatter subsystem for carnet.
 *
 * carnet's on-disk source of truth is plain markdown with an Obsidian-style
 * `---` frontmatter block. The block is normally authored by the enrichment
 * LLM (see prompts.ts), but the app needs to inject user-entered metadata
 * (location, tags) into the returned markdown *deterministically* — the LLM
 * cannot be trusted to honour injected values. This module is that
 * deterministic layer.
 *
 * Design constraints:
 *  - NO YAML library (the app ships none; this stays hand-rolled + tiny).
 *  - PURE: this file imports nothing native, so it is unit-testable in plain
 *    Node with zero mocking. Keep it that way — do not import writer/settings/
 *    expo-* here.
 *  - BYTE-PRESERVING where possible: a body-only or single-field edit must not
 *    disturb the rest of the document (the #1 WYSIWYG corruption mode is the
 *    frontmatter block collapsing).
 *
 * The scalar/byte-exact helpers (extractFrontmatterField, stripFrontmatter,
 * splitFrontmatter, rewriteFrontmatterField) were lifted verbatim from
 * writer.ts, which now re-exports them so existing importers are unaffected.
 */

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Strip a single layer of surrounding single/double quotes from a value. */
function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

/** Stable de-duplication preserving first-occurrence order. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Return the lines strictly *between* the opening and closing `---` fences of a
 * header produced by splitFrontmatter. Returns `[]` when there is no block.
 */
function frontmatterInnerLines(header: string): string[] {
  if (!header) return [];
  const lines = header.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return [];
  return lines.slice(1, closeIdx);
}

/** True when `line` is the top-level (or indented) `field:` key line. */
function lineKeyIs(line: string, field: string): boolean {
  return line.trimStart().startsWith(`${field}:`);
}

/**
 * True when `line` is a continuation of the field whose key sits at
 * `baseIndent` columns — i.e. a more-indented line (folded scalar / nested) or
 * a YAML list item (`- x`) at the key's own indent. Used to sweep away the old
 * value's block-list lines when a field is upserted to an inline value.
 */
function isContinuation(line: string, baseIndent: number): boolean {
  if (line.trim() === "") return false;
  const indent = line.length - line.trimStart().length;
  if (indent > baseIndent) return true;
  if (indent === baseIndent && /^-(\s|$)/.test(line.trimStart())) return true;
  return false;
}

/** Parse an inline YAML flow array `[a, b, c]` into trimmed, unquoted tokens. */
function parseFlowArray(text: string): string[] {
  const inside = text.replace(/^\[/, "").replace(/\].*$/, "");
  if (inside.trim() === "") return [];
  return inside
    .split(",")
    .map((token) => stripQuotes(token.trim()))
    .filter((token) => token.length > 0);
}

// ── Byte-exact scalar helpers (moved from writer.ts; re-exported there) ───────

/** Extract a YAML frontmatter field value. Exported so screens (e.g.
 * RecentDetail's retro-enrich gate) can route off the `kind:` field. */
export function extractFrontmatterField(markdown: string, field: string): string | null {
  const s = markdown.trimStart();
  if (!s.startsWith("---")) return null;
  const afterFirst = s.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return null;
  const block = afterFirst.slice(0, endIdx);
  const prefix = `${field}:`;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim().replace(/^['"]|['"]$/g, "");
      if (value) return value;
    }
  }
  return null;
}

/** Strip frontmatter block, returning only the body. Exported so screens
 * that preview a saved note can render the body without the YAML noise. */
export function stripFrontmatter(markdown: string): string {
  const s = markdown.trimStart();
  if (!s.startsWith("---")) return markdown;
  const afterFirst = s.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return markdown;
  return afterFirst.slice(endIdx + 4).replace(/^\n+/, "");
}

/**
 * Split a note into its raw YAML frontmatter header and its body, such that
 * `header + body === markdown` BYTE-FOR-BYTE. Unlike stripFrontmatter (which
 * trims), this preserves the header verbatim so it can be re-prepended exactly
 * after a body-only edit — the #1 documented WYSIWYG corruption mode is the
 * frontmatter block collapsing, so the editor must never see or rewrite it.
 *
 * The header includes the closing `---` line AND its trailing newline, so
 * `header + editedBody` can never merge the closing fence into the body even if
 * the editor drops the blank line that followed it. A note with no valid
 * frontmatter returns `{ header: "", body: markdown }`.
 */
export function splitFrontmatter(markdown: string): { header: string; body: string } {
  if (!markdown.startsWith("---")) return { header: "", body: markdown };
  const afterFirst = markdown.slice(3);
  const endIdx = afterFirst.indexOf("\n---");
  if (endIdx === -1) return { header: "", body: markdown };
  // Index (in afterFirst) of the closing fence's own line; advance past "---"
  // then to the end of that line (its trailing newline, or end of string).
  const closeFenceStart = endIdx + 1;
  const nlAfterClose = afterFirst.indexOf("\n", closeFenceStart + 3);
  const splitAt = 3 + (nlAfterClose === -1 ? afterFirst.length : nlAfterClose + 1);
  return { header: markdown.slice(0, splitAt), body: markdown.slice(splitAt) };
}

/** Rewrite a single YAML frontmatter field, preserving the rest byte-identical.
 * Throws if the field (or the frontmatter block) is absent — use
 * upsertFrontmatterField when the field may be missing. */
export function rewriteFrontmatterField(
  content: string,
  field: string,
  newValue: string,
): string {
  if (newValue.includes("\n") || newValue.includes("\r")) {
    throw new Error("frontmatter values cannot contain newlines or carriage returns");
  }
  const s = content.trimStart();
  if (!s.startsWith("---")) {
    throw new Error("file has no YAML frontmatter");
  }
  const afterFirst = s.slice(3);

  // Line-aware scan for closing --- to avoid mis-cutting on body horizontal rules.
  let blockEnd: number | null = null;
  let offset = 0;
  for (const line of afterFirst.split("\n")) {
    if (line.trim() === "---") {
      blockEnd = offset;
      break;
    }
    offset += line.length + 1; // +1 for the \n
  }
  if (blockEnd === null) {
    throw new Error("unterminated frontmatter block");
  }
  const block = afterFirst.slice(0, blockEnd);
  const body = afterFirst.slice(blockEnd);

  const prefix = `${field}:`;
  let found = false;
  const newBlock = block
    .split("\n")
    .map((line) => {
      if (!found && line.trimStart().startsWith(prefix)) {
        found = true;
        const leadingWs = line.slice(0, line.length - line.trimStart().length);
        return `${leadingWs}${prefix} ${newValue}`;
      }
      return line;
    })
    .join("\n");

  if (!found) {
    throw new Error(`field \`${field}\` not present in frontmatter`);
  }
  return `---${newBlock}${body}`;
}

// ── Generalized parse / upsert / tags API ─────────────────────────────────────

/**
 * Parse the `---` block into ordered top-level `[key, value]` pairs, where
 * `value` is the inline text after `key:` (trimmed; surrounding quotes kept).
 *
 * Block-list continuation lines (`  - item`) are NOT represented as their own
 * entries — a block `tags:` field yields `["tags", ""]`. Use getFrontmatterTags
 * to read arrays in either flow or block form.
 */
export function parseFrontmatter(
  markdown: string,
): { fields: Array<[string, string]>; hasBlock: boolean } {
  const { header } = splitFrontmatter(markdown);
  if (!header) return { fields: [], hasBlock: false };
  const fields: Array<[string, string]> = [];
  for (const line of frontmatterInnerLines(header)) {
    const match = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (match) {
      fields.push([match[1], match[2].trim()]);
    }
  }
  return { fields, hasBlock: true };
}

/**
 * Upsert a SCALAR field: rewrite it in place if present, else INSERT it just
 * before the closing `---`. When the note has no frontmatter at all, a fresh
 * `---\n{field}: {value}\n---\n` block is synthesized at the head.
 *
 * Fills the gap rewriteFrontmatterField leaves (it throws when the field is
 * absent). When rewriting a field that held a block list, the old list items
 * are swept away so no orphan `- item` lines survive.
 */
export function upsertFrontmatterField(
  markdown: string,
  field: string,
  value: string,
): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("frontmatter values cannot contain newlines or carriage returns");
  }
  const { header, body } = splitFrontmatter(markdown);
  if (!header) {
    return `---\n${field}: ${value}\n---\n${markdown}`;
  }

  const lines = header.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  const inner = lines.slice(1, closeIdx);
  const tail = lines.slice(closeIdx); // closing fence + any trailing "" from the newline

  const newInner: string[] = [];
  let found = false;
  for (let i = 0; i < inner.length; i++) {
    const line = inner[i];
    if (!found && lineKeyIs(line, field)) {
      found = true;
      const leadingWs = line.slice(0, line.length - line.trimStart().length);
      newInner.push(`${leadingWs}${field}: ${value}`);
      // Drop the old value's block-list / folded continuation lines.
      while (i + 1 < inner.length && isContinuation(inner[i + 1], leadingWs.length)) {
        i++;
      }
    } else {
      newInner.push(line);
    }
  }
  if (!found) {
    newInner.push(`${field}: ${value}`);
  }

  return [lines[0], ...newInner, ...tail].join("\n") + body;
}

/** One top-level frontmatter key with its raw source lines: the `key:` line
 * plus any block-list / folded continuation lines beneath it. Lines that belong
 * to no key (a leading comment, a stray blank) carry `key: null`. */
interface FieldGroup {
  key: string | null;
  lines: string[];
}

/**
 * A top-level key line: something other than whitespace, `#` or `-` in column
 * 0, then everything up to the first colon, which must end the line or be
 * followed by whitespace.
 *
 * Deliberately NOT restricted to an identifier charset. Obsidian's Properties
 * UI lets a user name a property anything — `date created:`, `Read status:`,
 * `pdf.page:` are all ordinary — and an identifier-only pattern silently folds
 * those lines into the PRECEDING group, where they are dropped the moment that
 * group isn't spliced through. Data loss in the function whose whole job is to
 * prevent it.
 */
const KEY_LINE = /^([^\s#-][^:]*):(\s|$)/;

/** Split a frontmatter block's inner lines into per-key groups, keeping every
 * line byte-exact so a group can be re-emitted verbatim. */
function groupFrontmatterLines(inner: string[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  for (const line of inner) {
    // Anchored at column 0, so only top-level keys start a new group;
    // indented lines and `- item` list entries fall through to the previous.
    const match = KEY_LINE.exec(line);
    if (match) {
      groups.push({ key: match[1], lines: [line] });
    } else if (groups.length > 0) {
      groups[groups.length - 1].lines.push(line);
    } else {
      groups.push({ key: null, lines: [line] });
    }
  }
  return groups;
}

/** True when a group carries an actual value — an inline scalar, or block-list
 * items beneath a bare key. A bare `key:` and the quoted-empty `key: ""` that
 * buildPersonPrompt emits for an unreadable field both count as EMPTY. */
function groupHasValue(group: FieldGroup): boolean {
  if (group.lines.slice(1).some((line) => line.trim() !== "")) return true;
  const head = group.lines[0];
  return stripQuotes(head.slice(head.indexOf(":") + 1).trim()) !== "";
}

/**
 * Overlay `original`'s frontmatter fields onto `enriched` for every field the
 * enriched markdown does not itself provide — preserve-if-absent, model wins.
 *
 * Re-enrichment replaces the whole note with the model's output, and the model
 * knows nothing about fields the user added by hand (a Person note's `email`,
 * `phone`, `company`, …). Restoring them one named field at a time is the
 * allowlist this replaces: every new field a note can carry has had to be added
 * to that list after it was already silently dropped from someone's vault.
 *
 * "Provides" means a NON-EMPTY value, so the `email: ""` placeholder the person
 * prompt emits for an unreadable card field cannot blank out the address the
 * user typed in themselves.
 *
 * Preserved fields are SPLICED as their original source lines, byte-for-byte —
 * not parsed to a value and re-serialized. Re-serializing round-trips through a
 * lossy representation: reading strips quotes and writing emits bare, so
 * `note: "Met at 3: the cafe"` would come back as an unescaped `: ` mid-value
 * and `quip: "#1 fan"` as a comment — and an invalid line fails the WHOLE
 * frontmatter block in Obsidian, emptying the note's entire Properties pane.
 * Splicing also carries block-form values (`aliases:` + `- item` lines, which
 * Obsidian writes by default) across intact.
 *
 * Key names are read loosely on purpose — Obsidian property names may contain
 * spaces and dots (`date created:`, `Read status:`) — see KEY_LINE.
 *
 * Known limitation: a block-form field present-but-EMPTY in `enriched` is
 * replaced by the original's whole group, and a field's position within the
 * block is not preserved when it has to be appended. Neither loses data. A
 * malformed `enriched` block (no exact `---` closing line) is returned
 * unchanged rather than spliced.
 *
 * `exclude` is for fields another step owns outright — `tags` (mergeUserTags)
 * and the raw note's own bookkeeping. Callers must pass them: this function
 * cannot tell an owned field from a user's.
 */
export function preserveFrontmatterFields(
  enriched: string,
  original: string,
  exclude: readonly string[] = [],
): string {
  const excluded = new Set(exclude);
  const carried = new Map<string, string[]>();
  for (const group of groupFrontmatterLines(frontmatterInnerLines(splitFrontmatter(original).header))) {
    if (group.key === null || excluded.has(group.key) || carried.has(group.key)) continue;
    // A CRLF-sourced note would otherwise splice stray carriage returns into an
    // LF document; every other writer here emits LF.
    if (groupHasValue(group)) carried.set(group.key, group.lines.map((l) => l.replace(/\r$/, "")));
  }
  if (carried.size === 0) return enriched;

  const { header, body } = splitFrontmatter(enriched);
  if (!header) {
    return `---\n${[...carried.values()].flat().join("\n")}\n---\n${enriched}`;
  }
  const headerLines = header.split("\n");
  const closeIdx = headerLines.findIndex((line, i) => i > 0 && line.trim() === "---");
  // splitFrontmatter accepts a `----` fence that this exact-match scan rejects.
  // With no closing line to splice before, the carried fields would land in the
  // body as stray prose — leave the malformed block alone instead.
  if (closeIdx === -1) return enriched;
  const inner = headerLines.slice(1, closeIdx);
  const tail = headerLines.slice(closeIdx);

  const newInner: string[] = [];
  /** Keys whose empty line in the model's output we filled from `original`. */
  const filled = new Set<string>();
  for (const group of groupFrontmatterLines(inner)) {
    if (group.key === null) {
      newInner.push(...group.lines);
      continue;
    }
    const replacement = carried.get(group.key);
    if (groupHasValue(group)) {
      newInner.push(...group.lines);
    } else if (filled.has(group.key)) {
      // The model emitted this key twice and the first copy already took the
      // carried value; keeping this one leaves a duplicate empty key behind.
      // Untouched when we filled nothing — deduping the model's own output is
      // not this function's business.
      continue;
    } else if (replacement) {
      // Replacing the empty group in place (rather than appending the carried
      // lines) is what keeps the block free of duplicate keys.
      newInner.push(...replacement);
      filled.add(group.key);
    } else {
      newInner.push(...group.lines);
    }
    carried.delete(group.key);
  }
  newInner.push(...[...carried.values()].flat());

  return [headerLines[0], ...newInner, ...tail].join("\n") + body;
}

/**
 * Read the `tags` field, accepting both the inline flow form `tags: [a, b]`
 * and the YAML block form (`tags:` followed by indented `- item` lines). A
 * bare scalar `tags: foo` yields `["foo"]`. Values are returned as written
 * (trimmed, unquoted) — NOT normalized; normalization happens on write.
 */
export function getFrontmatterTags(markdown: string): string[] {
  const { header } = splitFrontmatter(markdown);
  if (!header) return [];
  const inner = frontmatterInnerLines(header);
  const tagsIdx = inner.findIndex((line) => /^tags:/.test(line));
  if (tagsIdx === -1) return [];

  const afterColon = inner[tagsIdx].slice("tags:".length).trim();
  if (afterColon.startsWith("[")) {
    return parseFlowArray(afterColon);
  }
  if (afterColon.length > 0) {
    return [stripQuotes(afterColon)];
  }

  // Block form: collect the following `- item` continuation lines.
  const out: string[] = [];
  for (let i = tagsIdx + 1; i < inner.length; i++) {
    const item = /^\s*-\s+(.*)$/.exec(inner[i]);
    if (item) {
      const value = stripQuotes(item[1].trim());
      if (value) out.push(value);
      continue;
    }
    if (inner[i].trim() === "") continue;
    break; // next top-level key — end of the tags block
  }
  return out;
}

/**
 * Normalize one tag token to carnet's canonical form: trimmed, lowercased,
 * leading `#` stripped, whitespace collapsed to single hyphens, restricted to
 * `[a-z0-9-]`, with repeat/edge hyphens removed. Returns "" for input that
 * normalizes to nothing (e.g. "---", "🚀").
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * True when this markdown is a saved retrospective answer (buildSynthesisNote,
 * retrospective.ts) rather than a note the user captured.
 *
 * Both now live in Notes/ (note-capture-mode PRD §4), so the folder can no
 * longer carry this meaning. buildSynthesisNote always emits BOTH
 * `tags: [synthesis]` and a `question:` field; either suffices, and
 * `question:` survives the user retagging the note in Obsidian.
 */
export function isSynthesisNote(markdown: string): boolean {
  if (extractFrontmatterField(markdown, "question") !== null) return true;
  return getFrontmatterTags(markdown).some((tag) => normalizeTag(tag) === "synthesis");
}

/**
 * Set the `tags` field to the given tags as an Obsidian-compatible inline flow
 * array `tags: [a, b, c]`, upserting the field. Each tag is normalized and the
 * list is de-duplicated (first-occurrence order). This REPLACES the field — to
 * preserve existing/LLM-emitted tags, merge first:
 *   setFrontmatterTags(md, [...getFrontmatterTags(md), ...userTags])
 */
export function setFrontmatterTags(markdown: string, tags: string[]): string {
  const normalized = dedupe(tags.map(normalizeTag).filter((tag) => tag.length > 0));
  return upsertFrontmatterField(markdown, "tags", `[${normalized.join(", ")}]`);
}
