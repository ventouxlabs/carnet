/**
 * Pure mode routing for the save-first text capture path — Idea and Note.
 *
 * A leaf on purpose, with no runtime imports: screens, components and pure lib
 * modules call it without dragging ideaSaveFirst.ts's dispatcher → settings →
 * expo-secure-store chain into their tests, and without tripping the suites
 * that vi.mock ideaSaveFirst wholesale (CaptureScreen, notificationQuickIdea,
 * finishEnrichment), where any NEW export of that module comes back undefined.
 * ideaSaveFirst.ts re-exports what it uses.
 */

import type { CaptureMode } from "./storage";
import type { QueuePayload } from "./queue";
import type { VaultContext } from "./vaultContext";
import type { AttachmentRef } from "./writer";

/** The capture modes written raw first and enriched in place. */
export type SaveFirstTextMode = Extract<CaptureMode, "idea" | "note">;

/** Idea and Note share one text surface and one save-first flow; the mode
 * only picks the folder (Ideas/ vs Notes/) and the prompt. */
export function isSaveFirstTextMode(mode: CaptureMode): mode is SaveFirstTextMode {
  return mode === "idea" || mode === "note";
}

/** The mode a save-first input routes as. Absent means idea — every caller
 * that predates Note (notificationQuickIdea's quick-reply and Drive Inbox
 * path, persisted queue rows) builds its input without one. */
export function saveFirstModeOf(input: { mode?: SaveFirstTextMode }): SaveFirstTextMode {
  return input.mode ?? "idea";
}

/**
 * Whether a save-first text capture skips the blocking preview. Settings'
 * `previewBeforeSave` is labelled "Preview ideas before saving" and gates Idea
 * only. A Note is ALWAYS save-first: its prompt tidies and never expands, so
 * there is nothing to review before it lands (PRD §6), and the preview path's
 * confirmSaveIdea writes to Ideas/.
 */
export function usesSaveFirst(previewBeforeSave: boolean, mode: SaveFirstTextMode = "idea"): boolean {
  return mode === "note" || !previewBeforeSave;
}

/** What a save-first capture carries into the queue. Structural, so this leaf
 * never imports ideaSaveFirst.ts's RawCaptureInput at runtime. */
interface SaveFirstRetryInput {
  mode?: SaveFirstTextMode;
  text: string;
  tags: string[];
  location?: string;
  attachments?: AttachmentRef[];
}

/**
 * The queue row for a save-first capture whose enrichment failed transiently.
 * The raw note is already on disk at `filepath`, so the drain updates it in
 * place (guarded by the baselines) instead of writing a twin — and it drains
 * through the SAME mode's prompt: a queued Note must never be retried through
 * the expanding Idea prompt.
 */
export function buildSaveFirstRetryPayload(
  input: SaveFirstRetryInput,
  retry: {
    filepath: string;
    baselineMtime: number | null;
    baselineContent: string | null;
    vaultContext?: VaultContext;
  },
): QueuePayload {
  return {
    mode: saveFirstModeOf(input),
    text: input.text,
    attachments: input.attachments,
    tags: input.tags,
    location: input.location,
    filepath: retry.filepath,
    baselineMtime: retry.baselineMtime,
    baselineContent: retry.baselineContent,
    vaultContext: retry.vaultContext,
  };
}
