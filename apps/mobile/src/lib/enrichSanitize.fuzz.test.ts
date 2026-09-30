/**
 * Seeded fuzz for the B3 sanitizer, both modes. Beyond "total and
 * idempotent", every output is checked by an ORACLE written independently of
 * the implementation (no parser dependency): nothing the sanitizer promises
 * to neutralize may survive outside a fenced code block.
 */
import { describe, expect, it } from "vitest";

import { sanitizeMarkdown, sanitizeReplyBody } from "./enrichSanitize";
import { splitFrontmatter } from "./frontmatter";

const ALPHABET = [
  "<", ">", "%", "`", "``", "```", "~~~", "\\", "on", "onx=", " ", "\n", "\r", "\n\n",
  "=", "$=", '"', "'", "-", "---", "> ", "- ", "1. ", "script", "iframe", "dataviewjs",
  "code", "|", "|---|", "javascript:", "](", "](<", "]: ", "[a", "!", "![", "data:",
  "data:image/", "&#97;", "&colon;", "&Tab;", "x", "    ", "#", "%%", "$$", "<div>", "</",
  "<!--", "-->", "<http://", 'title="`"', "<b ", "o", "nx=", " o", "sc", "ript", "= ",
  "\\:", "&Tab;&Tab;&Tab;&Tab;", "&#000000", "&#x0006A;", "            ", "java", "script:",
];

/** Deterministic LCG so a failure is reproducible from its seed. */
function fuzzInputs(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: count }, () => {
    const len = next() % 48;
    return Array.from({ length: len }, () => ALPHABET[next() % ALPHABET.length]).join("");
  });
}

/** Per-line CommonMark-style span pairing: is a live `=`/`$=` span on it? */
function hasLiveSpan(line: string, honorEscapes: boolean): boolean {
  const runAt = (at: number): number => {
    let end = at;
    while (line[end] === "`") end++;
    return end;
  };
  for (let i = 0; i < line.length; ) {
    if (honorEscapes && line[i] === "\\") i += 2;
    else if (line[i] !== "`") i++;
    else {
      const open = runAt(i);
      let close = open;
      while (close < line.length && !(line[close] === "`" && runAt(close) - close === open - i)) {
        close = line[close] === "`" ? runAt(close) : close + 1;
      }
      if (close >= line.length) i = open;
      else if (/^\s*\$?=/.test(line.slice(open, close))) return true;
      else i = close + (open - i);
    }
  }
  return false;
}

/** Decode what a renderer/browser decodes in a URL: numeric references (any
 * leading zeros), `&colon;`, `&Tab;`/`&NewLine;`, backslash-escaped ASCII
 * punctuation; then drop tab/CR/LF, as the URL parser does. */
function decodeSchemes(text: string): string {
  const fromCode = (code: number): string => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "?");
  return text
    .replace(/&#[xX]0*([0-9a-fA-F]{1,6});?/g, (_m, hex: string) => fromCode(parseInt(hex, 16)))
    .replace(/&#0*([0-9]{1,7});?/g, (_m, dec: string) => fromCode(parseInt(dec, 10)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;|&newline;/gi, "")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/[\t\r\n]/g, "");
}

/** Does a destination start (found on RAW text: entities never make block
 * structure — a reference definition is `[label]:` at a line start) spell
 * `javascript:` once its window is decoded as a browser would? */
function hasJavascriptLink(body: string): boolean {
  const starts = /\]\(\s*<?|^ {0,3}\[[^\]\n]+\]:[ \t]*\n?[ \t]*<?|<|href\s*=\s*["']?/gim;
  for (const match of body.matchAll(starts)) {
    const from = (match.index ?? 0) + match[0].length;
    const target = decodeSchemes(body.slice(from));
    if (/^[\x00-\x20]*javascript:/i.test(target)) return true;
  }
  return false;
}

/** What must never survive in body text that holds no fence at all. */
function liveConstructs(body: string): string[] {
  const found: string[] = [];
  if (/<script\b[^>]*>|<iframe\b[^>]*>|<code\b/i.test(body)) found.push("raw script/iframe/code tag");
  // A handler needs a value to run (`onx=>` parses as an empty attribute).
  if (/[\s/"']on[a-z]+\s*=\s*[^\s>]/i.test(body)) found.push("on*= handler");
  if (hasJavascriptLink(body)) found.push("javascript: link");
  if (body.split("\n").some((line) => hasLiveSpan(line, true) || hasLiveSpan(line, false))) {
    found.push("live inline query span");
  }
  return found;
}

/** Invariants that hold for EVERY output, fences or not. */
function structuralViolations(out: string): string[] {
  const found: string[] = [];
  if (/<%[\s\S]*?%>/.test(out)) found.push("closed Templater tag");
  if (/^(?:[^\S\n]|>|[-*+]|\d{1,9}[.)])*(?:`{3,}|~{3,})[^\S\n]*dataview(?:js)?(?:[^\S\n]|$)/im.test(out)) {
    found.push("executable fence opener");
  }
  return found;
}

function checkNote(out: string): string[] {
  const { header, body } = splitFrontmatter(out);
  const inner = header ? header.replace(/\n$/, "").split("\n") : [];
  const badHeader =
    header !== "" &&
    (inner[0] !== "---" ||
      inner[inner.length - 1] !== "---" ||
      inner.slice(1, -1).some((line) => line.trimStart().startsWith("---") || /^[\s>*+-]*(`{3}|~{3})/.test(line)));
  const text = /`{3}|~{3}/.test(body) ? [] : liveConstructs(body);
  return [...structuralViolations(out), ...(badHeader ? ["malformed header"] : []), ...text];
}

function checkBody(out: string): string[] {
  const opensFrontmatter = splitFrontmatter(out.trim()).header !== "";
  const text = /`{3}|~{3}/.test(out) ? [] : liveConstructs(out);
  return [...structuralViolations(out), ...(opensFrontmatter ? ["opens frontmatter"] : []), ...text];
}

const MODES: Array<[string, (x: string) => string, (out: string) => string[]]> = [
  ["sanitizeMarkdown", sanitizeMarkdown, checkNote],
  ["sanitizeReplyBody", sanitizeReplyBody, checkBody],
];

/**
 * Every way a link destination can start × padding × spelling of the scheme.
 * Random tokens cannot reach these (a >128-char pad, a 4-token spelling), so
 * the grammar is swept exhaustively instead.
 */
function linkGrammar(): string[] {
  const starts = ["[x](", "[x](<", "[x]: ", "[x]:\n  <", "see <", '<a href="', "<a href='", "<a href="];
  const pads = ["", "   ", " ".repeat(200), "&Tab;".repeat(130), "\u0001"];
  const spellings = [
    "javascript:", "JaVaScRiPt:", "&#106;avascript:", "&#0000000106;avascript:", "&#x6A;avascript:",
    "&#x0006a;avascript:", "java&Tab;script:", "java\nscript:", "javascript&colon;", "javascript\\:",
    "java&#0000009;script:", "javascript&#58;", "javascript&#x3a;",
  ];
  return starts.flatMap((start) =>
    pads.flatMap((pad) => spellings.map((spelling) => `${start}${pad}${spelling}alert(1)>) x`)),
  );
}

describe("link-destination grammar sweep", () => {
  for (const [name, sanitize, check] of MODES) {
    it(`${name}: no javascript: destination survives any spelling`, () => {
      for (const input of linkGrammar()) {
        expect(check(sanitize(input)), JSON.stringify(input)).toEqual([]);
      }
    });
  }
});

describe("sanitizer fuzz — total, idempotent, nothing live survives", () => {
  for (const [name, sanitize, check] of MODES) {
    it(`${name}: 3000 seeded inputs`, () => {
      for (const input of fuzzInputs(3000, 0xb3)) {
        const once = sanitize(input);
        expect(sanitize(once), JSON.stringify(input)).toBe(once);
        expect(check(once), JSON.stringify(input)).toEqual([]);
      }
    });
  }
});
