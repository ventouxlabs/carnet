/**
 * Linear-time HTML tag scanner for untrusted, fetched HTML.
 *
 * The URL-preview path used to pull `<meta>`, `<title>` and `<p>` out of
 * attacker-controlled markup with backtracking regexes (`<meta[^>]*...`,
 * `<p(?:\s[^>]*)?>([\s\S]*?)<\/p>`). Input such as 40k repeated `<meta `
 * with no `>` made each start position rescan to the end of the body —
 * quadratic time on the JS thread. This scanner walks the string once with
 * `indexOf`, never revisiting a position, so cost is O(n) regardless of
 * how malformed the markup is.
 */

export interface HtmlTag {
  /** Lower-cased tag name; a leading `/` marks a closing tag. */
  readonly name: string;
  /** Raw attribute text between the name and the closing `>`. */
  readonly attrs: string;
  /** Index of the `<`. */
  readonly start: number;
  /** Index just past the `>`. */
  readonly end: number;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** Scan every well-formed tag (`<name ...>` / `</name>`). A `<` that is
 * not followed by a letter or `/letter` is plain text; a tag with no
 * terminating `>` ends the scan. */
export function scanTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  let pos = 0;
  for (;;) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) break;
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    let i = lt + 1;
    if (html[i] === "/") i += 1;
    if (!/[a-zA-Z]/.test(html[i] ?? "")) {
      pos = lt + 1;
      continue;
    }
    let nameEnd = i;
    while (nameEnd < gt && !isSpace(html[nameEnd]) && html[nameEnd] !== "/") {
      nameEnd += 1;
    }
    tags.push({
      name: html.slice(lt + 1, nameEnd).toLowerCase(),
      attrs: html.slice(nameEnd, gt),
      start: lt,
      end: gt + 1,
    });
    pos = gt + 1;
  }
  return tags;
}

/** Parse attribute text into a lower-cased-name -> value map (first
 * occurrence wins). Only quoted values are kept when the quote closes;
 * an unterminated quote ends parsing, so unbalanced markup such as
 * `content="foo'` yields no value. */
export function parseAttrs(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = attrs.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(attrs[i]) || attrs[i] === "/")) i += 1;
    const nameStart = i;
    while (
      i < n &&
      !isSpace(attrs[i]) &&
      attrs[i] !== "=" &&
      attrs[i] !== "/"
    ) {
      i += 1;
    }
    const name = attrs.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(attrs[i])) i += 1;
    if (attrs[i] !== "=") {
      if (i === nameStart) i += 1;
      continue;
    }
    i += 1;
    while (i < n && isSpace(attrs[i])) i += 1;
    const q = attrs[i];
    let value: string;
    if (q === '"' || q === "'") {
      const close = attrs.indexOf(q, i + 1);
      if (close === -1) break;
      value = attrs.slice(i + 1, close);
      i = close + 1;
    } else {
      const valStart = i;
      while (i < n && !isSpace(attrs[i])) i += 1;
      value = attrs.slice(valStart, i);
    }
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}
