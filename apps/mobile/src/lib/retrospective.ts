//
// Pure selection + budget packing for the retrospective query. No filesystem,
// no network, no React Native — mirrors the purity of frontmatter.ts and
// checklist.ts so the whole selection path is fixture-testable.

/** Hard cap on notes sent in one question. */
export const MAX_NOTES = 12;
/** Per-note character cap, so one long note cannot consume the bundle. */
export const PER_NOTE_CHARS = 2000;
/** Total character budget. Binding constraint by construction
 * (MAX_NOTES * PER_NOTE_CHARS = 24000 > 16000). Conservative on purpose: a
 * local Relais model may have a small context window. Tune here, one place. */
export const TOTAL_BUDGET_CHARS = 16000;

/** A note eligible to feed the synthesis, as seen on the Search screen. */
export interface RetrievalCandidate {
  uri: string;
  title: string;
  /** From a Phase-2 body scan — evidence of a real body hit, so it ranks
   * above an indexed title/tag/excerpt match. */
  fromBodyMatch: boolean;
}

/** A note actually included in the bundle, after the budget bound. */
export interface SelectedNote {
  uri: string;
  title: string;
  body: string;
  /** True when `body` was cut at PER_NOTE_CHARS — surfaced in the prompt so
   * the model knows it is reasoning over a fragment. */
  truncated: boolean;
}

/** Body matches first, then indexed results in the order Search displays
 * them. Deduped by uri, first occurrence wins. Invents no ranking — that is
 * decision 2 in the PRD and the reason this feature stays small. */
export function orderCandidates(
  bodyMatches: readonly RetrievalCandidate[],
  indexed: readonly RetrievalCandidate[],
): RetrievalCandidate[] {
  const seen = new Set<string>();
  const out: RetrievalCandidate[] = [];
  for (const c of [...bodyMatches, ...indexed]) {
    if (seen.has(c.uri)) continue;
    seen.add(c.uri);
    out.push(c);
  }
  return out;
}

/** Cap the read set before any IO is spent. */
export function pickForRead(ordered: readonly RetrievalCandidate[]): RetrievalCandidate[] {
  return ordered.slice(0, MAX_NOTES);
}

/** Apply both character caps. A candidate whose body was not read (deleted
 * mid-scan, permission revoked) is skipped, matching buildNoteIndex and
 * searchNoteBodies. Stops at the first note that would exceed the total. */
export function packBodies(
  picked: readonly RetrievalCandidate[],
  bodies: ReadonlyMap<string, string>,
): SelectedNote[] {
  const out: SelectedNote[] = [];
  let used = 0;
  for (const c of picked) {
    const raw = bodies.get(c.uri);
    if (raw === undefined) continue;
    const truncated = raw.length > PER_NOTE_CHARS;
    const body = truncated ? raw.slice(0, PER_NOTE_CHARS) : raw;
    if (used + body.length > TOTAL_BUDGET_CHARS) break;
    used += body.length;
    out.push({ uri: c.uri, title: c.title, body, truncated });
  }
  return out;
}

/** One run of answer text. `linkUri` present ⇒ render as a tappable link. */
export interface AnswerSegment {
  text: string;
  linkUri?: string;
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;

const normalizeTitle = (s: string): string => s.trim().toLowerCase();

/**
 * Split an answer into renderable segments, linkifying `[[title]]` ONLY when
 * the title resolves to a note that was actually in the retrieval set.
 *
 * SECURITY: the model is told to cite only supplied notes; this enforces it.
 * An invented citation renders as its literal source text (brackets included)
 * rather than becoming a link to nothing — the user can see the model made
 * something up instead of tapping into a dead end.
 */
export function resolveCitations(
  answer: string,
  retrievalSet: readonly SelectedNote[],
): AnswerSegment[] {
  const byTitle = new Map(retrievalSet.map((n) => [normalizeTitle(n.title), n.uri]));
  const out: AnswerSegment[] = [];
  let last = 0;
  for (const m of answer.matchAll(WIKILINK)) {
    const start = m.index ?? 0;
    const uri = byTitle.get(normalizeTitle(m[1]));
    if (start > last) out.push({ text: answer.slice(last, start) });
    if (uri) out.push({ text: m[1].trim(), linkUri: uri });
    else out.push({ text: m[0] }); // inert: keep the literal [[…]]
    last = start + m[0].length;
  }
  if (last < answer.length) out.push({ text: answer.slice(last) });
  return out;
}

/**
 * Assemble the saved note. `today` is injected rather than read from the
 * clock so the test is deterministic — same reason prompts.ts's todayLocal
 * exists separately from its callers.
 */
export function buildSynthesisNote(
  question: string,
  answer: string,
  sources: readonly SelectedNote[],
  today: string,
): string {
  // Collapse embedded newlines/CR/tabs FIRST, before escaping. A raw newline
  // would otherwise land inside the frontmatter block as its own line (e.g.
  // "coffee\ntags: [injected]" would inject a second `tags:` field) and
  // would also break the single-line `# ` heading below. extractFrontmatterField
  // (frontmatter.ts) parses line-by-line and never unescapes, so encoding the
  // newline as literal "\n" text is not an option — it would read back as a
  // literal backslash-n, not a real line break.
  const oneLineQuestion = question.replace(/\s+/g, " ").trim();
  const safeQuestion = oneLineQuestion.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sourceList = sources.map((s) => `- [[${s.title}]]`).join("\n");
  return [
    "---",
    `created: ${today}`,
    "tags: [synthesis]",
    `question: "${safeQuestion}"`,
    "---",
    `# ${oneLineQuestion}`,
    "",
    answer.trim(),
    "",
    "## Sources",
    "",
    sourceList,
    "",
  ].join("\n");
}
