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

/** One leading list/checkbox marker or ATX heading marker — the only
 * formatting a note reply may change on a user's line. */
const LINE_MARKER = /^(?:- \[[ xX]\] |[-*+] |#{1,6} )/;
const CHECKED = /^- \[[xX]\] /;
const ATX_HEADING = /^#{1,6} /;
const H1 = /^# /;

interface BodyLine {
  /** The line with whitespace and one leading marker removed. */
  readonly text: string;
  /** A ticked `- [x]` todo. */
  readonly checked: boolean;
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
    checked: CHECKED.test(trimmed),
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

/** Same words, and the same ticked state: a model may turn a line into a
 * `- [ ]` todo, but never tick one or un-tick a done one. */
function sameLine(a: BodyLine, b: BodyLine): boolean {
  return a.text === b.text && a.checked === b.checked;
}

function sameSequence(expected: readonly BodyLine[], actual: readonly BodyLine[]): boolean {
  return expected.length === actual.length && expected.every((line, i) => sameLine(line, actual[i]));
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
 * re-enriched note already has, rather than stacking a second one. */
function titledLines(title: string | undefined, userLines: readonly string[]): readonly string[] {
  if (!title || userLines.length === 0) return userLines;
  const first = userLines[0];
  if (sameLine(toBodyLine(first), toBodyLine(title))) {
    return [title, "", ...withoutLeadingBlanks(userLines.slice(1))];
  }
  if (H1.test(first)) return userLines;
  return [title, "", ...userLines];
}

/**
 * The fallback for a reply that fails keepsUserLines: the reply's frontmatter
 * block and first ATX heading, then the user's lines verbatim (trimmed as a
 * whole, as the save-first raw stub trims them). Satisfies keepsUserLines.
 */
export function withUserLines(input: string, enrichedMarkdown: string): string {
  const { header, body } = splitFrontmatterBlock(enrichedMarkdown);
  const head = header && !header.endsWith("\n") ? `${header}\n` : header;
  const title = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => ATX_HEADING.test(line));
  const trimmed = input.trim();
  const userLines = trimmed ? trimmed.split("\n") : [];
  return `${head}${titledLines(title, userLines).join("\n")}\n`;
}
