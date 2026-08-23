// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finish the enrichment of a save-first Idea that never got enriched.
 *
 * A capture made while the provider is unreachable is written raw and queued
 * (`status: pending-enrich`). Normally the queue drains and overwrites the note
 * with the enriched version. But `queue.ts`'s drain deliberately treats a
 * conflicted write as processed — "a skipped write still counts as processed;
 * the raw note stays and the user's edit wins" — and then removes the row. So
 * if the file changed during the queue window (a WYSIWYG edit, a Syncthing
 * write from the workstation, or an Enhance run, which guarantees it), the
 * enrichment is computed, discarded, and the row is gone.
 *
 * The note is then stuck: no title, no tags, a permanent `pending` chip, and
 * nothing left to retry it. `noteReprocess.reEnrichNote` cannot help — it
 * requires a paired image on disk and is gated to photo/shared-image notes, so
 * a text Idea (exactly what queues offline) has no path at all.
 *
 * This is that path. It is user-initiated, never automatic: the drain already
 * decided not to overwrite, and re-deciding that on the user's behalf is the
 * clobber this codebase guards against everywhere else.
 */

import { getFrontmatterTags, extractFrontmatterField, stripFrontmatter } from "./frontmatter";
import { enrichIdeaInPlace, PENDING_ENRICH_STATUS, type EnrichIdeaOutcome } from "./ideaSaveFirst";
import { enrichPersonInPlace, type EnrichInPlaceOutcome } from "./personInPlace";
import type { CaptureMode } from "./storage";
import {
  getModificationTime,
  listPairedBinaries,
  readNote,
  type AttachmentRef,
} from "./writer";

/**
 * Re-derive a note's attachment refs from its own body.
 *
 * Enrichment replaces the whole file, and `applyEnrichedIdea` re-injects only
 * the attachments it is handed — so anything not passed here is stripped from
 * the note (the binaries survive on disk, unreferenced). The embeds are the
 * only record of them at this point: nothing tracks attachments in frontmatter.
 * `Photos` is the only subdir the image path writes to (see
 * attachmentPersistence.ts); anything else round-trips as a `## Files` link.
 */
function attachmentsFromBody(body: string): AttachmentRef[] {
  return listPairedBinaries(body).map((b): AttachmentRef => ({
    kind: b.subdir === "Photos" ? "image" : "file",
    rel: b.rel,
    filename: b.filename,
  }));
}

/**
 * Outcome of finishing a stalled enrichment. Mirrors `EnhanceProseOutcome` and
 * `ReprocessOutcome` — same shape, so the screen handles all three alike.
 */
export type FinishEnrichmentOutcome =
  | { kind: "updated"; markdown: string }
  | { kind: "failed"; reason: string };

/** The capture modes whose note is a single unit of text that can be handed to
 * a model and overwritten wholesale. `photo`/`audio` go through the
 * image/transcription paths instead (noteReprocess.ts).
 *
 * `journal` is deliberately EXCLUDED: a Journal day file holds many entries
 * under `## HH:MM` headings, so re-enriching the file would collapse the whole
 * day into one enrichment of the concatenated text and destroy that structure.
 * Journal needs an entry-scoped re-enrichment, which is a different operation
 * than this whole-file overwrite. (The Edit-during-capture affordance is
 * unaffected — it runs before anything is written.) */
const RE_ENRICHABLE_MODES = ["idea", "person"] as const;

type ReEnrichableMode = (typeof RE_ENRICHABLE_MODES)[number];

/** True when a note's mode has an in-place enrichment path (see above). */
export function isReEnrichableMode(mode: CaptureMode): mode is ReEnrichableMode {
  return (RE_ENRICHABLE_MODES as readonly CaptureMode[]).includes(mode);
}

/** True when this note is a raw save-first capture still awaiting enrichment. */
export function isPendingEnrich(body: string): boolean {
  return extractFrontmatterField(body, "status") === PENDING_ENRICH_STATUS;
}

/**
 * Run the enrichment this note never received, in place.
 *
 * Reads the CURRENT file rather than trusting the caller's snapshot, and takes
 * the mtime baseline BEFORE the model call — the ordering `enhanceProse.ts` and
 * `promoteIdeaOnDisk.ts` both use, because the call is a wide window for a
 * synced edit to land. Never throws; every failure returns a reason.
 */
export async function finishPendingEnrichment(input: {
  body: string;
  filepath: string;
}): Promise<FinishEnrichmentOutcome> {
  try {
    // Baseline first — a baseline read after the call would match whatever the
    // edit produced, making the guard useless for the window it exists to cover.
    const baseline = await getModificationTime(input.filepath);

    let source = input.body;
    // Only a snapshot read from DISK is a valid content baseline for the SAF
    // guard; the caller's copy may already be stale, which would report a
    // phantom conflict on every run.
    let expectedContent: string | null = null;
    try {
      source = await readNote(input.filepath);
      expectedContent = source;
    } catch {
      // Unreadable: fall back to the caller's snapshot rather than refusing.
      // The mtime guard still protects the write.
    }

    if (!isPendingEnrich(source)) {
      return {
        kind: "failed",
        reason: "This note is not awaiting enrichment.",
      };
    }

    // The raw note's body IS the user's original text — buildRawIdeaMarkdown
    // writes it verbatim beneath the frontmatter, so no reconstruction is
    // needed. Tags and location the user set at capture are preserved and
    // re-merged by applyEnrichedIdea.
    const text = stripFrontmatter(source).trim();
    if (!text) {
      return { kind: "failed", reason: "This note has no text to enrich." };
    }
    const location = extractFrontmatterField(source, "location") ?? undefined;

    const outcome = await enrichIdeaInPlace({
      filepath: input.filepath,
      expectedMtime: baseline,
      expectedContent,
      text,
      // The stub's own frontmatter is carnet's, but this note has been sitting
      // on disk since the failed enrich — long enough for the user (or a synced
      // workstation) to have added fields to it. `rev`/`status`/`tags` are
      // excluded downstream; see NEVER_PRESERVED_FIELDS.
      preserveFrontmatterFrom: source,
      tags: getFrontmatterTags(source),
      location,
      attachments: attachmentsFromBody(source),
    });

    if (outcome.kind === "updated") {
      return { kind: "updated", markdown: outcome.markdown };
    }
    if (outcome.kind === "conflict") {
      return {
        kind: "failed",
        reason:
          "This note changed while enrichment was running, so your version was kept. Try again.",
      };
    }
    return { kind: "failed", reason: outcome.reason };
  } catch (e: unknown) {
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Both in-place outcome unions are structurally identical, so one mapper
 * flattens either into the screen-facing FinishEnrichmentOutcome. */
function mapInPlaceOutcome(
  outcome: EnrichIdeaOutcome | EnrichInPlaceOutcome,
): FinishEnrichmentOutcome {
  if (outcome.kind === "updated") return { kind: "updated", markdown: outcome.markdown };
  if (outcome.kind === "conflict") {
    return {
      kind: "failed",
      reason:
        "This note changed while enrichment was running, so your version was kept. Try again.",
    };
  }
  return { kind: "failed", reason: outcome.reason };
}

/**
 * Re-run enrichment on a saved note, in place, regardless of its status.
 *
 * The user-facing counterpart to `finishPendingEnrichment`: that one exists for
 * notes stuck at `pending-enrich` and refuses anything else, whereas this one is
 * for "I edited my note, enrich it again". Same baseline-before-the-call
 * ordering, same read-from-disk-not-the-snapshot rule, same never-throws
 * contract — only the pending gate is dropped.
 *
 * On an already-enriched note this feeds LLM-formatted prose back into a prompt
 * written for raw input. That is accepted and deliberate (it is what "re-enrich
 * my edit" means); whatever is on disk is the input, exactly as enhanceProse.ts
 * and the vision re-enrich path already treat it.
 */
export async function reEnrichNoteInPlace(input: {
  body: string;
  filepath: string;
  mode: CaptureMode;
}): Promise<FinishEnrichmentOutcome> {
  try {
    if (input.mode === "journal") {
      // Not merely unsupported — actively destructive if it were wired up; see
      // RE_ENRICHABLE_MODES. Kept as its own branch so the reason is specific.
      return {
        kind: "failed",
        reason: "Journal re-enrichment isn't supported yet — it would replace the whole day's entries.",
      };
    }
    if (!isReEnrichableMode(input.mode)) {
      return { kind: "failed", reason: "This note type cannot be re-enriched." };
    }

    const baseline = await getModificationTime(input.filepath);

    let source = input.body;
    // See finishPendingEnrichment: a disk read is the only valid content
    // baseline for the SAF guard.
    let expectedContent: string | null = null;
    try {
      source = await readNote(input.filepath);
      expectedContent = source;
    } catch {
      // Unreadable: fall back to the caller's snapshot rather than refusing.
      // The mtime guard still protects the write.
    }

    const text = stripFrontmatter(source).trim();
    if (!text) {
      return { kind: "failed", reason: "This note has no text to enrich." };
    }

    if (input.mode === "idea") {
      return mapInPlaceOutcome(
        await enrichIdeaInPlace({
          filepath: input.filepath,
          expectedMtime: baseline,
          expectedContent,
          text,
          // A saved Idea can carry frontmatter carnet never wrote (a hand-added
          // `project:`, an Obsidian plugin's field). The model sees the body
          // only, so without this they are dropped on every re-enrich.
          preserveFrontmatterFrom: source,
          tags: getFrontmatterTags(source),
          location: extractFrontmatterField(source, "location") ?? undefined,
          // Same reason personInPlace re-merges tags/location: the model's
          // output carries none of the note's own embeds.
          attachments: attachmentsFromBody(source),
        }),
      );
    }
    return mapInPlaceOutcome(
      await enrichPersonInPlace({
        filepath: input.filepath,
        expectedMtime: baseline,
        expectedContent,
        ocrResult: text,
        context: "",
        // The contact fields (email/phone/company/linkedin/…) live in the
        // frontmatter this prompt never sees, so they come back empty.
        preserveFrontmatterFrom: source,
        // The model's output carries none of the user's filing metadata, so
        // the note's own tags/location are re-merged onto it — otherwise a
        // re-enrich silently strips them from the vault. The note's embeds go
        // back for the same reason (a Person note's card photo lives in one).
        tags: getFrontmatterTags(source),
        location: extractFrontmatterField(source, "location") ?? undefined,
        attachments: attachmentsFromBody(source),
      }),
    );
  } catch (e: unknown) {
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
