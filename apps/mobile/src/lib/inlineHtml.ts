/**
 * CommonMark inline raw HTML and autolinks, for the B3 inline-query tokenizer
 * (sanitizeInlineCode.ts). Code spans, raw HTML and autolinks share one
 * precedence level — whichever STARTS first wins — so a backtick inside
 * `<b title="`">` or `<http://x.y/`>` is not a code-span opener, and the
 * span right after it is live. The tokenizer needs to skip such constructs.
 *
 * Pure and total. Linear per text: the lazy constructs (comment, processing
 * instruction, declaration, CDATA) look up their terminator through a
 * forward-only cache, so many unterminated `<!--` cannot go quadratic.
 */

const TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const ATTRIBUTE = `\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?`;
const EMAIL_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";

/** Open tag, closing tag, URI autolink or email autolink, anchored at lastIndex. */
const TAG_OR_AUTOLINK = new RegExp(
  [
    `<${TAG_NAME}(?:${ATTRIBUTE})*\\s*/?>`,
    `</${TAG_NAME}\\s*>`,
    "<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\\s<>]*>",
    `<[A-Za-z0-9.!#$%&'*+/=?^_\`{|}~-]+@${EMAIL_LABEL}(?:\\.${EMAIL_LABEL})*>`,
  ].join("|"),
  "y",
);

/** Constructs that end at a fixed terminator: [opener, terminator]. */
const TERMINATED: ReadonlyArray<[RegExp, string]> = [
  [/^<!--/, "-->"],
  [/^<\?/, "?>"],
  [/^<!\[CDATA\[/, "]]>"],
  [/^<![A-Za-z]/, ">"],
];

/**
 * A matcher over one string. Calls must come with non-decreasing `at`: the
 * terminator cache relies on it (a terminator missing after `at` is missing
 * after every later position too).
 */
export type HtmlSpanEnd = (at: number) => number;

/** Build a matcher returning the index just past the raw HTML construct or
 * autolink starting at `at`, or -1 when none starts there. */
export function htmlSpanMatcher(text: string): HtmlSpanEnd {
  const nextAt = new Map<string, number>();
  const find = (needle: string, from: number): number => {
    const hit = nextAt.get(needle);
    if (hit !== undefined && (hit === -1 || hit >= from)) return hit;
    const found = text.indexOf(needle, from);
    nextAt.set(needle, found);
    return found;
  };
  return (at) => {
    if (text.startsWith("<!-->", at)) return at + 5;
    if (text.startsWith("<!--->", at)) return at + 6;
    for (const [opener, terminator] of TERMINATED) {
      const open = opener.exec(text.slice(at, at + 9));
      if (!open) continue;
      const close = find(terminator, at + open[0].length);
      return close === -1 ? -1 : close + terminator.length;
    }
    TAG_OR_AUTOLINK.lastIndex = at;
    const match = TAG_OR_AUTOLINK.exec(text);
    return match ? at + match[0].length : -1;
  };
}
