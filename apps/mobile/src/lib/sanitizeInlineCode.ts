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
 * line break or a pipe outside a table), on backslash escapes, and on raw
 * HTML / autolinks that start first (a backtick inside `<b title="`">` opens
 * nothing). A regex cannot pair spans, and a single tokenization can be fooled
 * by a boundary it does not see, so every text segment is tokenized
 * CommonMark-style (equal-length runs pair, left to right) under several
 * segmentations and readings, and a span live under ANY of them is made inert.
 *
 * Pure and total: no I/O, never throws.
 */

import { htmlSpanMatcher } from "./inlineHtml";

/** Inserted before a live query so it no longer starts with a prefix. */
export const INERT_MARKER = "inert: ";

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

/** Start offsets of every maximal backtick run in a segment, keyed by length. */
type RunIndex = ReadonlyMap<number, readonly number[]>;

function indexRuns(seg: string): RunIndex {
  const runs = new Map<number, number[]>();
  for (let i = seg.indexOf("`"); i !== -1; ) {
    const end = runEnd(seg, i, seg.length);
    const starts = runs.get(end - i);
    if (starts) starts.push(i);
    else runs.set(end - i, [i]);
    i = seg.indexOf("`", end);
  }
  return runs;
}

/** Start of the first maximal run of exactly `len` at or after `from`, or -1
 * (binary search, so pairing stays O(n log n) with many unmatched runs).
 * Inside a span backslashes are literal, so closers are raw maximal runs. */
function findCloser(runs: RunIndex, from: number, len: number): number {
  const starts = runs.get(len);
  if (!starts) return -1;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < starts.length ? starts[lo] : -1;
}

/** How a renderer might read one segment. The union of all readings is used. */
interface Reading {
  /** CommonMark: `\`` is a literal backtick and opens nothing. */
  honorEscapes: boolean;
  /** CommonMark: raw HTML / an autolink that starts first hides its backticks. */
  htmlAware: boolean;
}

const READINGS: readonly Reading[] = [
  { honorEscapes: true, htmlAware: true },
  { honorEscapes: true, htmlAware: false },
  { honorEscapes: false, htmlAware: true },
  { honorEscapes: false, htmlAware: false },
];

/** Offsets (into `seg`) just past each opener whose span is a live query. */
function liveOpeners(seg: string, reading: Reading, runs: RunIndex): number[] {
  const found: number[] = [];
  const htmlEnd = reading.htmlAware ? htmlSpanMatcher(seg) : null;
  let i = 0;
  while (i < seg.length) {
    if (reading.honorEscapes && seg[i] === "\\") {
      i += 2; // `\x` is a literal x, so an escaped backtick opens nothing
      continue;
    }
    const skipTo = htmlEnd && seg[i] === "<" ? htmlEnd(i) : -1;
    if (skipTo !== -1 || seg[i] !== "`") {
      i = skipTo !== -1 ? skipTo : i + 1;
      continue;
    }
    const open = runEnd(seg, i, seg.length);
    const close = findCloser(runs, open, open - i);
    if (close === -1) {
      i = open; // unmatched run: literal backticks
      continue;
    }
    if (isQuery(seg.slice(open, close))) found.push(open);
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

/** A GFM table delimiter row (`|---|:-:|`), behind any `>` quoting. */
const DELIMITER_ROW = /^[ \t]*(?:>[ \t]*)*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Flags the lines of every blank-line-separated chunk that holds a table. */
function tableLines(lines: readonly string[]): boolean[] {
  const flags = lines.map(() => false);
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && lines[i].trim() !== "") continue;
    const chunk = lines.slice(start, i);
    if (chunk.some((line) => line.includes("|") && DELIMITER_ROW.test(line))) flags.fill(true, start, i);
    start = i + 1;
  }
  return flags;
}

/** Each line — split into its `|` cells when it belongs to a GFM table, since
 * GFM splits cells before parsing spans (outside a table a pipe inside a span
 * is just text, so splitting there would invent spans). */
function cellRanges(text: string): Range[] {
  const inTable = tableLines(text.split("\n"));
  return lineRanges(text).flatMap(({ start, end }, lineIndex) => {
    if (!inTable[lineIndex]) return [{ start, end }];
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
  for (const { start, end } of segmentations.flat()) {
    const seg = text.slice(start, end);
    if (!seg.includes("`")) continue;
    const runs = indexRuns(seg);
    for (const reading of READINGS) {
      liveOpeners(seg, reading, runs).forEach((at) => positions.add(start + at));
    }
  }
  const cuts = [...positions].sort((a, b) => a - b);
  return [0, ...cuts].map((from, i) => text.slice(from, cuts[i] ?? text.length)).join(INERT_MARKER);
}
