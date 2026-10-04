/**
 * Conservative, read-only heuristic for the historical SAF truncate bug.
 *
 * Before the SAF writer was fixed, rewriting a note with fewer bytes could
 * leave bytes from the former version after the new content. There is no
 * reliable repair boundary, so this deliberately reports only a narrow shape:
 * a final, unterminated line that is a proper suffix of an earlier line.
 * Callers must present matches for human review; this module never edits text.
 */

/** Short fragments occur naturally in prose and must not create a review row. */
const MIN_REPEATED_SUFFIX_LENGTH = 12;

/** Remove regions whose repeated strings are structural rather than prose.
 * A partial frontmatter block or an unclosed code fence is treated as wholly
 * ineligible: the detector is a review hint, so false negatives are safer. */
function reviewableLines(markdown: string): string[] {
  let lines = markdown.split(/\r?\n/);
  if (lines[0] === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line === "---");
    if (close === -1) return [];
    lines = lines.slice(close + 1);
  }

  const reviewable: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) reviewable.push(line);
  }
  return reviewable;
}

/**
 * Returns true only for a likely leftover terminal fragment. A normal
 * newline-terminated Markdown file, a repeated whole line, and short common
 * endings are intentionally ignored to keep this review list conservative.
 */
export function hasPossibleSafStaleTail(markdown: string): boolean {
  if (markdown.endsWith("\n") || markdown.endsWith("\r")) return false;

  const lines = reviewableLines(markdown);
  const tail = lines.at(-1) ?? "";
  if (tail.length < MIN_REPEATED_SUFFIX_LENGTH) return false;

  return lines.slice(0, -1).some(
    (line) => line.length > tail.length && line.endsWith(tail),
  );
}
