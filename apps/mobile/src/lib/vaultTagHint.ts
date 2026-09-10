/**
 * Vault tag awareness (v0.4 S3): show the model the tag vocabulary the vault
 * already uses, so auto-tagging reuses `dev` instead of minting `development`
 * and `engineering` alongside it.
 *
 * Two deliberate choices, both load-bearing:
 *
 * 1. Reads `loadCachedTagIndex()`, NEVER `getTagIndex()`. The latter falls
 *    through to a full `refreshNoteIndex()` SAF vault walk on a cache miss
 *    (vault.ts's getNoteIndex), which would put seconds of I/O in front of a
 *    capture. The hint is best-effort: a cold cache yields no hint, not a slow
 *    capture. HomeScreen already warms the index in the background on launch.
 *
 * 2. The hint is appended to the FINAL system string, after any user prompt
 *    override has been applied — `withSystemOverride` replaces the whole
 *    system message, so a hint baked into prompts.ts would vanish for anyone
 *    using PromptOverridesSection.
 *
 * Tag strings reach the prompt from vault files (i.e. from Syncthing, i.e.
 * from anywhere), but every tag in the index has passed `normalizeTag`
 * (frontmatter.ts) which restricts to [a-z0-9-] — no newlines, angle brackets
 * or whitespace can survive. What normalizeTag does NOT bound is length or
 * count, so both are clamped here.
 */

import { loadCachedTagIndex } from "./vault";

/** Most-used tags to name in the hint. Bounds prompt size on a large vault
 * (a 500-tag vault would otherwise inflate every capture's system message,
 * including for a small local model behind dispatcher.ts). */
export const MAX_HINT_TAGS = 50;

/** Longest tag admitted into the hint. normalizeTag bounds the alphabet but
 * not the length; a pathological 5000-char tag is dropped, not truncated —
 * a truncated tag is a DIFFERENT tag and would teach the model a name that
 * does not exist in the vault. */
export const MAX_TAG_LENGTH = 40;

/**
 * The vault's existing tag vocabulary, most-used first, or `[]` when no index
 * is cached yet. Never triggers a vault scan; never throws.
 */
export async function getVaultTagStrings(limit: number = MAX_HINT_TAGS): Promise<string[]> {
  let index;
  try {
    index = await loadCachedTagIndex();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[vaultTagHint] cached tag index read failed:", msg);
    return [];
  }
  if (!index) return [];
  return index.tags
    .map((entry) => entry.tag)
    .filter((tag) => tag.length > 0 && tag.length <= MAX_TAG_LENGTH)
    .slice(0, limit);
}

/**
 * Append the vault-vocabulary hint to a system prompt. Returns `system`
 * unchanged when there is nothing to suggest, so a cold cache, an empty
 * vault, and a disabled setting all collapse to today's exact behavior.
 *
 * The hint supplies vocabulary ONLY — it must never restate how many tags to
 * emit, because the five capture prompts ask for different counts (2-3 for
 * idea/journal/person, 3-5 for shared image/link).
 */
export function withTagHint(system: string, availableTags: string[]): string {
  if (availableTags.length === 0) return system;
  return `${system}

This vault already uses these tags (most-used first):
${availableTags.join(", ")}
When one of them fits the content, reuse it EXACTLY rather than inventing a
near-duplicate (e.g. reuse "dev" instead of adding "development"). Create a
new tag only when nothing above fits. This list is a vocabulary, not a
restriction on how many tags to emit — follow the tag count asked for above.`;
}
