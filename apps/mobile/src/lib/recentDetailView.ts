// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure derived-view helpers for RecentDetailScreen: the small decisions that
 * turn note/frontmatter/flag state into the strings and booleans the render
 * tree consumes. Lifted out of the screen so each precedence rule (which of
 * five errors wins the single banner slot, which of three async actions owns
 * the busy label) is unit-testable without a renderer.
 *
 * React-free by design — nothing here imports react-native or expo.
 */

import type { CaptureEntry } from "./storage";

/** Human label for a capture mode, used in the File info dialog. */
export function formatMode(mode: CaptureEntry["mode"]): string {
  switch (mode) {
    case "idea":
      return "Idea";
    case "journal":
      return "Journal";
    case "person":
      return "Contact";
    case "photo":
      return "Photo";
    case "audio":
      return "Audio";
  }
}

/** Locale-formatted capture timestamp (unix ms). */
export function formatDate(unix: number): string {
  return new Date(unix).toLocaleString();
}

/** The failure slots that compete for the screen's one banner. */
export interface NoteIssueState {
  editError: string | null;
  karakeepError: string | null;
  transcribeError: string | null;
  reEnrichError: string | null;
  enhanceError: string | null;
  attachPhotoError: string | null;
}

/**
 * Pick the single banner message. Precedence is deliberate: a failed SAVE is
 * the most actionable (the user's own words are at stake), then the export and
 * the two enrichment operations. Returns null when nothing failed.
 */
export function activeIssueMessage(state: NoteIssueState): string | null {
  if (state.editError) return `Save failed: ${state.editError}`;
  if (state.karakeepError) return `Karakeep export failed: ${state.karakeepError}`;
  if (state.transcribeError) return `Transcribe failed: ${state.transcribeError}`;
  if (state.reEnrichError) return `Re-enrich failed: ${state.reEnrichError}`;
  if (state.enhanceError) return `Enhance failed: ${state.enhanceError}`;
  if (state.attachPhotoError) return `Attach photo failed: ${state.attachPhotoError}`;
  return null;
}

/** The long-running actions that share the inline busy row. */
export interface NoteBusyState {
  reEnriching: boolean;
  transcribing: boolean;
  exportingKarakeep: boolean;
  enhancing: boolean;
  attachingPhoto: boolean;
}

/** Label for the inline spinner, or null when nothing is in flight. */
export function busyLabel(state: NoteBusyState): string | null {
  if (state.reEnriching) return "Re-running vision enrichment…";
  if (state.transcribing) return "Transcribing audio…";
  if (state.exportingKarakeep) return "Sending to Karakeep…";
  if (state.enhancing) return "Enhancing prose…";
  if (state.attachingPhoto) return "Attaching photo…";
  return null;
}

/** True while any action is running (gates the FAB + sheet rows). */
export function isActionsBusy(state: NoteBusyState): boolean {
  return (
    state.reEnriching ||
    state.transcribing ||
    state.exportingKarakeep ||
    state.enhancing ||
    state.attachingPhoto
  );
}

/** Which secondary actions this note's `kind` supports. */
export interface NoteCapabilities {
  canReEnrich: boolean;
  canTranscribe: boolean;
  canEnhance: boolean;
  showAudioPlayer: boolean;
}

/**
 * Decide the kind-gated affordances.
 *
 * Re-enrich only makes sense when the raw input is recoverable from disk —
 * that's photo + shared-image (paired JPEG in Photos/). idea/journal/person
 * notes have no raw input on disk; shared-link/text need a frontmatter
 * migration first. Transcribe + the inline player surface for audio notes
 * (both shared-audio and in-app captures use the same kind value); the player
 * additionally needs the file to actually be on disk.
 *
 * Enhance is deliberately NOT kind-gated: idea, journal, shared-link and
 * shared-text notes all carry prose worth polishing, and an image/audio note's
 * body is prose once it has been enriched or transcribed. The real "is there
 * enough here to enhance?" test needs the body text, which this function does
 * not have — it lives in lib/enhanceProse.ts. All that is gated here is
 * `missing`: a note whose .md is gone from disk must never be written.
 */
export function noteCapabilities(
  kind: string,
  missing: boolean,
): NoteCapabilities {
  const canReEnrich = kind === "shared-image" || kind === "photo";
  const canTranscribe = kind === "shared-audio";
  return {
    canReEnrich,
    canTranscribe,
    canEnhance: !missing,
    showAudioPlayer: canTranscribe && !missing,
  };
}

/**
 * Vault subdir for a capture mode. Sharpens the related-notes self-exclusion
 * (see RelatedQuery docs) — the mode maps 1:1 onto the subdir.
 */
export function relatedSubdirForMode(
  mode: CaptureEntry["mode"],
): "Journal" | "People" | "Ideas" {
  if (mode === "journal") return "Journal";
  if (mode === "person") return "People";
  return "Ideas";
}

/**
 * Success-snackbar copy after a Karakeep export. `didUpdate` distinguishes an
 * in-place bookmark update from a fresh create; `skipNote` appends the
 * unsupported-attachment notice when there was one.
 */
export function karakeepSnackbarMessage(
  didUpdate: boolean,
  skipNote: string | null,
): string {
  return (
    (didUpdate ? "Updated in Karakeep" : "Exported to Karakeep") +
    (skipNote ? `. ${skipNote}.` : "")
  );
}
