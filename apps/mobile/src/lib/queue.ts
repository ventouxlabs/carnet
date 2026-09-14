/**
 * Offline capture queue for carnet v0.2.
 *
 * When OmniRoute is unreachable (network error or 5xx), a capture is stored
 * in AsyncStorage (a JSON array under a single key). On reconnect or app
 * foreground, a drain loop processes the queue oldest-first:
 *   - Success → write file to disk + remove row
 *   - 4xx (permanent failure) → mark as failed, stop auto-retrying
 *   - Network error / 5xx → leave in queue, retry next drain
 *
 * The API key is NOT stored in the queue — it is read fresh from SecureStore
 * on each drain pass. Only the raw user input is persisted.
 *
 * Storage note: this used expo-sqlite, but that native module throws a SharedRef
 * ABI error on-device (expo-sqlite@55 against the SDK-54 expo-modules-core), so
 * the queue never persisted. AsyncStorage's native module is already present and
 * working (see storage.ts), needs no native rebuild, and the queue only holds a
 * handful of small text rows — SQLite was overkill.
 *
 * Note: background execution on Android is limited. If the app is fully killed,
 * draining happens on next foreground open — not a regression vs. navetted.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";

import { createLock, localId, sanitizeError } from "./asyncQueueUtils";
import {
  decryptPayload,
  encryptPayload,
  isEncryptedEnvelope,
} from "./queueCrypto";

import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  isPermanentError,
  isNotConfiguredError,
  isInsecureTransportError,
} from "./dispatcher";
import {
  writeIdea,
  appendJournal,
  writePerson,
  slugify,
  injectAttachments,
  injectPlaces,
  updateNoteIfUnchanged,
  type AttachmentRef,
  type Place,
} from "./writer";
import { mergeUserTags } from "./tags";
import { upsertFrontmatterField } from "./frontmatter";
import { invalidateNoteIndex } from "./vault";
import { getSettings } from "./settings";
import { captureVaultContext, isVaultContext, type VaultContext } from "./vaultContext";
import { resolveContextRoot } from "./vaultRoot";
import {
  DEFAULT_VAULT_PROFILE_ID,
  normaliseVaultProfileState,
  activeVaultProfile,
} from "./vaultProfiles";
import { deriveTitle } from "@carnet/shared";

/** Inject a `location: lat,lon` frontmatter field, or a no-op when unset. */
function injectLocation(markdown: string, location?: string): string {
  return location ? upsertFrontmatterField(markdown, "location", location) : markdown;
}

export type CaptureMode = "idea" | "journal" | "person";


/** Raw user input stored in the queue — no credentials. Attachments carry only
 * their `../{subdir}/{name}` rel-paths: the binaries are written to disk before
 * enqueue (local + offline-safe), so the queue stays small and never holds
 * base64 — same rule as "the API key is read fresh, never queued". */
export interface IdeaPayload {
  mode: "idea";
  text: string;
  attachments?: AttachmentRef[];
  /** User-entered tags, merged into frontmatter on drain (offline parity). */
  tags?: string[];
  /** User-selected `lat,lon`, injected into frontmatter on drain. */
  location?: string;
  /**
   * Save-first (B4): when set, the raw Idea note already exists on disk at this
   * path (written immediately on Save, before a transient enrichment failure
   * queued it). The drain then updates THIS file in place instead of creating a
   * new one — otherwise the drain would write a duplicate note. Absent for the
   * classic offline path where nothing was written before queuing.
   */
  filepath?: string;
  /** mtime baseline captured at the raw write, guarding the in-place overwrite
   * so a synced/user edit during the queue window isn't clobbered. */
  baselineMtime?: number | null;
  /** The raw note's exact bytes at that same write. SAF vaults report no mtime,
   * so this is what carries the guard there — see updateNoteIfUnchanged. */
  baselineContent?: string | null;
}

export interface JournalPayload {
  mode: "journal";
  transcript: string;
  notes: string;
  date: string;
  attachments?: AttachmentRef[];
  /** User-entered tags, merged into frontmatter on drain (offline parity). */
  tags?: string[];
  /** User-selected `lat,lon`, injected into frontmatter on drain. */
  location?: string;
  /** Named places for this entry, injected into its body on drain. Journal
   * only — Idea/Person captures have no places surface. */
  places?: Place[];
}

export interface PersonPayload {
  mode: "person";
  ocrResult: string;
  context: string;
  /** User-entered tags, merged into frontmatter on drain (offline parity). */
  tags?: string[];
  /** User-selected `lat,lon`, injected into frontmatter on drain. */
  location?: string;
}

/** Every new row records the vault root it belonged to when queued. */
export type QueuePayload = (IdeaPayload | JournalPayload | PersonPayload) & {
  vaultContext?: VaultContext;
};

export interface QueueRow {
  id: string;
  mode: CaptureMode;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

const QUEUE_KEY = "carnet:queue:v1";
/** Exported so UI surfaces (the sync-detail sheet) can classify a row as
 * permanently failed with the same threshold the drain uses — a duplicated
 * literal would silently drift if this cap changes. */
export const MAX_AUTO_RETRY_ATTEMPTS = 10;
/** Sentinel attempts value meaning "permanent failure — do not auto-retry".
 * Set when OmniRoute returns a 4xx (auth, bad model, malformed input). */
const PERMANENT_FAILURE_ATTEMPTS = MAX_AUTO_RETRY_ATTEMPTS;

/** Single-flight guard. CaptureScreen mounts re-trigger drainQueue and a
 * connectivity event could fire in parallel. Without this, two drains read
 * the same rows and both try to write — double-write to disk + double-charge
 * OmniRoute. */
let _draining = false;

// ── AsyncStorage-backed storage ──────────────────────────────────────────
// The queue is a JSON array of QueueRow under QUEUE_KEY. Mirrors storage.ts's
// recents-history persistence.

/** Read the queue, decrypting each row's payload.
 *
 * Rows are sealed at rest (see queueCrypto) but plaintext in memory — every
 * consumer below this line works with a normal `payload_json` string.
 *
 * Two kinds of unsealed row are passed through untouched rather than decrypted:
 *   - Legacy rows written before encryption shipped. They are still valid JSON
 *     and drain normally; the next `saveRows` seals them (see below), so the
 *     migration completes on the first write after upgrade with no separate
 *     migration step and no risk of dropping a queued capture.
 *   - Rows whose decryption fails (key rotated, reinstall, tampering). These
 *     keep their sealed text, which is not valid JSON, so `drainQueue`'s
 *     existing corrupt-row branch removes them. Reusing that path deliberately:
 *     a payload that cannot be read can never be processed, and inventing a
 *     second disposal policy here would just be a second thing to keep in sync. */
async function loadRows(): Promise<QueueRow[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  let parsed: QueueRow[];
  try {
    const candidate = JSON.parse(raw) as QueueRow[];
    if (!Array.isArray(candidate)) return [];
    parsed = candidate;
  } catch {
    return [];
  }
  return Promise.all(
    parsed.map(async (row) => {
      if (!isEncryptedEnvelope(row.payload_json)) return row;
      try {
        return { ...row, payload_json: await decryptPayload(row.payload_json) };
      } catch {
        return row;
      }
    }),
  );
}

/** Write the queue, sealing each row's payload.
 *
 * Only `payload_json` is sealed. The surrounding metadata — `mode`,
 * `created_at`, `attempts`, `last_error` — stays plaintext, which is a
 * deliberate call rather than an oversight: it lets the queue be counted,
 * sorted and triaged without touching the keystore, and it leaks only that a
 * capture of some kind happened and when, not its content. (`last_error` is
 * already run through sanitizeError, so it carries no credentials.) If the
 * capture MODE alone is ever considered sensitive — `person` implies a
 * business card was scanned — the envelope would need to cover the whole row.
 *
 * Encrypting here rather than at each call site means every write path —
 * enqueue, attempt bumps, removals — is covered by construction, and a new
 * caller cannot forget to encrypt. Already-sealed values are left alone so a
 * row that failed to decrypt is not double-wrapped; real payloads are
 * `JSON.stringify` output and so never collide with the envelope prefix. */
async function saveRows(rows: QueueRow[]): Promise<void> {
  const sealed = await Promise.all(
    rows.map(async (row) =>
      isEncryptedEnvelope(row.payload_json)
        ? row
        : { ...row, payload_json: await encryptPayload(row.payload_json) },
    ),
  );
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(sealed));
}

/** Serialize read-modify-write so a concurrent enqueue during a drain pass
 * (CaptureScreen mount drains while a new failed capture enqueues) can't lose a
 * row. This queue's own lock instance (see asyncQueueUtils.createLock). */
const withLock = createLock();

/** Remove a row by id (locked read-modify-write). */
function removeRow(id: string): Promise<void> {
  return withLock(async () => {
    const rows = await loadRows();
    await saveRows(rows.filter((r) => r.id !== id));
  });
}

/** Bump a row's attempt count + last_error by id (locked read-modify-write).
 * Computes the next attempts value from the freshly-loaded row (not a stale
 * drain snapshot), collapsing a permanent (4xx) failure to the sentinel. */
function bumpAttempts(
  id: string,
  permanent: boolean,
  last_error: string,
): Promise<void> {
  return withLock(async () => {
    const rows = await loadRows();
    const i = rows.findIndex((r) => r.id === id);
    if (i === -1) return;
    const attempts = permanent
      ? PERMANENT_FAILURE_ATTEMPTS
      : rows[i].attempts + 1;
    rows[i] = { ...rows[i], attempts, last_error };
    await saveRows(rows);
  });
}

/** Returns the current depth of the pending queue (excluding permanently failed). */
export async function getQueueDepth(): Promise<number> {
  const rows = await loadRows();
  return rows.filter((r) => r.attempts < MAX_AUTO_RETRY_ATTEMPTS).length;
}

/** Read-only snapshot of the queue rows — feeds the sync-detail sheet so it
 * can list what's waiting (mode, age, failure) without exposing the locked
 * mutation paths. */
export async function listQueueRows(): Promise<QueueRow[]> {
  const rows = await loadRows();
  return rows.map((r) => ({ ...r }));
}

/** Pending vs permanently-failed row counts in one read — feeds the sync
 * status indicator so it can distinguish "working through a backlog" from
 * "something needs your attention" without two storage round-trips. */
export async function getQueueCounts(): Promise<{
  pending: number;
  failed: number;
}> {
  const rows = await loadRows();
  let pending = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.attempts < MAX_AUTO_RETRY_ATTEMPTS) pending += 1;
    else failed += 1;
  }
  return { pending, failed };
}


/** Enqueue a failed capture for later retry. */
export async function enqueue(payload: QueuePayload): Promise<void> {
  // Capture the routing decision before taking the storage lock. A caller with
  // a longer-running operation supplies its earlier snapshot; the fallback
  // protects short paths such as notification capture.
  const vaultContext =
    payload.vaultContext ?? captureVaultContext(await getSettings());
  const queuedPayload: QueuePayload = { ...payload, vaultContext };
  await withLock(async () => {
    const rows = await loadRows();
    rows.push({
      id: localId(),
      mode: payload.mode,
      payload_json: JSON.stringify(queuedPayload),
      created_at: Date.now(),
      attempts: 0,
      last_error: null,
    });
    await saveRows(rows);
  });
  // Light haptic so the user feels the offline queue accept the capture.
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** Map a pre-profile row to the migrated default vault, never a later switch. */
function legacyQueueContext(settings: Awaited<ReturnType<typeof getSettings>>): VaultContext {
  const state = normaliseVaultProfileState({
    profiles: settings.vaultProfiles,
    activeProfileId: settings.activeVaultProfileId,
    legacyCaptureFolderPath: settings.captureFolderPath,
  });
  const profile =
    state.profiles.find((candidate) => candidate.id === DEFAULT_VAULT_PROFILE_ID) ??
    activeVaultProfile(state);
  return { profileId: profile.id, rootUri: profile.rootUri };
}

/**
 * Drain the queue: process all pending captures oldest-first.
 * Resolves when the drain pass is complete (or queue is empty).
 * Each successful item writes its file and removes the row.
 *
 * Single-flight: parallel callers are a no-op once one drain is in flight.
 * Errors are classified — 4xx from OmniRoute marks the row as permanent
 * failure (won't auto-retry), network/5xx increments attempts normally.
 */
export async function drainQueue(): Promise<void> {
  if (_draining) return;
  _draining = true;
  try {
    const rows = (await loadRows())
      .filter((r) => r.attempts < MAX_AUTO_RETRY_ATTEMPTS)
      .sort((a, b) => a.created_at - b.created_at);

    for (const row of rows) {
      let payload: QueuePayload;
      try {
        payload = JSON.parse(row.payload_json) as QueuePayload;
      } catch {
        // Corrupt row — remove it
        await removeRow(row.id);
        continue;
      }

      try {
        await processRow(payload);
        // Success: remove from queue
        await removeRow(row.id);
      } catch (e: unknown) {
        // Blank OmniRoute URL: every remaining row would fail identically.
        // Stop the pass and leave all rows intact — do NOT burn retry attempts
        // (which would eventually mark genuine captures permanently failed).
        // They'll drain on the next open once the user sets a URL.
        //
        // A plain-http remote URL is the same shape of problem: the request is
        // rejected before it leaves the device and no number of drains will
        // change that until Settings do, so it takes the same break rather
        // than burning attempts down to a permanent failure.
        if (isNotConfiguredError(e) || isInsecureTransportError(e)) break;
        const raw = e instanceof Error ? e.message : String(e);
        const msg = sanitizeError(raw);
        // 4xx → mark as permanent failure immediately. Retrying a 401 ten
        // times in seconds doesn't help — the user needs to fix the cause.
        // The attempts increment is computed inside the lock from the current
        // row, not this drain's snapshot.
        await bumpAttempts(row.id, isPermanentError(e), msg);
      }
    }
  } finally {
    _draining = false;
  }
}

/** Process a single queued payload: enrich + write to disk. */
async function processRow(payload: QueuePayload): Promise<void> {
  // Legacy rows have no context. Their pre-profile settings root is normalized
  // to the default registration, not reinterpreted as whichever profile the
  // user selected after upgrading.
  const vaultContext = payload.vaultContext && isVaultContext(payload.vaultContext)
    ? payload.vaultContext
    : legacyQueueContext(await getSettings());
  const root = resolveContextRoot(vaultContext);
  if (payload.mode === "idea") {
    const result = await enrichIdea(payload.text);
    // Binaries were already written to disk at enqueue; fold their rel-paths
    // back into the body so the drained note matches the online capture.
    // Tags are merged AFTER attachments so the frontmatter merge sees the final body.
    const md = injectLocation(
      mergeUserTags(injectAttachments(result.markdown, payload.attachments ?? []), payload.tags),
      payload.location,
    );
    if (payload.filepath) {
      // Save-first: the raw note is already on disk — update it in place,
      // guarded so a synced/user edit during the queue window is kept rather
      // than clobbered. A skipped write (conflict) still counts as processed;
      // the raw note stays and the user's edit wins.
      await updateNoteIfUnchanged(
        payload.filepath,
        md,
        payload.baselineMtime ?? null,
        payload.baselineContent ?? null,
      );
    } else {
      const title = deriveTitle(result.markdown);
      const slug = slugify(title) || "untitled";
      await writeIdea(slug, md, root);
    }
  } else if (payload.mode === "journal") {
    const result = await enrichJournal({
      transcript: payload.transcript,
      notes: payload.notes,
    });
    // Same compose order as the online path (confirmSaveJournal): places go in
    // last, on this entry's own fragment, before appendJournal accumulates it.
    const md = injectPlaces(
      injectLocation(
        mergeUserTags(injectAttachments(result.markdown, payload.attachments ?? []), payload.tags),
        payload.location,
      ),
      payload.places ?? [],
    );
    await appendJournal(payload.date, md, root);
  } else if (payload.mode === "person") {
    const result = await enrichPerson({
      ocrResult: payload.ocrResult,
      context: payload.context,
    });
    // Extract name — pass empty strings to writePerson so it falls back to markdown
    await writePerson(
      "",
      "",
      injectLocation(mergeUserTags(result.markdown, payload.tags), payload.location),
      root,
    );
  }
  // A drained capture adds tags to the vault — drop the stale index cache so the
  // browser + autocomplete rebuild. Best-effort; never fail the drain on this.
  void invalidateNoteIndex().catch(() => undefined);
}

/**
 * Returns all rows including permanently-failed ones (for debugging / admin).
 */
export async function getAllQueueRows(): Promise<QueueRow[]> {
  const rows = await loadRows();
  return [...rows].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Clear all permanently-failed rows (attempts >= MAX_AUTO_RETRY_ATTEMPTS).
 */
export async function clearFailedRows(): Promise<void> {
  await withLock(async () => {
    const rows = await loadRows();
    await saveRows(rows.filter((r) => r.attempts < MAX_AUTO_RETRY_ATTEMPTS));
  });
}
