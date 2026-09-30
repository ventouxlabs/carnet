/**
 * The note prompt's one hard rule — tidy and tag, NEVER expand — enforced in
 * code rather than trusted to the model (note-capture-mode plan Task 10,
 * decision 13).
 *
 * `keepsUserLines` compares the user's lines with a reply's body lines, and
 * `withUserLines` builds the fallback used when it fails: the reply's
 * frontmatter and title, then the user's own lines verbatim.
 *
 * A pure, dependency-free leaf on purpose: no app imports, so it unit-tests in
 * plain Node and no suite's vi.mock can reach it. The frontmatter split below
 * mirrors frontmatter.ts `splitFrontmatter` byte-for-byte for that reason.
 */

/** A list item's bullet: `-`, `*`, `+`, or CommonMark's `1.` / `1)`. */
const BULLET = String.raw`(?:[-*+]|\d{1,9}[.)])`;
/** One leading list/checkbox marker or ATX heading marker — the only
 * formatting a note reply may change on a user's line. */
const LINE_MARKER = new RegExp(String.raw`^(?:${BULLET} \[[ xX]\] |${BULLET} |#{1,6} )`);
const TODO = new RegExp(String.raw`^${BULLET} \[[ xX]\] `);
const CHECKED = new RegExp(String.raw`^${BULLET} \[[xX]\] `);
const ATX_HEADING = /^#{1,6} /;
const H1 = /^# /;
/** A fence opener, as enrichSanitize.ts FENCE_OPEN reads one. */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

interface BodyLine {
  /** The line with whitespace and one leading marker removed. */
  readonly text: string;
  /** A `- [ ]` / `- [x]` todo (or `*`, `+`, `1.` — Obsidian renders them all). */
  readonly todo: boolean;
  /** A ticked `- [x]` todo. */
  readonly checked: boolean;
  /** No marker at all: a plain line of text. */
  readonly plain: boolean;
  readonly heading: boolean;
}

/** Same contract as frontmatter.ts splitFrontmatter: header + body === markdown. */
function splitFrontmatterBlock(markdown: string): { header: string; body: string } {
  if (!markdown.startsWith("---")) return { header: "", body: markdown };
  const close = markdown.indexOf("\n---", 3);
  if (close === -1) return { header: "", body: markdown };
  const lineEnd = markdown.indexOf("\n", close + 4);
  const splitAt = lineEnd === -1 ? markdown.length : lineEnd + 1;
  return { header: markdown.slice(0, splitAt), body: markdown.slice(splitAt) };
}

function toBodyLine(line: string): BodyLine {
  const trimmed = line.trim();
  return {
    text: trimmed.replace(LINE_MARKER, ""),
    todo: TODO.test(trimmed),
    checked: CHECKED.test(trimmed),
    plain: !LINE_MARKER.test(trimmed),
    heading: ATX_HEADING.test(trimmed),
  };
}

/** Non-blank lines, normalized for comparison. */
function bodyLines(text: string): BodyLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(toBodyLine);
}

/** Whether the reply's line keeps the user's: same words and the same ticked
 * state, and a todo stays a todo. A model may turn a plain or bulleted line
 * into `- [ ]`, but never tick one, un-tick a done one, strip a checkbox
 * (which would drop an open todo out of the Todos screen), or turn the user's
 * heading into a task. Directional. */
function keepsLine(user: BodyLine, reply: BodyLine): boolean {
  return (
    user.text === reply.text &&
    user.checked === reply.checked &&
    (!user.todo || reply.todo) &&
    !(user.heading && reply.todo)
  );
}

function sameSequence(expected: readonly BodyLine[], actual: readonly BodyLine[]): boolean {
  return expected.length === actual.length && expected.every((line, i) => keepsLine(line, actual[i]));
}

/**
 * True when the reply's body is exactly the user's lines, in order, one for
 * one — allowing each line one changed leading marker (a plain or bulleted
 * line may become `- [ ]`) and allowing the reply's first ATX heading to be a
 * new title. That heading may instead stand for a user line with the same
 * text (`Weekend errands` → `# Weekend errands`); both readings are tried.
 */
export function keepsUserLines(input: string, enrichedMarkdown: string): boolean {
  const expected = bodyLines(input);
  const actual = bodyLines(splitFrontmatterBlock(enrichedMarkdown).body);
  if (sameSequence(expected, actual)) return true;
  const titleAt = actual.findIndex((line) => line.heading);
  return titleAt !== -1 && sameSequence(expected, actual.filter((_, i) => i !== titleAt));
}

function withoutLeadingBlanks(lines: readonly string[]): readonly string[] {
  const start = lines.findIndex((line) => line.trim().length > 0);
  return start === -1 ? [] : lines.slice(start);
}

/** The user's lines under the model's title — or under their own H1, which a
 * re-enriched note already has, rather than stacking a second one. The title
 * stands in for an identical first line only when that line is plain text: a
 * first-line todo or bullet is kept, never turned into the heading. */
function titledLines(title: string | undefined, userLines: readonly string[]): readonly string[] {
  if (!title || userLines.length === 0) return userLines;
  const first = toBodyLine(userLines[0]);
  if (first.plain && keepsLine(first, toBodyLine(title))) {
    return [title, "", ...withoutLeadingBlanks(userLines.slice(1))];
  }
  if (H1.test(userLines[0])) return userLines;
  return [title, "", ...userLines];
}

/** True when `line` closes a fence opened by `marker` (same character, at
 * least as long) — enrichSanitize.ts's close rule. */
function closesFence(line: string, marker: string): boolean {
  return new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(line);
}

/**
 * The reply's first H1 outside any code fence. enrichSanitize (B3) leaves a
 * fence body untouched, so a heading inside one is unsanitized model text:
 * lifting it out would make it live. Fences follow B3's own rules, including
 * an unclosed fence running to the end. Only `# ` counts — `## Shelf` is a
 * section, not a title.
 */
function fallbackTitle(body: string): string | undefined {
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) fence = open[1];
    else if (H1.test(line)) return line.trimEnd();
  }
  return undefined;
}

/** CRLF and a lone CR are line breaks too; the fallback writes LF only. */
function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The reply's frontmatter block — or an empty one when it had none, so a
 * user's own leading `---` block can never be read as the note's frontmatter
 * (dispatcher's #note merge then fills it). */
function frontmatterOf(header: string): string {
  if (!header) return "---\n---\n";
  return header.endsWith("\n") ? header : `${header}\n`;
}

/**
 * The fallback for a reply that fails keepsUserLines: the reply's frontmatter
 * block and its first H1 outside any fence, then the user's lines verbatim
 * (trimmed as a whole, as the save-first raw stub trims them). Satisfies
 * keepsUserLines. The caller re-sanitizes the result (dispatcher.enrichNote).
 */
export function withUserLines(input: string, enrichedMarkdown: string): string {
  const { header, body } = splitFrontmatterBlock(toLf(enrichedMarkdown));
  const title = fallbackTitle(body);
  const trimmed = toLf(input).trim();
  const userLines = trimmed ? trimmed.split("\n") : [];
  return `${frontmatterOf(header)}${titledLines(title, userLines).join("\n")}\n`;
}
