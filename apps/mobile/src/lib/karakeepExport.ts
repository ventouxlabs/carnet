// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

// Orchestrates pushing a note's local attachments to Karakeep as assets and
// attaching each to the note's text bookmark. Kept OUT of the karakeep network
// client (which stays writer/vault-free) because resolving a note's `../Subdir/
// file` links to storage URIs needs the writer layer.

import { listPairedBinaries, resolvePairedUri } from "./writer";
import {
  assetContentPath,
  attachAssetToBookmark,
  uploadAsset,
  BANNER_ASSET_TYPE,
} from "./karakeep";
import {
  assetKey,
  loadPushedAssets,
  savePushedAssets,
} from "./karakeepAssetSync";

/**
 * Incrementally sync a note's image/file attachments to its Karakeep bookmark:
 * upload + attach only the ones NOT already on this bookmark, skipping the rest.
 *
 * Designed to run on EVERY export (create AND re-export). A per-bookmark sync
 * record ({@link loadPushedAssets}) is consulted so:
 * - already-attached files are skipped → a re-export never duplicates assets;
 * - an attachment added after the first export is picked up on the next one;
 * - an attachment that FAILED earlier is retried (it was never recorded).
 *
 * - **Audio is skipped** — Karakeep isn't an audio archive, and carnet plays
 *   audio in its own dedicated player.
 * - **Broken links are skipped silently** (and NOT recorded) — a `../Photos/x`
 *   whose file was moved/renamed externally resolves to null; if the file later
 *   returns, a subsequent export pushes it.
 * - **Stops at the first upload/attach failure** rather than hammering a dead
 *   host once per file, returning that error message. Every asset that
 *   succeeded BEFORE the failure is already recorded (persisted per success),
 *   so it is not re-pushed on retry.
 *
 * Returns {@link PushAttachmentsResult}: `error` is null on success (including
 * the no-attachments / nothing-new case) or the first error message — the caller
 * surfaces it WITHOUT losing the already-saved bookmark — and `imageUrlByRel`
 * maps each synced image's `../Photos/<file>` link to its `/api/assets/{id}` URL
 * so the caller can rewrite the bookmark body to render the images INLINE (the
 * vault note keeps its relative links — issue #43). This never throws: a
 * per-file resolve/upload/attach error is caught and returned, so the export
 * flow can always finish stamping the bookmark id.
 */
export interface PushAttachmentsResult {
  /** First upload/attach error message, or null when all (new) attachments
   * succeeded — including the no-attachments / nothing-new case. */
  error: string | null;
  /** `../Photos/<file>` rel → its Karakeep asset URL path (`/api/assets/{id}`),
   * for every IMAGE that is now synced — uploaded this run OR recorded from a
   * prior export. The caller rewrites the bookmark body with these so the images
   * render inline. Files/Audio are excluded (not inlined). On a partial failure
   * this holds every image synced BEFORE the failure. */
  imageUrlByRel: Map<string, string>;
  /** Filenames Karakeep refused with its "Unsupported asset type" 400 (its
   * upload allowlist is essentially images + PDF). These stay vault-only. NOT
   * counted as `error` (the export itself succeeded) and NOT recorded in the
   * sync record — deliberately, so a server upgrade that widens the allowlist
   * picks them up on a later export. The caller surfaces them as an
   * informational notice, not a failure. */
  unsupportedFilenames: string[];
}

/**
 * Karakeep's per-file rejection for a MIME type outside its upload allowlist:
 * `POST /api/v1/assets` → 400 `{"error":"Unsupported asset type"}`
 * (karakeep `packages/api/utils/upload.ts`). Deterministic and permanent for
 * that file type on that server — treated as a per-file skip, never a
 * loop-stopping failure. Duck-typed on `{status, message}` rather than
 * `instanceof KarakeepError` so it stays trivially constructible in tests.
 */
export function isUnsupportedAssetTypeError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e as { status?: unknown }).status === 400 &&
    /unsupported asset type/i.test(e.message)
  );
}

export async function pushNoteAttachments(
  bookmarkId: string,
  noteBody: string,
): Promise<PushAttachmentsResult> {
  // Load → mutate in memory → persist. Safe without a lock because exports are
  // single-flighted by the caller (RecentDetailScreen's exportingKarakeepRef),
  // so no second run races this bookmark's record.
  const pushed = await loadPushedAssets(bookmarkId);
  const links = listPairedBinaries(noteBody).filter((b) => b.subdir !== "Audio");
  // The note's FIRST image becomes the bookmark cover (bannerImage) — Karakeep
  // renders that as the cover on a text bookmark. Remaining images + files stay
  // userUploaded. Deterministic by note order, not push order; if the lead image
  // was already synced (skipped), the cover isn't re-applied on re-export.
  // If the lead image itself gets skipped as an unsupported type, the banner is
  // NOT reassigned to the next image — the bookmark simply has no cover
  // (accepted degradation; the images still render inline in the body).
  const firstImage = links.find((b) => b.subdir === "Photos");
  const bannerKey = firstImage
    ? assetKey(firstImage.subdir, firstImage.filename)
    : null;
  // rel → /api/assets/{id} for every synced IMAGE, so the caller can inline the
  // bookmark body. Filled for both already-synced (recorded assetId) and freshly
  // uploaded images.
  const imageUrlByRel = new Map<string, string>();
  const unsupportedFilenames: string[] = [];
  for (const link of links) {
    const key = assetKey(link.subdir, link.filename);
    const recordedAssetId = pushed.get(key);
    if (recordedAssetId) {
      // Already attached to this bookmark — skip the upload, but reuse the
      // recorded assetId so a re-export keeps the image inlined in the body.
      if (link.subdir === "Photos") {
        imageUrlByRel.set(link.rel, assetContentPath(recordedAssetId));
      }
      continue;
    }
    try {
      const resolved = await resolvePairedUri(link.subdir, link.filename);
      if (!resolved) continue; // file moved/renamed externally — skip (not recorded)
      const { assetId } = await uploadAsset({
        uri: resolved.uri,
        mime: resolved.mime,
        filename: link.filename,
      });
      if (key === bannerKey) {
        await attachAssetToBookmark(bookmarkId, assetId, BANNER_ASSET_TYPE);
      } else {
        await attachAssetToBookmark(bookmarkId, assetId);
      }
      pushed.set(key, assetId);
      if (link.subdir === "Photos") {
        imageUrlByRel.set(link.rel, assetContentPath(assetId));
      }
      // Persist after EACH success (a fresh snapshot, not the live map) so a
      // later failure in this same loop can't lose the record — those assets must
      // not be re-pushed (no duplicates), while unreached/failed ones stay
      // unrecorded and retry next export.
      await savePushedAssets(bookmarkId, new Map(pushed));
    } catch (e: unknown) {
      // Karakeep's upload allowlist rejected this file's MIME type — a
      // permanent per-file condition, not a sync failure. Skip it (vault-only),
      // keep pushing the remaining attachments, and report it separately so the
      // UI can say so without sounding like an error. Not recorded: a server
      // upgrade that accepts the type will push it on a later export.
      if (isUnsupportedAssetTypeError(e)) {
        unsupportedFilenames.push(link.filename);
        continue;
      }
      return {
        error: e instanceof Error ? e.message : String(e),
        imageUrlByRel,
        unsupportedFilenames,
      };
    }
  }
  return { error: null, imageUrlByRel, unsupportedFilenames };
}
