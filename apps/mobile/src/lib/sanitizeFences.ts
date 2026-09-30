/**
 * Fence handling for the B3 sanitizer (enrichSanitize.ts). Two jobs:
 *
 *  1. RENAME executable fence languages (```dataviewjs / ~~~dataview → text)
 *     on EVERY line, behind any `>` / list-marker / whitespace prefix, whatever
 *     the surrounding fence state. Renaming is harmless where the line is not a
 *     real opener, so there is no reason to be clever about where it applies.
 *
 *  2. Decide which lines are CERTAINLY inside a fenced code block, so the
 *     HTML / link / inline-span neutralizers may skip them (a user's captured
 *     ```js or ```html snippet must survive byte-for-byte). Guessing wrong in
 *     the "inside a fence" direction ships live markdown, so a line counts as
 *     fenced only when EVERY plausible parse agrees, and each extra parse may
 *     only SHRINK the fenced set:
 *       - Only a COLUMN-0 opener is certain (no backtick in a backtick fence's
 *         info string). An indented opener or one behind `>` / a list marker
 *         sits in a container whose closers are relative to it (`     ```` can
 *         close an item's fence), so its lines are always neutralized. A
 *         column-0 fence line is never inside a list item or quote: a fence
 *         cannot be a lazy continuation.
 *       - CommonMark closer: ≤3 spaces, same char, ≥ opener length.
 *       - lenient-closer parse: any indentation closes (a renderer that closes
 *         early exposes the lines after its closer).
 *       - block-context parse: a ``` line inside an HTML block or an Obsidian
 *         `%%` comment / `$$` math block is content, not an opener.
 *
 * Pure and total: no I/O, never throws.
 */

/** Fence languages Obsidian executes — renamed to `text` (body preserved). */
const EXECUTABLE_FENCE_LANGS = new Set(["dataviewjs", "dataview"]);

/**
 * A fence marker behind any mix of whitespace, callout `>` and list markers.
 * Deliberately a superset of real container prefixes (no required space after
 * a marker): it is only used to rename and to drop, both safe to over-apply.
 */
const FENCE_ANY_PREFIX = /^((?:\s|>|[-*+]|\d{1,9}[.)])*)(`{3,}|~{3,})(.*)$/;

/** A certain opener: ≥3 backticks or tildes at column 0. */
const CERTAIN_OPEN = /^(`{3,}|~{3,})(.*)$/;

/** A CommonMark closer: ≤3 spaces, the fence run, trailing spaces/tabs only. */
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A lenient closer: the fence run behind any indentation. */
const LENIENT_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

export interface Fence {
  char: string;
  len: number;
}

/** First word of a fence info string, lowercased (Obsidian's language key). */
function fenceLang(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Rename an executable fence opener on this line to `text`, else return it. */
export function renameExecutableFence(line: string): string {
  const match = FENCE_ANY_PREFIX.exec(line);
  if (!match) return line;
  const [, prefix, marker, info] = match;
  return EXECUTABLE_FENCE_LANGS.has(fenceLang(info)) ? `${prefix}${marker}text` : line;
}

/** True when the line looks like a fence marker behind any container prefix. */
export function isFenceLike(line: string): boolean {
  return FENCE_ANY_PREFIX.test(line);
}

export function certainOpener(line: string): Fence | null {
  const match = CERTAIN_OPEN.exec(line);
  if (!match) return null;
  const [, marker, info] = match;
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0], len: marker.length };
}

/** Does `line` close `fence`? Lenient: behind any indentation. */
export function closesFence(line: string, fence: Fence, lenient: boolean): boolean {
  const match = (lenient ? LENIENT_CLOSE : CLOSE).exec(line);
  return match !== null && match[1][0] === fence.char && match[1].length >= fence.len;
}

function closes(line: string, fence: Fence, mode: ScanMode): boolean {
  return closesFence(line, fence, mode.lenientClose);
}

/** A fence marker behind any container prefix; `info` is the rest of the line. */
export function containerFence(line: string): { fence: Fence; info: string } | null {
  const match = FENCE_ANY_PREFIX.exec(line);
  if (!match) return null;
  const [, , marker, info] = match;
  if (marker[0] === "`" && info.includes("`")) return null;
  return { fence: { char: marker[0], len: marker.length }, info };
}

/** Where an HTML / comment / math block ends: a marker, or a blank line. */
type BlockEnd = RegExp | "blank";

interface BlockStart {
  end: BlockEnd;
  /** The rest of the opening line, which may already hold the end marker. */
  rest: string;
}

const BLOCK_STARTS: ReadonlyArray<[RegExp, BlockEnd]> = [
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<!/, />/],
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}</, "blank"],
  [/^ {0,3}%%/, /%%/],
  [/^ {0,3}\$\$/, /\$\$/],
];

function blockStart(line: string): BlockStart | null {
  for (const [start, end] of BLOCK_STARTS) {
    const match = start.exec(line);
    if (match) return { end, rest: line.slice(match[0].length) };
  }
  return null;
}

function blockEnds(end: BlockEnd, text: string): boolean {
  return end === "blank" ? text.trim() === "" : end.test(text);
}

interface ScanMode {
  lenientClose: boolean;
  blockContext: boolean;
}

/** An HTML / comment / math block this line opens and leaves open, if any. */
function openedBlock(line: string, mode: ScanMode): BlockEnd | null {
  const start = mode.blockContext ? blockStart(line) : null;
  if (!start) return null;
  return start.end !== "blank" && blockEnds(start.end, start.rest) ? null : start.end;
}

/** One parse: which lines it places inside a fence (delimiters included). */
function fencedLines(lines: readonly string[], mode: ScanMode): boolean[] {
  const inside: boolean[] = [];
  let fence: Fence | null = null;
  let block: BlockEnd | null = null;
  for (const line of lines) {
    if (fence) {
      inside.push(true);
      if (closes(line, fence, mode)) fence = null;
      continue;
    }
    if (block) {
      if (blockEnds(block, line)) block = null;
      inside.push(false);
      continue;
    }
    fence = certainOpener(line);
    inside.push(fence !== null);
    if (!fence) block = openedBlock(line, mode);
  }
  return inside;
}

const MODES: readonly ScanMode[] = [
  { lenientClose: false, blockContext: false },
  { lenientClose: true, blockContext: false },
  { lenientClose: false, blockContext: true },
];

/** Lines every parse places inside a fenced code block. */
export function certainlyFencedLines(lines: readonly string[]): boolean[] {
  const parses = MODES.map((mode) => fencedLines(lines, mode));
  return lines.map((_, i) => parses.every((inside) => inside[i]));
}
