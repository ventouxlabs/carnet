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
