/**
 * Pending-sync queue for Karakeep exports.
 *
 * When a note export fails because the HOST is unreachable (VPN/Tailscale
 * down, DNS, timeout — a status-0 network failure, never a 4xx/5xx answer),
 * the export is queued here and retried when the app foregrounds and the host
 * answers a reachability probe (lib/hostReachability.ts).
 *
 * Deliberately separate from lib/queue.ts: that queue holds RAW CAPTURES
 * waiting on OmniRoute enrichment; this one holds POINTERS to notes already
 * safe on disk, waiting on Karakeep. A pending export stores only
 * `{filepath, entryTitle}` — the note body is re-read at drain time so the
 * freshest text is exported, and a note edited (or deleted) during the queue
 * window behaves correctly for free.
 *
 * Storage mirrors queue.ts: a JSON array under one AsyncStorage key, with a
 * promise-chain lock serializing read-modify-write (no SQLite — see queue.ts's
 * header for why). Drain orchestration takes INJECTED deps so it's unit
 * testable without network or filesystem; lib/pendingSyncRunner.ts binds the
 * real ones.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import { createLock, localId, sanitizeError } from "./asyncQueueUtils";
import { isVaultContext, type VaultContext } from "./vaultContext";

/** A queued export. `kind` is future-proofing — only Karakeep exports queue
 * today, but the drain/storage layer doesn't care what the item means. */
export interface PendingExport {
  id: string;
  kind: "karakeep-export";
  /** Vault URI of the note to export (file:// or SAF content://). */
  filepath: string;
  /** History-entry title, forwarded to the export's filename-stem fallback. */
  entryTitle: string;
  /** Frozen source vault for resolving this note's attachment links at drain time. */
  vaultContext?: VaultContext;
  queuedAt: number;
  attempts: number;
  lastError: string | null;
}

const PENDING_SYNC_KEY = "carnet:pendingsync:v1";

/** Attempts cap for a queued export that keeps failing with a REAL error
 * (not unreachability — those never burn attempts). Matches queue.ts's cap. */
export const MAX_PENDING_EXPORT_ATTEMPTS = 10;

// ── Storage (mirrors queue.ts) ───────────────────────────────────────────────

async function loadItems(): Promise<PendingExport[]> {
  const raw = await AsyncStorage.getItem(PENDING_SYNC_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PendingExport[];
    // v1 records predate multi-vault context. Keep them drainable through the
    // current-profile fallback in the runner, but reject malformed new fields.
    return Array.isArray(parsed)
      ? parsed.map((item) => ({
          ...item,
          ...(isVaultContext(item.vaultContext) ? { vaultContext: item.vaultContext } : {}),
        }))
      : [];
  } catch {
    return [];
  }
}

async function saveItems(items: PendingExport[]): Promise<void> {
  await AsyncStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(items));
}

/** Serialize read-modify-write — an enqueue during a drain pass must not lose
 * an item. This queue's own lock instance (see asyncQueueUtils.createLock). */
const withLock = createLock();

// WHAT queues: only a status-0 network failure that isn't a blank-URL
// misconfig — the "VPN/Tailscale is down" class, where no HTTP response ever
// arrived. A real status (4xx/5xx) is an ANSWER and never queues; retrying a
// not-configured error can't fix Settings, the user has to. That
// classification lives at the throw site — karakeepNoteExport's failed
// outcome carries `unreachable: boolean` (typed against KarakeepError) — so
// this module stays a pure queue with no client import.

// ── Change notification ──────────────────────────────────────────────────────
// The Home banner reads the queue count on focus, but the App.tsx foreground
// drain mutates the queue while Home is ALREADY focused — without a change
// signal the banner shows a stale count until the next refocus (confirmed
// on-device 2026-07-16). Mutations notify subscribers after their locked
// write completes; UI re-reads the count in response. Deliberately a bare
// "something changed" ping, not a payload — the read path stays the single
// source of truth.

type PendingSyncListener = () => void;
const _listeners = new Set<PendingSyncListener>();

/** Subscribe to queue mutations (enqueue / drain removals / attempt bumps).
 * Returns the unsubscribe function. Callbacks must not throw — they're
 * invoked best-effort after storage writes and are isolated per listener. */
export function subscribePendingSyncChanges(
  listener: PendingSyncListener,
): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

function notifyChanged(): void {
  for (const listener of _listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not break the queue or its siblings.
    }
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Queue a note for export once the host is reachable again. Deduped by
 * filepath: re-queuing an already-queued note refreshes its title (the note
 * may have been renamed) but keeps its place and attempt count — the drain
 * re-reads the body from disk anyway, so one row per note is always enough.
 */
export async function enqueuePendingExport(input: {
  filepath: string;
  entryTitle: string;
  vaultContext?: VaultContext;
}): Promise<void> {
  await withLock(async () => {
    const items = await loadItems();
    const existing = items.findIndex((i) => i.filepath === input.filepath);
    if (existing !== -1) {
      const next = [...items];
      next[existing] = {
        ...next[existing],
        entryTitle: input.entryTitle,
        vaultContext: input.vaultContext,
      };
      await saveItems(next);
      return;
    }
    await saveItems([
      ...items,
      {
        id: localId(),
        kind: "karakeep-export",
        filepath: input.filepath,
        entryTitle: input.entryTitle,
        vaultContext: input.vaultContext,
        queuedAt: Date.now(),
        attempts: 0,
        lastError: null,
      },
    ]);
  });
  notifyChanged();
}

/** Read-only snapshot, oldest-first — feeds the Home banner + drain pass. */
export async function listPendingExports(): Promise<PendingExport[]> {
  const items = await loadItems();
  return items.map((i) => ({ ...i })).sort((a, b) => a.queuedAt - b.queuedAt);
}

/** How many exports are waiting — drives the Home banner's visibility. */
export async function getPendingExportCount(): Promise<number> {
  return (await loadItems()).length;
}

async function removeItem(id: string): Promise<void> {
  await withLock(async () => {
    const items = await loadItems();
    await saveItems(items.filter((i) => i.id !== id));
  });
  notifyChanged();
}

/** Bump an item's attempt count (computed inside the lock from the fresh row,
 * not the drain's snapshot); drop the item entirely once it hits the cap —
 * the note stays safe in the vault, only the auto-retry gives up. */
async function bumpAttemptsOrDrop(id: string, lastError: string): Promise<void> {
  await withLock(async () => {
    const items = await loadItems();
    const i = items.findIndex((item) => item.id === id);
    if (i === -1) return;
    const attempts = items[i].attempts + 1;
    if (attempts >= MAX_PENDING_EXPORT_ATTEMPTS) {
      await saveItems(items.filter((item) => item.id !== id));
      return;
    }
    const next = [...items];
    next[i] = { ...next[i], attempts, lastError: sanitizeError(lastError) };
    await saveItems(next);
  });
  notifyChanged();
}

// ── Drain ────────────────────────────────────────────────────────────────────

/** What happened to one item during a drain pass. */
export type PendingExportResult =
  /** Export landed (fully or partially — the bookmark exists either way). */
  | { kind: "ok" }
  /** The host stopped answering — end the pass, touch nothing. */
  | { kind: "unreachable" }
  /** The note no longer exists on disk — drop the item. */
  | { kind: "gone" }
  /** A real failure (the server answered with an error) — burns an attempt. */
  | { kind: "error"; message: string };

/** Injected drain dependencies — see lib/pendingSyncRunner.ts for the real
 * bindings. Injection keeps every drain branch unit-testable. */
export interface PendingSyncDrainDeps {
  /** Probe the export host. False ends the pass before any export runs. */
  isReachable: () => Promise<boolean>;
  /** Attempt one queued export and classify what happened. */
  exportOne: (item: PendingExport) => Promise<PendingExportResult>;
}

/** Single-flight guard — AppState 'active' and the Home Retry button can fire
 * near-simultaneously; a second concurrent drain would double-export. */
let _draining = false;

/**
 * Drain the pending-export queue oldest-first.
 *
 *   - Empty queue: returns without probing the host.
 *   - Host unreachable (probe, or an `unreachable` result mid-pass): stop
 *     immediately, leave every remaining item untouched — connectivity is not
 *     the items' fault, so no attempts are burned.
 *   - `ok` / `gone`: remove the item.
 *   - `error`: bump attempts (drop at {@link MAX_PENDING_EXPORT_ATTEMPTS}),
 *     keep going — one bad note must not block the rest.
 */
export async function drainPendingExports(
  deps: PendingSyncDrainDeps,
): Promise<void> {
  if (_draining) return;
  _draining = true;
  try {
    const items = await listPendingExports();
    if (items.length === 0) return;
    if (!(await deps.isReachable())) return;

    for (const item of items) {
      const result = await deps.exportOne(item);
      if (result.kind === "unreachable") return;
      if (result.kind === "ok" || result.kind === "gone") {
        await removeItem(item.id);
      } else {
        await bumpAttemptsOrDrop(item.id, result.message);
      }
    }
  } finally {
    _draining = false;
  }
}
