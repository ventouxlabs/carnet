/**
 * Inline Dataview queries for the B3 sanitizer (enrichSanitize.ts).
 *
 * Dataview evaluates every rendered `<code>` element whose `innerText.trim()`
 * starts with its query prefix — `=` (DQL) or `$=` (DataviewJS) by default.
 * Custom prefixes from `.obsidian/plugins/dataview/data.json` are NOT covered
 * (deferred, TODO.md). A live span is made INERT, not deleted (decision 2 of
 * the B3 hardening plan): `inert: ` is inserted right after the opening
 * backtick run, so `` `= this.file.name` `` becomes
 * `` `inert: = this.file.name` `` — content kept and visible, clearly marked,
 * and no longer starting with a prefix. The marker holds no backtick, pipe,
 * backslash or newline, so pairing is unchanged and a second pass is a no-op.
 *
 * Which backtick runs pair into a span depends on block structure (a span
 * never crosses a blank line, heading or table cell, but does cross a soft
 * line break) and on backslash escapes. A regex cannot pair spans, and a
 * single tokenization can be fooled by a boundary it does not see, so every
 * text segment is tokenized CommonMark-style (equal-length runs pair, left to
 * right) under several segmentations and both escape readings, and a span
 * that is live under ANY of them is made inert.
 *
 * Pure and total: no I/O, never throws.
 */

const INERT_MARKER = "inert: ";

interface Range {
  start: number;
  end: number;
}

/** True when a span's content would run as a Dataview inline query. */
function isQuery(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("=") || trimmed.startsWith("$=");
}

function runEnd(text: string, from: number, end: number): number {
  let i = from;
  while (i < end && text[i] === "`") i++;
  return i;
}

/** Start of the first later backtick run of exactly `len`, or -1. Inside a
 * span backslashes are literal, so no escape handling here. */
function findCloser(text: string, from: number, end: number, len: number): number {
  let i = from;
  while (i < end) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const after = runEnd(text, i, end);
    if (after - i === len) return i;
    i = after;
  }
  return -1;
}

/** Offsets just past each opener whose span is a live query, within a range. */
function liveOpeners(text: string, range: Range, honorEscapes: boolean): number[] {
  const found: number[] = [];
  let i = range.start;
  while (i < range.end) {
    if (honorEscapes && text[i] === "\\") {
      i += 2; // `\x` is a literal x, so an escaped backtick opens nothing
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const open = runEnd(text, i, range.end);
    const close = findCloser(text, open, range.end, open - i);
    if (close === -1) {
      i = open; // unmatched run: literal backticks
      continue;
    }
    if (isQuery(text.slice(open, close))) found.push(open);
    i = close + (open - i);
  }
  return found;
}

function lineRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    ranges.push({ start, end: start + line.length });
    start += line.length + 1;
  }
  return ranges;
}

/** Depth of `>` quoting and the text after it. */
function unquote(line: string): { depth: number; rest: string } {
  const match = /^(?:[ \t]*>)*/.exec(line)?.[0] ?? "";
  return { depth: (match.match(/>/g) ?? []).length, rest: line.slice(match.length) };
}

/** A line that can begin a new block and so end the paragraph before it. */
const BLOCK_START =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:[-*_=][ \t]*){3,}$|\||<|`{3}|~{3}|\$\$|%%)/;

/** A block that is always one line long, so the next line starts a new one. */
const ONE_LINE_BLOCK = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*_=][ \t]*){3,}$|\|)/;

function startsNewBlock(prev: string, line: string): boolean {
  const before = unquote(prev);
  const here = unquote(line);
  return here.depth > before.depth || BLOCK_START.test(here.rest) || ONE_LINE_BLOCK.test(before.rest);
}

/** Group consecutive non-blank lines, starting a new group where `split` says. */
function groupLines(text: string, split: (prev: string, line: string) => boolean): Range[] {
  const lines = text.split("\n");
  const groups: Range[] = [];
  lineRanges(text).forEach((range, i) => {
    const blank = lines[i].trim() === "";
    const last = groups[groups.length - 1];
    const joins = i > 0 && !blank && lines[i - 1].trim() !== "" && !split(lines[i - 1], lines[i]);
    if (blank) return;
    if (joins && last) last.end = range.end;
    else groups.push({ ...range });
  });
  return groups;
}

/** Each line, and each `|`-separated cell of it (GFM splits cells first). */
function cellRanges(text: string): Range[] {
  return lineRanges(text).flatMap(({ start, end }) => {
    const cells: Range[] = [];
    let from = start;
    for (let i = start; i <= end; i++) {
      if (i === end || text[i] === "|") {
        cells.push({ start: from, end: i });
        from = i + 1;
      }
    }
    return cells;
  });
}

/** Insert the inert marker before every live span's content. */
export function makeInlineQueriesInert(text: string): string {
  if (!text.includes("`")) return text;
  const segmentations = [groupLines(text, () => false), groupLines(text, startsNewBlock), cellRanges(text)];
  const positions = new Set<number>();
  for (const range of segmentations.flat()) {
    for (const honorEscapes of [true, false]) {
      liveOpeners(text, range, honorEscapes).forEach((at) => positions.add(at));
    }
  }
  const cuts = [...positions].sort((a, b) => a - b);
  return [0, ...cuts].map((from, i) => text.slice(from, cuts[i] ?? text.length)).join(INERT_MARKER);
}
