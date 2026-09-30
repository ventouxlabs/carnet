/**
 * Linear-time removals for the B3 sanitizer (enrichSanitize.ts): Templater
 * `<%…%>` and raw `<script>` / `<iframe>` elements.
 *
 * Each has the exact semantics of the lazy regex it replaces
 * (`/<%[\s\S]*?%>/g`, `/<script\b[\s\S]*?<\/script\s*>/gi` then
 * `/<script\b[^>]*>/gi`), but stops at the first opener with no terminator
 * after it: no later opener can have one either. The regexes instead
 * rescanned to the end of the text from every opener, which is quadratic,
 * and 128k unclosed `<%` took about 9 s. Pure and total.
 */

export const TEMPLATER_REMOVED = "[templater expression removed]";

/** Replace every `<%…%>` (Templater executes it, even inside code fences). */
export function stripTemplater(text: string): string {
  let out = "";
  let last = 0;
  for (let at = text.indexOf("<%"); at !== -1; at = text.indexOf("<%", last)) {
    const close = text.indexOf("%>", at + 2);
    if (close === -1) break;
    out += text.slice(last, at) + TEMPLATER_REMOVED;
    last = close + 2;
  }
  return out + text.slice(last);
}

/** Replace each `<name …>…</name>` element, lazily closed. */
function replacePairs(text: string, name: string, replacement: string): string {
  const open = new RegExp(`<${name}\\b`, "gi");
  const close = new RegExp(`<\\/${name}\\s*>`, "gi");
  let out = "";
  let last = 0;
  for (let match = open.exec(text); match; match = open.exec(text)) {
    close.lastIndex = match.index + match[0].length;
    const end = close.exec(text);
    if (!end) break;
    out += text.slice(last, match.index) + replacement;
    last = end.index + end[0].length;
    open.lastIndex = last;
  }
  return out + text.slice(last);
}

/** Replace each remaining lone `<name …>` opener, up to its first `>`. */
function replaceOpeners(text: string, name: string, replacement: string): string {
  const open = new RegExp(`<${name}\\b`, "gi");
  let out = "";
  let last = 0;
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const gt = text.indexOf(">", match.index + match[0].length);
    if (gt === -1) break;
    out += text.slice(last, match.index) + replacement;
    last = gt + 1;
    open.lastIndex = last;
  }
  return out + text.slice(last);
}

/** Remove `<name>` elements (with their bodies) and lone `<name …>` openers. */
export function removeElement(text: string, name: string, replacement: string): string {
  return replaceOpeners(replacePairs(text, name, replacement), name, replacement);
}
