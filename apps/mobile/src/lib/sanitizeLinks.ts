/**
 * Link-target neutralization for the B3 sanitizer (enrichSanitize.ts).
 *
 * A `javascript:` target anywhere, and a `data:` target in any non-image
 * context, have their scheme replaced with `#`: `](javascript:x)` →
 * `](#x)`. Paren balance is kept and nothing is deleted. The only `data:`
 * target kept is a genuine inline image, `![alt](data:image/…)` (#60).
 *
 * Every place a destination can start is checked: after `](`, after a
 * reference definition's `]:`, inside an autolink `<…>`, and after a raw
 * `href=`. A leading `<` (angle destination) is skipped, and the scheme is
 * read the way a renderer and a browser would: HTML entities decoded, with
 * any number of leading zeros (`jav&#97;script&colon;`, `&#0000106;`),
 * backslash-escaped punctuation decoded (`javascript\:`, CommonMark), leading
 * spaces/C0 and any tab/newline dropped with no length limit (the URL parser
 * has none), and case folded.
 *
 * Pure, total and linear: one pass of a bounded candidate regex. A scheme
 * check stops at the first decoded character that cannot continue
 * `javascript:` / `data:`, and the padding it skips cannot contain another
 * candidate, so no text is scanned twice. The image check reads a fixed
 * window.
 */

/** Where a destination can start; the match ends right before it. */
const DESTINATION_START = /\]\(\s*|^ {0,3}\[[^\]\n]{1,999}\]:[ \t]*\n?[ \t]*|\bhref\s*=\s*["']?|</gim;

/** An entity that can spell part of a scheme, at lastIndex (CommonMark needs
 * the `;`, a browser decoding an attribute does not; browsers accept any
 * number of leading zeros). */
const ENTITY = /&(?:#0*([0-9]{1,7});?|#[xX]0*([0-9a-fA-F]{1,6});?|(colon|tab|newline);)/iy;

const NAMED: Readonly<Record<string, string>> = { colon: ":", tab: "\t", newline: "\n" };

/** ASCII punctuation, which a CommonMark backslash escapes. */
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;

/** Longest link text searched backwards for the `![` of an inline image. */
const ALT_TEXT_WINDOW = 1000;

function decodeEntity(match: RegExpExecArray): string {
  const [, decimal, hex, named] = match;
  if (named) return NAMED[named.toLowerCase()] ?? "";
  const code = decimal ? parseInt(decimal, 10) : parseInt(hex, 16);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
}

/** The character spelled at `i` and the raw length that spells it. */
function charAt(text: string, i: number): [string, number] {
  if (text[i] === "&") {
    ENTITY.lastIndex = i;
    const entity = ENTITY.exec(text);
    if (entity) return [decodeEntity(entity), entity[0].length];
  }
  if (text[i] === "\\" && i + 1 < text.length && ASCII_PUNCTUATION.test(text[i + 1])) {
    return [text[i + 1], 2];
  }
  return [text[i], 1];
}

/** The dangerous scheme spelled at `at`, and the raw index just past its `:`. */
function schemeAt(text: string, at: number): { scheme: string; end: number } | null {
  let decoded = "";
  let i = at;
  while (i < text.length) {
    const [ch, width] = charAt(text, i);
    i += width;
    // Browsers drop tab/newline anywhere in a URL and C0/space before it.
    if (/^[\t\n\r]$/.test(ch) || (decoded === "" && /^[\x00-\x20]$/.test(ch))) continue;
    decoded += ch.toLowerCase();
    if (decoded === "javascript:" || decoded === "data:") return { scheme: decoded, end: i };
    if (!"javascript:".startsWith(decoded) && !"data:".startsWith(decoded)) return null;
  }
  return null;
}

/** Does the link text closing at `close` (a `]`) open with `![`? */
function isImageText(text: string, close: number): boolean {
  let depth = 0;
  for (let i = close - 1; i >= 0 && close - i <= ALT_TEXT_WINDOW; i--) {
    if (text[i] === "]") depth++;
    else if (text[i] === "[" && depth > 0) depth--;
    else if (text[i] === "[") return text[i - 1] === "!";
  }
  return false;
}

/** The raw range to replace with `#` for one candidate, or null to keep it. */
function neutralizedRange(text: string, start: number, candidate: string): [number, number] | null {
  const at = text[start] === "<" && candidate !== "<" ? start + 1 : start;
  const found = schemeAt(text, at);
  if (!found) return null;
  if (found.scheme === "javascript:") return [at, found.end];
  const image = /^image\//i.test(text.slice(found.end, found.end + 6));
  const inlineImage = image && candidate.startsWith("](") && isImageText(text, start - candidate.length);
  return inlineImage ? null : [at, image ? found.end + 6 : found.end];
}

/** Replace every dangerous link scheme with `#`. Idempotent. */
export function neutralizeLinkTargets(text: string): string {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(DESTINATION_START)) {
    const range = neutralizedRange(text, (match.index ?? 0) + match[0].length, match[0]);
    // `](<` also matches as a bare `<` candidate one char later: same range.
    const lastEnd = ranges.length > 0 ? ranges[ranges.length - 1][1] : 0;
    if (range && range[0] >= lastEnd) ranges.push(range);
  }
  if (ranges.length === 0) return text;
  const pieces = ranges.map(([from], i) => text.slice(i === 0 ? 0 : ranges[i - 1][1], from));
  return `${pieces.join("#")}#${text.slice(ranges[ranges.length - 1][1])}`;
}
