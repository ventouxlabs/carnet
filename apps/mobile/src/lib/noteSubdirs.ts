/**
 * Vault note subdirs and uri → subdir derivation.
 *
 * Pure and side-effect-free by design (no AsyncStorage, no expo-file-system):
 * `writer.ts` and `vault.ts` both need this, and several places (test mocks
 * for either) need to use `subdirForUri` without pulling in the native
 * dependencies that would otherwise force a full module mock instead of a
 * real import.
 */

/** Vault subdirs that hold markdown notes. Photos/Audio/Files hold binaries
 * and are deliberately excluded from note enumeration. */
export const NOTE_SUBDIRS = ["Ideas", "Journal", "Notes", "People"] as const;
export type NoteSubdir = (typeof NOTE_SUBDIRS)[number];

/** The immediate parent path segment of a (possibly SAF, possibly
 * percent-encoded) note uri, decoded. Shared by `inferNoteMode` and
 * `subdirForUri` so the decode → split → parent-segment rule has one
 * definition. */
export function parentSegment(uri: string): string | undefined {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* keep raw */
  }
  const segments = decoded.split("/").filter(Boolean);
  return segments[segments.length - 2];
}

/**
 * The vault subdir a note actually lives in, read from its uri.
 *
 * Authoritative where `inferNoteMode` (vault.ts) is not: mode collapses every
 * unknown parent to "idea", which is right for display but wrong for any
 * decision that branches on folder identity (related-notes self-exclusion,
 * whether a note has an in-place re-enrichment path). Returns null outside
 * the known note subdirs.
 */
export function subdirForUri(uri: string): NoteSubdir | null {
  const parent = parentSegment(uri);
  return (NOTE_SUBDIRS as readonly string[]).includes(parent ?? "")
    ? (parent as NoteSubdir)
    : null;
}
