// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The screen-side half of the Karakeep export: the re-export confirm gate and
 * the translation of a {@link KarakeepExportOutcome} into the UI state the
 * detail screen should adopt. lib/karakeepNoteExport.ts owns the network +
 * disk orchestration; this module owns "given that outcome, what does the user
 * see" — the four-way branch that used to sit inline in RecentDetailScreen.
 *
 * Pure and React-free: no setState, no refs, no react-native imports. The
 * caller applies the returned plan.
 */

import { extractFrontmatterField } from "./frontmatter";
import type { KarakeepExportOutcome } from "./karakeepNoteExport";

/**
 * True when the note already carries a `karakeepId` — i.e. it was exported
 * before and re-sending would UPDATE the existing bookmark rather than create
 * a second one. The screen confirms with the user first in that case.
 */
export function needsReexportConfirm(body: string): boolean {
  // `!== null` is equivalent to a truthiness check ONLY because
  // extractFrontmatterField never returns "" for a present key: its own
  // `if (value) return value` guard treats an empty/blank value as absent and
  // keeps scanning, so a `karakeepId:` with nothing after it yields null, not
  // "". If that guard ever relaxes, this must become a truthiness check —
  // otherwise a blank stamp would suppress the export behind a confirm dialog
  // for a bookmark that does not exist.
  return extractFrontmatterField(body, "karakeepId") !== null;
}

/**
 * Informational notice for attachments Karakeep refused as an unsupported
 * asset type (its upload allowlist is ~images + PDF). The export itself
 * succeeded — this is never an error on its own. Null when nothing was
 * skipped.
 */
export function unsupportedSkipNote(skipped: readonly string[]): string | null {
  if (skipped.length === 0) return null;
  return `${skipped.join(", ")} ${
    skipped.length === 1 ? "is" : "are"
  } a file type Karakeep doesn't accept — kept in the vault only`;
}

/**
 * What the screen should do with an export outcome.
 *
 * - `queue`:   the host never answered — enqueue a connectivity retry and show
 *              the informational "queued" snackbar instead of an error. Carries
 *              `fallbackError` for the case where the enqueue itself fails.
 * - `error`:   a real failure — show the error banner, note unchanged.
 * - `partial`: the bookmark saved but an attachment push failed. The note WAS
 *              rewritten (`nextBody`), and the message lands in the error
 *              banner because the export is only half-done.
 * - `success`: adopt `nextBody` and flip the success snackbar.
 */
export type KarakeepUiPlan =
  | { kind: "queue"; fallbackError: string }
  | { kind: "error"; message: string }
  | { kind: "partial"; nextBody: string; message: string }
  | {
      kind: "success";
      nextBody: string;
      didUpdate: boolean;
      skipNote: string | null;
    };

/** Translate an export outcome into the screen's next UI state. */
export function planKarakeepUiUpdate(
  outcome: KarakeepExportOutcome,
): KarakeepUiPlan {
  if (outcome.kind === "failed") {
    // An unreachable host (VPN/Tailscale down — status-0, never a 4xx/5xx
    // answer) queues the export for a connectivity retry instead of erroring.
    return outcome.unreachable
      ? { kind: "queue", fallbackError: outcome.reason }
      : { kind: "error", message: outcome.reason };
  }
  const skipNote = unsupportedSkipNote(outcome.skippedUnsupported);
  if (outcome.kind === "partial") {
    return {
      kind: "partial",
      nextBody: outcome.nextBody,
      message:
        `Exported to Karakeep, but an attachment failed: ${outcome.assetError}` +
        (skipNote ? `\nAlso: ${skipNote}.` : ""),
    };
  }
  return {
    kind: "success",
    nextBody: outcome.nextBody,
    didUpdate: outcome.didUpdate,
    skipNote,
  };
}
