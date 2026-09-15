/**
 * Names for local state that belongs to one vault profile.
 *
 * The vault itself remains the source of truth. These keys contain only
 * reconstructable UI conveniences (recents, drafts, indexes), but sharing one
 * key across profiles still leaks the wrong vault into the active UI. Keep the
 * profile id in the key rather than encoding a root URI: SAF URIs can be long,
 * can contain provider-specific punctuation, and are not stable identifiers.
 */

import { DEFAULT_VAULT_PROFILE_ID } from "./vaultProfiles";

export const LEGACY_HISTORY_KEY = "carnet:history:v1";
export const LEGACY_DRAFT_KEY_PREFIX = "carnet:capture_draft:v1:";
export const LEGACY_NOTE_INDEX_KEY = "carnet:noteindex:v1";

/** The id used by legacy single-vault data and by callers that have no context. */
export function profileIdOrDefault(profileId?: string): string {
  return profileId || DEFAULT_VAULT_PROFILE_ID;
}

export function historyKey(profileId?: string): string {
  return `carnet:history:v2:${profileIdOrDefault(profileId)}`;
}

export function draftKey(mode: string, profileId?: string): string {
  return `carnet:capture_draft:v2:${profileIdOrDefault(profileId)}:${mode}`;
}

export function noteIndexKey(profileId?: string): string {
  return `carnet:noteindex:v2:${profileIdOrDefault(profileId)}`;
}
