/**
 * Pure display-string / response-object derivations for CaptureScreen.
 *
 * Each of these was a small inline computation repeated or duplicated in
 * the screen (the preview-response object was built identically at four
 * call sites: idea/journal/person submit, and promote). Extracted so the
 * derivation is unit-testable without a renderer; the screen still owns
 * the `useMemo`/state wiring around them.
 */

import type { CaptureMode } from "./storage";
import type { PickedAttachment } from "./attachments";
import { deriveTitle, type CaptureResponse } from "@carnet/shared";
import { formatMode } from "./recentDetailView";
import { isSaveFirstTextMode, type SaveFirstTextMode } from "./saveFirstRouting";

/** The capture screen's phase machine: distraction-free input, an
 * enrichment request in flight, the blocking preview (opt-in Idea, and
 * Journal/Person), or the save-first "Saved to vault" confirmation. */
export type CapturePhase = "input" | "submitting" | "preview" | "saved";

/** A subset of the screen's pending-preview state — only the fields the
 * subtitle needs from each mode's pending object. */
export interface PreviewSubtitleInputs {
  mode: CaptureMode;
  pendingIdea: { slug: string } | null;
  pendingJournal: { date: string } | null;
  pendingPerson: { firstName: string; lastName: string } | null;
  omniModel: string | null;
}

/** Preview-card subtitle: the target filename for the active mode + the
 * enriching model, e.g. `Ideas/my-idea.md • gpt-4`. */
export function buildPreviewSubtitle(inputs: PreviewSubtitleInputs): string {
  const { mode, pendingIdea, pendingJournal, pendingPerson, omniModel } = inputs;
  const filename =
    mode === "idea" && pendingIdea
      ? `Ideas/${pendingIdea.slug}.md`
      : mode === "journal" && pendingJournal
        ? `Journal/${pendingJournal.date}.md`
        : mode === "person" && pendingPerson
          ? `People/${pendingPerson.firstName}-${pendingPerson.lastName}.md`
          : "";
  return `${filename}${omniModel ? ` • ${omniModel}` : ""}`;
}

/** One quiet summary line for what's staged behind the "+" metadata sheet
 * (tags / attachments / location), so the user can see filing state
 * without opening it. Empty string when nothing is staged. */
export function buildMetaSummary(
  tags: string[],
  pending: readonly PickedAttachment[],
  location: string | null,
): string {
  const parts: string[] = [];
  if (tags.length > 0) parts.push(`${tags.length} tag${tags.length > 1 ? "s" : ""}`);
  if (pending.length > 0)
    parts.push(`${pending.length} attachment${pending.length > 1 ? "s" : ""}`);
  if (location) parts.push("location");
  return parts.join(" · ");
}

/** computeCanSubmit's inputs, grouped into one object — the three free-text
 * fields (text/transcript/ocrText) sat as adjacent same-typed positional
 * params, easy to transpose at the call site without either the compiler or
 * a reviewer catching it. */
export interface CanSubmitInputs {
  phase: CapturePhase;
  mode: CaptureMode;
  text: string;
  transcript: string;
  ocrText: string;
}

/** Whether Send should be enabled: only in the "input" phase, and only once
 * the mode's required field(s) have non-whitespace content. Journal and
 * Person both accept either their dedicated field or the shared notes/context
 * field. */
export function computeCanSubmit(inputs: CanSubmitInputs): boolean {
  const { phase, mode, text, transcript, ocrText } = inputs;
  if (phase !== "input") return false;
  // Idea and Note share one text surface (CaptureModeInput) — only `text` counts.
  if (isSaveFirstTextMode(mode)) return text.trim().length > 0;
  if (mode === "journal") return transcript.trim().length > 0 || text.trim().length > 0;
  return ocrText.trim().length > 0 || text.trim().length > 0;
}

/** Build the ok-status preview response shown by CapturePreviewCard.
 * `filepath` is only set once the note has been written to disk (promote
 * after a save-first commit); the initial submit-phase preview omits it. */
export function buildCapturePreviewResponse(
  markdown: string,
  filepath?: string,
): CaptureResponse {
  return {
    type: "capture_response",
    request_id: "",
    status: "ok",
    preview_markdown: markdown,
    filepath,
  };
}

/** Recents-history title for a save-first capture: the raw text's H1 or first
 * line, else the mode's own label — an emoji-only Note is "Note", not "Idea". */
export function saveFirstTitle(text: string, mode: SaveFirstTextMode = "idea"): string {
  return deriveTitle(text) || formatMode(mode);
}
