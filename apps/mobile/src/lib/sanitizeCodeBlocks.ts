/**
 * Code blocks that Dataview would run as queries, for the B3 sanitizer
 * (enrichSanitize.ts). Dataview's default `inlineQueriesInCodeblocks: true`
 * evaluates a whole rendered code block (`<pre><code>`) whose text, trimmed,
 * starts with `=` (DQL) or `$=` (DataviewJS, when enabled). Human decision
 * 2026-09-30: such a block gets the inert marker on its FIRST content line
 * only (`= x` → `inert: = x`); every other code block stays byte-identical.
 *
 * Which lines form a block depends on the parse, so a block found by ANY of
 * these readings counts: column-0 fences with a CommonMark or a lenient
 * closer, fences behind any `>` / list-marker / indent prefix, and indented
 * code blocks (≥4 columns after a blank line). Pure and total.
 */

import { certainOpener, closesFence, containerFence, type Fence } from "./sanitizeFences";
import { INERT_MARKER } from "./sanitizeInlineCode";

/** Container prefix (whitespace, `>`), then a Dataview query prefix. */
const QUERY_LINE = /^((?:\s|>)*)(?=\$?=)/;

/** Whitespace and `>` quoting before a line's content. */
const CONTAINER_PREFIX = /^(?:\s|>)*/;

interface BlockReading {
  open: (line: string) => Fence | null;
  close: (line: string, fence: Fence) => boolean;
}

/** A fence behind any prefix is closed by a bare marker behind any prefix. */
function containerCloses(line: string, fence: Fence): boolean {
  const found = containerFence(line);
  return found !== null && found.info.trim() === "" && found.fence.char === fence.char && found.fence.len >= fence.len;
}

const READINGS: readonly BlockReading[] = [
  { open: certainOpener, close: (line, fence) => closesFence(line, fence, false) },
  { open: certainOpener, close: (line, fence) => closesFence(line, fence, true) },
  { open: (line) => containerFence(line)?.fence ?? null, close: containerCloses },
];

/** [opener, end) line spans of the fenced blocks one reading finds. */
function fenceSpans(lines: readonly string[], reading: BlockReading): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let openAt = -1;
  let fence: Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (fence === null) {
      fence = reading.open(lines[i]);
      openAt = i;
    } else if (reading.close(lines[i], fence)) {
      spans.push([openAt, i]);
      fence = null;
    }
  }
  if (fence !== null) spans.push([openAt, lines.length]);
  return spans;
}

function isBlank(line: string): boolean {
  return line.replace(CONTAINER_PREFIX, "") === "";
}

/** Columns of leading whitespace (a tab counts as 4). */
function indentColumns(text: string): number {
  const lead = /^[ \t]*/.exec(text)?.[0] ?? "";
  return [...lead].reduce((cols, ch) => cols + (ch === "\t" ? 4 : 1), 0);
}

/** A line an indented code block may follow directly: not paragraph text. */
const NON_PARAGRAPH = /^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-*_=][ \t]*){3,}$)/;

/** First line of an indented code block (not inside any fence): ≥4 columns
 * after any `>`, following a blank line, a heading, a rule or a fence line
 * (an indented line after paragraph text is a lazy continuation instead). */
function startsIndentedCode(lines: readonly string[], i: number): boolean {
  const rest = lines[i].replace(/^(?:[ \t]*>)*/, "");
  if (indentColumns(rest) < 4 || isBlank(rest)) return false;
  if (i === 0 || isBlank(lines[i - 1])) return true;
  const prev = lines[i - 1].replace(/^(?:[ \t]*>)*/, "");
  return NON_PARAGRAPH.test(prev) || containerFence(lines[i - 1]) !== null;
}

/** Lines that open a code block's content under some reading. */
function firstContentLines(lines: readonly string[]): Set<number> {
  const firsts = new Set<number>();
  const fenced = lines.map(() => false);
  for (const reading of READINGS) {
    for (const [open, end] of fenceSpans(lines, reading)) {
      fenced.fill(true, open, Math.min(end + 1, lines.length));
      for (let i = open + 1; i < end; i++) {
        if (isBlank(lines[i])) continue;
        firsts.add(i);
        break;
      }
    }
  }
  lines.forEach((_, i) => {
    if (!fenced[i] && startsIndentedCode(lines, i)) firsts.add(i);
  });
  return firsts;
}

/** Insert the inert marker at the first content line of every code block
 * whose text, trimmed, starts with `=` or `$=`. */
export function makeCodeBlockQueriesInert(lines: readonly string[]): string[] {
  if (!lines.some((line) => QUERY_LINE.test(line))) return [...lines];
  const firsts = firstContentLines(lines);
  return lines.map((line, i) =>
    firsts.has(i) && QUERY_LINE.test(line) ? line.replace(QUERY_LINE, `$1${INERT_MARKER}`) : line,
  );
}
