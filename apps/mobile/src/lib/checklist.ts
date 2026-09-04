import { stripFrontmatter } from "./frontmatter";

/** Cap on stored/matched checklist-line text — mirrors EXCERPT_MAX's role
 * of bounding the shared AsyncStorage note-index blob (vault.ts). */
export const CHECKLIST_TEXT_MAX = 300;

export interface ChecklistLine {
  text: string;
  checked: boolean;
}

const CHECKLIST_LINE_RE = /^[ \t]*-[ \t]+\[([ xX])\][ \t]+(.+)$/gm;

/** Extract every `- [ ]` / `- [x]` line from a note's body (frontmatter
 * stripped first — frontmatter is YAML, never checklist syntax, but this
 * keeps the regex from ever seeing it). Nested/indented items are matched
 * too (leading whitespace is tolerated) and returned as independent flat
 * rows — v1 does not model parent/child structure. Text is trimmed and
 * capped at CHECKLIST_TEXT_MAX so one unformatted line can't blow up the
 * shared note-index blob. */
export function extractChecklistLines(markdown: string): ChecklistLine[] {
  const body = stripFrontmatter(markdown);
  const out: ChecklistLine[] = [];
  for (const match of body.matchAll(CHECKLIST_LINE_RE)) {
    const checked = match[1].toLowerCase() === "x";
    const text = match[2].trim().slice(0, CHECKLIST_TEXT_MAX);
    if (text) out.push({ text, checked });
  }
  return out;
}

export type ChecklistToggleResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: "not_found" | "ambiguous" };

/** Re-scan `markdown` (handed in fresh by the caller — this function never
 * reads a cache) for a checklist line whose trimmed text equals `text` AND
 * whose current checked-state equals `expectedChecked`. Flips it ONLY when
 * there is exactly one such line; a stale caller (the matched text changed
 * or was removed) gets "not_found", and two identical lines get "ambiguous"
 * rather than a guess at which one the user meant. This is the anchor: the
 * line's own text at write time, never a remembered position. */
export function toggleChecklistLine(
  markdown: string,
  text: string,
  expectedChecked: boolean,
): ChecklistToggleResult {
  const target = text.trim().slice(0, CHECKLIST_TEXT_MAX);
  const lines = markdown.split("\n");
  const matchIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*-[ \t]+\[)([ xX])(\][ \t]+)(.+)$/.exec(lines[i]);
    if (!m) continue;
    const checked = m[2].toLowerCase() === "x";
    const lineText = m[4].trim().slice(0, CHECKLIST_TEXT_MAX);
    if (lineText === target && checked === expectedChecked) matchIndexes.push(i);
  }
  if (matchIndexes.length === 0) return { ok: false, reason: "not_found" };
  if (matchIndexes.length > 1) return { ok: false, reason: "ambiguous" };

  const i = matchIndexes[0];
  const m = /^([ \t]*-[ \t]+\[)([ xX])(\][ \t]+)(.+)$/.exec(lines[i])!;
  const nextMark = expectedChecked ? " " : "x";
  const nextLines = [...lines];
  nextLines[i] = `${m[1]}${nextMark}${m[3]}${m[4]}`;
  return { ok: true, markdown: nextLines.join("\n") };
}
