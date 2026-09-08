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
