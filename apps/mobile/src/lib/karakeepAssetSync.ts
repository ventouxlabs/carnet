// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Per-bookmark record of which local attachments have already been uploaded +
// attached to a Karakeep bookmark, AND the Karakeep assetId each one got. The
// assetId is what lets a re-export rebuild the `/api/assets/{id}` URL for an
// already-synced image so the bookmark body keeps its inline embeds — without
// re-uploading. So a re-export pushes ONLY the not-yet-synced attachments (one
// added after the first export, or one that failed earlier) and never
// duplicates an asset already on the server.
//
// Backed by AsyncStorage rather than note frontmatter: frontmatter scalar values
// can't hold newlines and split on commas, which is unsafe for the file paths we
// track here (see frontmatter.ts). Mirrors queue.ts's JSON-under-one-key
// persistence — one key per bookmark, value = `{ assetKey: assetId }`.

import AsyncStorage from "@react-native-async-storage/async-storage";

const ASSET_SYNC_KEY_PREFIX = "carnet:karakeep-assets:v1:";

function storageKey(bookmarkId: string): string {
  return `${ASSET_SYNC_KEY_PREFIX}${bookmarkId}`;
}

/**
 * The stable key tracked per attachment against a bookmark: the note-relative
 * `{subdir}/{filename}`. A filename is a single path segment (no slashes — see
 * the PAIRED_BINARY_LINK capture in writer.ts), so this is unique and
 * collision-free across a note's attachments.
 *
 * Identity is by path, not content: replacing a file's bytes under the same
 * name is NOT detected as a change (an accepted limitation for this slice —
 * Karakeep assets are immutable uploads anyway).
 */
export function assetKey(subdir: string, filename: string): string {
  return `${subdir}/${filename}`;
}

/**
 * Load the map of attachment key → Karakeep assetId already synced to
 * `bookmarkId`. Returns an empty map on a miss, a corrupt (non-JSON) value, or
 * an unrecognized payload shape.
 *
 * Tolerates the LEGACY shape (a JSON array of keys, written before assetIds were
 * tracked): each legacy key maps to `""` — a known-but-assetId-unknown marker.
 * The export treats an empty assetId as "not synced yet" and re-uploads it once
 * to capture the assetId, after which it persists in the new object shape. That
 * one-time re-upload (a duplicate asset on that bookmark — wasteful, never
 * corrupting) is the documented cost of the upgrade.
 *
 * De-duplication against the server depends ENTIRELY on this local record: if it
 * is lost (corrupt / cleared / reinstall), the next export re-uploads the same
 * bytes as fresh assets. Failing open to "nothing synced yet" keeps the export
 * working; it is not a server-side idempotency guarantee.
 */
export async function loadPushedAssets(
  bookmarkId: string,
): Promise<Map<string, string>> {
  const raw = await AsyncStorage.getItem(storageKey(bookmarkId));
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Legacy v1: a JSON array of keys, no assetIds → map each to "".
    if (Array.isArray(parsed)) {
      return new Map(
        parsed
          .filter((k): k is string => typeof k === "string")
          .map((k) => [k, ""] as const),
      );
    }
    // Current: `{ key: assetId }`. Keep only string→string entries.
    if (parsed && typeof parsed === "object") {
      const out = new Map<string, string>();
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out.set(k, v);
      }
      return out;
    }
    return new Map();
  } catch {
    return new Map();
  }
}

/** Persist the full key → assetId map for `bookmarkId`. */
export async function savePushedAssets(
  bookmarkId: string,
  assets: ReadonlyMap<string, string>,
): Promise<void> {
  await AsyncStorage.setItem(
    storageKey(bookmarkId),
    JSON.stringify(Object.fromEntries(assets)),
  );
}

/**
 * Forget a bookmark's entire sync record. Used when the bookmark was deleted
 * server-side and recreated under a NEW id (the old id's record is dead, never
 * read again) — clearing it stops AsyncStorage accumulating orphaned records
 * across the app's lifetime. Best-effort: callers fire-and-forget.
 */
export async function clearPushedAssets(bookmarkId: string): Promise<void> {
  await AsyncStorage.removeItem(storageKey(bookmarkId));
}
