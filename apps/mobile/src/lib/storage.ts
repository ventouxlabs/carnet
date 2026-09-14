import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  historyKey,
  LEGACY_HISTORY_KEY,
  profileIdOrDefault,
} from "./vaultStorageKeys";
import { DEFAULT_VAULT_PROFILE_ID } from "./vaultProfiles";

const HISTORY_LIMIT = 20;

export type CaptureMode = "idea" | "journal" | "person" | "photo" | "audio";

export interface CaptureEntry {
  id: string;
  mode: CaptureMode;
  title: string;
  filepath: string;
  createdAt: number;
}

export async function getRecentCaptures(profileId?: string): Promise<CaptureEntry[]> {
  const resolvedProfileId = profileIdOrDefault(profileId);
  const key = historyKey(resolvedProfileId);
  let raw = await AsyncStorage.getItem(key);
  // v1 belonged to the one pre-profile vault. Read it only for the stable
  // default profile, then materialize v2 before returning. This makes an
  // interrupted migration retry-safe and prevents a later Work profile from
  // inheriting Personal's recents merely because it is currently active.
  if (!raw && resolvedProfileId === DEFAULT_VAULT_PROFILE_ID) {
    raw = await AsyncStorage.getItem(LEGACY_HISTORY_KEY);
    if (raw) await AsyncStorage.setItem(key, raw);
  }
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as CaptureEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function recordCapture(entry: CaptureEntry, profileId?: string): Promise<void> {
  const existing = await getRecentCaptures(profileId);
  const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
  await AsyncStorage.setItem(historyKey(profileId), JSON.stringify(next));
}

export async function removeFromHistory(id: string, profileId?: string): Promise<void> {
  const existing = await getRecentCaptures(profileId);
  const next = existing.filter((e) => e.id !== id);
  await AsyncStorage.setItem(historyKey(profileId), JSON.stringify(next));
}

/**
 * Remove any history entry pointing at `filepath`. Used when a note is deleted
 * from a context that doesn't carry its recents id (e.g. the tag browser, which
 * opens notes via a synthesized entry) — without this, archiving the file would
 * leave a ghost recents row pointing at a now-archived path. Skips the write
 * when nothing matched.
 */
export async function removeFromHistoryByFilepath(filepath: string, profileId?: string): Promise<void> {
  const existing = await getRecentCaptures(profileId);
  const next = existing.filter((e) => e.filepath !== filepath);
  if (next.length === existing.length) return;
  await AsyncStorage.setItem(historyKey(profileId), JSON.stringify(next));
}

/**
 * Remove many entries by id in a single write. Used by Home's multi-select
 * bulk delete so cleaning up N rows is one AsyncStorage round-trip instead
 * of N. Unknown ids are silently ignored. Skips the write when no entries
 * actually match — avoids touching storage on empty input or all-unknown
 * inputs.
 */
export async function removeManyFromHistory(
  ids: ReadonlyArray<string>,
  profileId?: string,
): Promise<void> {
  if (ids.length === 0) return;
  const toRemove = new Set(ids);
  const existing = await getRecentCaptures(profileId);
  const next = existing.filter((e) => !toRemove.has(e.id));
  if (next.length === existing.length) return;
  await AsyncStorage.setItem(historyKey(profileId), JSON.stringify(next));
}

/**
 * Update the title of a single capture entry in place. Used when the user
 * edits the H1 of a note from inside carnet — keeps the recents list in
 * sync with the file content. Unknown ids are silently ignored. Skips the
 * write when the existing title already matches to avoid an empty
 * round-trip (common case: user edited the body but not the H1).
 */
export async function updateCaptureTitle(
  id: string,
  title: string,
  profileId?: string,
): Promise<void> {
  const existing = await getRecentCaptures(profileId);
  const idx = existing.findIndex((e) => e.id === id);
  if (idx === -1) return;
  if (existing[idx].title === title) return;
  const next = [...existing];
  next[idx] = { ...next[idx], title };
  await AsyncStorage.setItem(historyKey(profileId), JSON.stringify(next));
}

/**
 * Retitle the history entry pointing at `filepath`. The by-filepath counterpart
 * to `updateCaptureTitle`, for the same reason `removeFromHistoryByFilepath`
 * exists: a note opened from the tag browser or search carries a SYNTHESIZED id
 * that matches no stored row, so an id-keyed update silently no-ops and the
 * recents card keeps the pre-enrichment title. Skips the write when nothing
 * matched or the title is already current.
 */
export async function updateCaptureTitleByFilepath(
  filepath: string,
  title: string,
  profileId?: string,
): Promise<void> {
  const existing = await getRecentCaptures(profileId);
  const idx = existing.findIndex((e) => e.filepath === filepath);
  if (idx === -1) return;
  if (existing[idx].title === title) return;
  const next = [...existing];
  next[idx] = { ...next[idx], title };
  await AsyncStorage.setItem(historyKey(profileId), JSON.stringify(next));
}

/**
 * Repoint a history entry's `filepath` in place, e.g. after vaultMigration.ts
 * moves a pre-vault note to a new URI in the just-picked vault (#172) —
 * without this, a Recents row surviving from before the move keeps pointing
 * at the now-deleted internal-storage path and reads as broken. Same
 * silent-no-op-when-unmatched contract as the sibling by-filepath helpers:
 * a note with no history entry (never opened via a Recents-tracked capture)
 * is not an error here.
 */
export async function updateCaptureFilepath(
  oldFilepath: string,
  newFilepath: string,
  profileId?: string,
): Promise<void> {
  const existing = await getRecentCaptures(profileId);
  const idx = existing.findIndex((e) => e.filepath === oldFilepath);
  if (idx === -1) return;
  const next = [...existing];
  next[idx] = { ...next[idx], filepath: newFilepath };
  await AsyncStorage.setItem(historyKey(profileId), JSON.stringify(next));
}
