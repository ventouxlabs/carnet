// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Attach a photo to a note that is already saved — the VIEW-mode counterpart to
 * useNoteEditSession's insert handlers, which only run inside an open editor.
 *
 * Borrows enhanceProse.ts's write spine (fresh read → guarded overwrite) and its
 * never-throws contract, but NOT its guard window, which is worth being precise
 * about since the two look alike:
 *
 *   - enhanceProse takes its baseline before a model call that can run 120s, so
 *     its guard covers a genuinely wide edit window.
 *   - This function is only entered once the shot already exists. The user's
 *     framing time is spent in the modal, upstream of here, and is NOT inside
 *     the guarded window. What the baseline actually covers is the short
 *     write-image → re-read → overwrite span (milliseconds).
 *
 * That narrower guard is still worth keeping, but the load-bearing protection
 * on this path is the fresh `readNote` below, not the mtime check: an edit that
 * lands while the camera is open is simply picked up by the re-read and gets
 * appended to, so the photo attaches AND the edit survives. Nothing here trusts
 * a caller-supplied body — appending to a screen-load snapshot is what would
 * silently revert such an edit (#133's defect class).
 */

import { writeCapturedVaultImage } from "./vaultImageInsert";
import { getModificationTime, readNote, updateNoteIfUnchanged } from "./writer";

export type AttachPhotoOutcome =
  | { kind: "attached"; rel: string; nextBody: string }
  | { kind: "failed"; reason: string };

/**
 * Write `base64` into the vault's `Photos/` and append its embed to the note at
 * `filepath`. Never throws — every failure returns a `failed` reason and leaves
 * the note on disk exactly as it was.
 *
 * A refused write can leave the image file orphaned in `Photos/`. That is the
 * same accepted trade the existing insert handlers make: an unreferenced file
 * is recoverable from the vault, a clobbered note is not.
 */
export async function attachPhotoToNote(input: {
  filepath: string;
  base64: string;
  mime: string;
  /** Original filename when the image came from the library; camera shots have none. */
  basename?: string;
}): Promise<AttachPhotoOutcome> {
  try {
    // Baseline for the write-image → re-read → overwrite span below. The
    // camera step already happened upstream, so this does NOT cover the user's
    // framing time — see the module docstring.
    const baseline = await getModificationTime(input.filepath);
    const { rel } = await writeCapturedVaultImage(
      input.base64,
      input.mime,
      input.basename,
    );

    // CURRENT content, deliberately re-read rather than taken from the caller.
    // This is what makes an edit made while the camera was open survive: it is
    // appended to, not overwritten.
    const source = await readNote(input.filepath);
    const nextBody = `${source.trimEnd()}\n\n![](${rel})\n`;

    const written = await updateNoteIfUnchanged(input.filepath, nextBody, baseline);
    if (!written.ok) {
      return {
        kind: "failed",
        reason:
          "The note was written to from somewhere else just as the photo was being attached — your version was kept. The photo is in Photos/; try attaching it again.",
      };
    }
    return { kind: "attached", rel, nextBody };
  } catch (e: unknown) {
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
