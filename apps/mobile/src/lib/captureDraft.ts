/**
 * Capture-screen draft persistence.
 *
 * The capture form's raw inputs are auto-saved (debounced by the screen) so a
 * back-press, an interrupting share intent, or process death never loses a
 * half-typed capture — the single worst data-loss path in the old flow, where
 * nothing existed anywhere until Send. Drafts are keyed per capture mode so an
 * Idea draft survives a detour into Journal. Cleared the moment the capture is
 * safely persisted (written to vault, or enqueued offline).
 *
 * Deliberately NOT part of the settings blob or the queue: a draft is
 * ephemeral UI state, not a committed capture.
 *
 * Drafts are sealed at rest with the same construction as the offline queue
 * (see queueCrypto). They hold exactly the data classes issue #86 was filed
 * over — idea text, voice transcript, OCR'd business-card PII — and are
 * autosaved throughout composition, so leaving them plaintext would mean an
 * `adb pull` still yields the in-flight capture even though the queue is
 * encrypted. The queue holds only captures that FAILED to send; the draft
 * holds the one being written right now.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import { decryptPayload, encryptPayload, isEncryptedEnvelope } from "./queueCrypto";
import type { CaptureMode } from "./storage";
import {
  draftKey,
  LEGACY_DRAFT_KEY_PREFIX,
  profileIdOrDefault,
} from "./vaultStorageKeys";
import { DEFAULT_VAULT_PROFILE_ID } from "./vaultProfiles";

export interface CaptureDraft {
  /** Idea text / journal notes / person meeting-context. */
  text: string;
  /** Journal transcript (empty for other modes). */
  transcript: string;
  /** Person OCR text (empty for other modes). */
  ocrText: string;
  /** Epoch ms of the last autosave — lets future UI show "draft from …". */
  savedAt: number;
}

function legacyKeyFor(mode: CaptureMode): string {
  return `${LEGACY_DRAFT_KEY_PREFIX}${mode}`;
}

function isDraft(value: unknown): value is CaptureDraft {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.text === "string" &&
    typeof d.transcript === "string" &&
    typeof d.ocrText === "string" &&
    typeof d.savedAt === "number"
  );
}

/** True when the draft holds no user input worth restoring. */
export function isEmptyDraft(
  draft: Pick<CaptureDraft, "text" | "transcript" | "ocrText">,
): boolean {
  return (
    draft.text.trim().length === 0 &&
    draft.transcript.trim().length === 0 &&
    draft.ocrText.trim().length === 0
  );
}

/** Read the stored draft for a mode; null when absent, corrupt, or empty. */
export async function loadDraft(
  mode: CaptureMode,
  profileId?: string,
): Promise<CaptureDraft | null> {
  try {
    const resolvedProfileId = profileIdOrDefault(profileId);
    const key = draftKey(mode, resolvedProfileId);
    let raw = await AsyncStorage.getItem(key);
    // The old key belongs exclusively to the default profile. Copying the
    // sealed value preserves encryption and makes this lazy migration safe to
    // retry if the process dies between reads and writes.
    if (!raw && resolvedProfileId === DEFAULT_VAULT_PROFILE_ID) {
      raw = await AsyncStorage.getItem(legacyKeyFor(mode));
      if (raw) await AsyncStorage.setItem(key, raw);
    }
    if (!raw) return null;
    // Legacy drafts written before encryption shipped are plaintext JSON; they
    // stay readable and are re-sealed by the next saveDraft.
    const json = isEncryptedEnvelope(raw) ? await decryptPayload(raw) : raw;
    const parsed: unknown = JSON.parse(json);
    if (!isDraft(parsed) || isEmptyDraft(parsed)) return null;
    return parsed;
  } catch {
    // A corrupt, unreadable, or undecryptable draft must never block the
    // capture screen — the user simply starts from an empty form.
    return null;
  }
}

/**
 * Persist the current inputs. An all-empty draft is stored as a removal so
 * clearing the field by hand doesn't leave a stale draft to "restore" later.
 */
export async function saveDraft(
  mode: CaptureMode,
  fields: Pick<CaptureDraft, "text" | "transcript" | "ocrText">,
  profileId?: string,
): Promise<void> {
  const key = draftKey(mode, profileId);
  if (isEmptyDraft(fields)) {
    await AsyncStorage.removeItem(key);
    return;
  }
  const draft: CaptureDraft = { ...fields, savedAt: Date.now() };
  await AsyncStorage.setItem(
    key,
    await encryptPayload(JSON.stringify(draft)),
  );
}

/** Drop the draft — call once the capture is safely persisted. */
export async function clearDraft(mode: CaptureMode, profileId?: string): Promise<void> {
  await AsyncStorage.removeItem(draftKey(mode, profileId));
}
