// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Karakeep note-export decision logic, lifted out of RecentDetailScreen so the
 * dense create-vs-update / 404-recovery / tag-and-title derivation is unit
 * testable without a renderer. The screen keeps only the in-flight/mounted
 * guards and the setState wiring; everything decidable about "given this note,
 * what bookmark should exist and what should the note become" lives here.
 *
 * The network calls (create/update bookmark, attach tags, push assets) and the
 * in-place note rewrite happen here too — mirroring lib/ideaSaveFirst.ts's async
 * orchestrators (enrichIdeaInPlace) — so a test can drive every branch by
 * mocking the karakeep client + karakeepExport modules.
 */

import { deriveTitle } from "@carnet/shared";
import {
  extractFrontmatterField,
  getFrontmatterTags,
  parseFrontmatter,
  splitFrontmatter,
  upsertFrontmatterField,
} from "./frontmatter";
import { updateNote } from "./writer";
import {
  attachTags,
  createTextBookmark,
  updateTextBookmark,
  KarakeepError,
} from "./karakeep";
import { pushNoteAttachments } from "./karakeepExport";
import { rewriteImageEmbedsToAssetUrls } from "./karakeepInlineImages";
import { clearPushedAssets } from "./karakeepAssetSync";

/** The bookmark-shaping fields derived from a note before any network call. */
export interface KarakeepExportFields {
  /** Note H1 → filename-stem fallback (deriveTitle guards empty/whitespace). */
  title: string;
  /** Frontmatter tags + the `kind` tag, order-preserving and deduped. */
  tags: string[];
  /** The note's `created` frontmatter value, or undefined when absent. */
  createdAt: string | undefined;
  /** The frontmatter block (with trailing `---\n`), for byte-exact reattach. */
  header: string;
  /** The note body with frontmatter stripped — the bookmark text. */
  noteBody: string;
  /** A previously-stamped `karakeepId`, or null for a first export. */
  existingId: string | null;
}

/**
 * Derive the bookmark title, tags, createdAt, and existing-id from a note's full
 * markdown. Pure — the single densest decision in the export flow.
 *
 * Title: the note's H1, falling back to the filename stem (then the entry title)
 * when the H1 is empty/whitespace. Tags: the frontmatter tags plus a `kind` tag
 * (idea/journal/person/…), deduped while preserving order.
 */
export function deriveKarakeepExportFields(
  body: string,
  filepath: string,
  entryTitle: string,
): KarakeepExportFields {
  const { header, body: noteBody } = splitFrontmatter(body);
  const stem =
    filepath
      .split("/")
      .pop()
      ?.replace(/\.md$/i, "") ?? entryTitle;
  const title = deriveTitle(noteBody).trim() || stem;
  const fmTags = getFrontmatterTags(body);
  const kindField = parseFrontmatter(body).fields.find(([k]) => k === "kind");
  const kindTag = kindField?.[1]?.trim() ?? "";
  const tags = [...new Set([...fmTags, ...(kindTag ? [kindTag] : [])])];
  const createdAt = extractFrontmatterField(body, "created") ?? undefined;
  const existingId = extractFrontmatterField(body, "karakeepId");
  return { title, tags, createdAt, header, noteBody, existingId };
}

/**
 * Outcome of an export attempt, translated by the screen into UI state:
 *   - exported: the bookmark was created/updated cleanly. `nextBody` is the note
 *     re-stamped with its `karakeepId`; `didUpdate` drives the snackbar copy.
 *   - partial:  the bookmark was saved + stamped, but an attachment push failed.
 *     `nextBody` still holds the stamped note (a re-export should update it).
 *   - failed:   the export threw before the bookmark was saved; nothing changed.
 */
export type KarakeepExportOutcome =
  /** `skippedUnsupported` (on both success kinds): attachment filenames
   * Karakeep refused as an unsupported asset type — kept vault-only, surfaced
   * as an informational notice, never a failure. Empty when all types were
   * accepted. See {@link PushAttachmentsResult.unsupportedFilenames}. */
  | {
      kind: "exported";
      nextBody: string;
      didUpdate: boolean;
      skippedUnsupported: string[];
    }
  | {
      kind: "partial";
      nextBody: string;
      assetError: string;
      skippedUnsupported: string[];
    }
  /** `unreachable` (on failed): the host never answered (status-0 network
   * failure, not a blank-URL misconfig) — the screen queues the export for a
   * connectivity retry (lib/pendingSync.ts) instead of showing an error. */
  | { kind: "failed"; reason: string; unreachable: boolean };

/**
 * Export a note to Karakeep as a text bookmark and return an outcome the screen
 * applies to its state. When the note already carries a `karakeepId`, the
 * existing bookmark is UPDATED in place; if that id was deleted server-side
 * (404) a fresh bookmark is created and the stale asset-sync record dropped.
 * The resulting id is stamped back into the note frontmatter for idempotency.
 *
 * ACCEPTED LIMITATIONS (preserved verbatim from the original screen logic):
 *   - A 404 from a *misconfigured* base URL is indistinguishable from a deleted
 *     bookmark, so it would create a duplicate. Bounded (one recoverable
 *     bookmark, requires misconfig); disambiguating needs a confirming GET.
 *   - attachTags is additive: a re-export re-attaches current tags but does NOT
 *     detach tags removed from the note since the first export.
 *   - A connection drop MID-EXPORT (create succeeded, then attachTags/asset
 *     push died with status 0, before the karakeepId stamp) reads as
 *     failed+unreachable, so the pending-sync queue (lib/pendingSync.ts)
 *     retries an UNSTAMPED note and creates a duplicate bookmark. Bounded to
 *     one duplicate per mid-export drop, and identical to what a manual
 *     re-tap always did — the queue just automates that retry. Fixing it
 *     means stamping the id immediately after create/update instead of after
 *     the asset push.
 */
export async function exportNoteToKarakeep(input: {
  body: string;
  filepath: string;
  entryTitle: string;
}): Promise<KarakeepExportOutcome> {
  try {
    const { title, tags, createdAt, header, noteBody, existingId } =
      deriveKarakeepExportFields(input.body, input.filepath, input.entryTitle);

    let id: string;
    let didUpdate = false;
    if (existingId) {
      try {
        ({ id } = await updateTextBookmark(existingId, {
          text: noteBody,
          title,
          createdAt,
        }));
        didUpdate = true;
      } catch (e: unknown) {
        // The stored id points at a bookmark that no longer exists on the
        // server — recover by creating a fresh one and re-stamping the id.
        if (e instanceof KarakeepError && e.status === 404) {
          ({ id } = await createTextBookmark({ text: noteBody, title, createdAt }));
          // The old bookmark is gone; its asset-sync record is dead. Drop it so
          // AsyncStorage doesn't accumulate orphans, and so the fresh bookmark's
          // (empty) record drives a full re-push of attachments below.
          void clearPushedAssets(existingId);
        } else {
          throw e;
        }
      }
    } else {
      ({ id } = await createTextBookmark({ text: noteBody, title, createdAt }));
    }
    await attachTags(id, tags);

    // Incrementally sync attachments (create + re-export); already-attached files
    // are skipped so Karakeep never accumulates duplicates on re-send. Returns
    // the first error (or null); a partial failure still stamps the bookmark.
    const {
      error: assetError,
      imageUrlByRel,
      unsupportedFilenames,
    } = await pushNoteAttachments(id, noteBody);

    // Inline the note's images into the Karakeep bookmark BODY: rewrite each
    // ../Photos embed to its uploaded asset URL so the images render in-content.
    // The VAULT note keeps its relative links — only this Karakeep copy is
    // inlined. Best-effort: the bookmark already holds the original text +
    // attached assets, so a failed inline PATCH never loses the export.
    const inlinedBody = rewriteImageEmbedsToAssetUrls(noteBody, imageUrlByRel);
    if (inlinedBody !== noteBody) {
      try {
        await updateTextBookmark(id, { text: inlinedBody, title, createdAt });
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(
          "[RecentDetail] Karakeep inline-image body update failed:",
          reason,
        );
      }
    }

    // Idempotency: stamp the bookmark id into the note frontmatter (a no-op
    // rewrite on update). Stamped even when an attachment failed — the bookmark
    // exists, so a re-export should update it rather than create a second one.
    const next = upsertFrontmatterField(header + noteBody, "karakeepId", id);
    await updateNote(input.filepath, next);
    if (assetError) {
      return {
        kind: "partial",
        nextBody: next,
        assetError,
        skippedUnsupported: unsupportedFilenames,
      };
    }
    return {
      kind: "exported",
      nextBody: next,
      didUpdate,
      skippedUnsupported: unsupportedFilenames,
    };
  } catch (e: unknown) {
    const reason =
      e instanceof KarakeepError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    const unreachable =
      e instanceof KarakeepError && e.status === 0 && !e.notConfigured;
    console.warn("[RecentDetail] Karakeep export failed:", reason);
    return { kind: "failed", reason, unreachable };
  }
}
