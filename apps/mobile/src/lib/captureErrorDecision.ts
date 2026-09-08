/**
 * Capture-error classification (extracted from CaptureScreen).
 *
 * When an enrichment call fails, the screen must decide between three
 * user-facing outcomes without re-implementing the branching inline:
 *   - notConfigured: the active provider's URL is blank — a configuration
 *     problem, not an offline blip. Queuing it would "succeed" silently and
 *     retry forever against a nonexistent endpoint, so the screen surfaces it
 *     and keeps the text for a resend.
 *   - permanent: a 4xx from the active provider (auth, bad model, malformed
 *     input). No retry helps, so surface the real message and keep the text.
 *   - transient: network / timeout / 5xx — safe to enqueue for a later drain.
 *
 * An insecure-transport failure (plain-http remote URL) is classified
 * notConfigured for the same reason the blank URL is: only Settings can fix it.
 * Queuing it would be worse than useless now that drainQueue breaks on that
 * error — the row would never drain AND would block every healthy row behind it.
 *
 * Pure and React-free so the classification is unit-testable without a renderer.
 * `classifyCaptureError` takes the active provider's label as a parameter
 * (rather than reading Settings itself) to stay pure — callers resolve it via
 * llmProviders.ts's resolveActiveProvider and pass it down.
 */

import {
  isInsecureTransportError,
  isNotConfiguredError,
  isPermanentError,
} from "./dispatcher";
import { UNKNOWN_PROVIDER_LABEL } from "./llmProviders";

/** Build the copy shown when the active provider's URL is unset — a config
 * error, not offline. */
export function notConfiguredMessage(providerLabel: string): string {
  return `${providerLabel} URL not configured — set it in Settings.`;
}

/**
 * The classified outcome of a failed capture. `notConfigured` and `permanent`
 * both carry the message the screen should surface (and both keep the user's
 * text); `transient` tells the screen to enqueue for a later drain.
 */
export type CaptureErrorDecision =
  | { kind: "notConfigured"; message: string }
  | { kind: "permanent"; message: string }
  | { kind: "transient" };

/** Classify a capture failure into the outcome the screen should act on.
 * `providerLabel` names the active provider in the notConfigured message;
 * defaults to a provider-neutral phrasing when the caller has none to hand
 * (e.g. hasn't loaded Settings yet). */
export function classifyCaptureError(
  e: unknown,
  providerLabel: string = UNKNOWN_PROVIDER_LABEL,
): CaptureErrorDecision {
  if (isNotConfiguredError(e)) {
    return { kind: "notConfigured", message: notConfiguredMessage(providerLabel) };
  }
  // Same shape of problem, different flag on purpose: `notConfigured` also
  // gates dispatcher's shouldRetryWithFallback, and an insecure primary must
  // keep falling back to a working secondary. The provider's own wording names
  // the offending URL, so it is surfaced verbatim rather than flattened into
  // the canonical constant above — exactly as classifyCardScanOcrError does.
  if (isInsecureTransportError(e)) {
    return { kind: "notConfigured", message: e instanceof Error ? e.message : String(e) };
  }
  if (isPermanentError(e)) {
    return { kind: "permanent", message: e instanceof Error ? e.message : String(e) };
  }
  return { kind: "transient" };
}

/**
 * The message to surface when a retrospective ask fails.
 *
 * Deliberately NOT classifyCaptureError: that function's three-way split
 * exists to decide whether CaptureScreen should enqueue, and its `transient`
 * branch carries no copy because the queue is the user-visible outcome there.
 * Ask has no queue — a timeout has to say something — so this collapses the
 * split to the only distinction that changes the wording: a config problem
 * names the provider and points at Settings, everything else surfaces the
 * provider's own message, which is more specific than anything generic.
 *
 * Behaviourally identical to classifyCaptureError on every branch that has
 * copy (an insecure-transport refusal falls through to its verbatim message,
 * exactly as that function returns it).
 */
export function askErrorMessage(
  e: unknown,
  providerLabel: string = UNKNOWN_PROVIDER_LABEL,
): string {
  if (isNotConfiguredError(e)) return notConfiguredMessage(providerLabel);
  return e instanceof Error ? e.message : String(e);
}
