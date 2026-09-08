/**
 * Enrichment backend dispatcher (Stage 2 / branch B7; rewritten for the LLM
 * provider list Phase 2, extended for Phase 3 — see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md).
 *
 * The single seam through which callers reach the provider-divergent
 * enrichment functions, decoupling them from any one concrete provider.
 * `Settings.activeProviderId` selects which entry in `Settings.llmProviders`
 * serves a capture — read fresh on EVERY call (not cached), so a user
 * switching providers mid-session takes effect on their very next capture.
 *
 * Phase 1 merged two whole duplicate client modules (omniroute.ts,
 * localLlm.ts) into llmClient.ts, ONE OpenAI-compatible client parameterized
 * by a ProviderConfig this module resolves. Phase 2 replaces the flat
 * `llmBackend`/`omniRoute*`/`localLlm*` settings fields that ProviderConfig
 * used to be built from with `llmProviders`/`activeProviderId` — the two
 * known ids (`omniroute`, `relais`) keep their exact pre-existing defaulting
 * behavior in `buildConfig` below (OmniRoute's blank URL is not-configured
 * but its blank model falls back to a hard-coded default; Relais's blank URL
 * falls back to the loopback default but its blank model is
 * not-configured), so an existing install behaves identically post-upgrade.
 * Any other provider (a cloud preset or a custom entry) gets no special
 * defaulting — a blank baseUrl/model there throws not-configured exactly as
 * llmClient.ts already does for any blank field.
 *
 * Phase 3 adds the OFFLINE FALLBACK CHAIN (`withFallbackChain` below): every
 * enrichment/vision call resolves its primary provider, and on an
 * unreachable-class failure ONLY retries exactly once against
 * `Settings.fallbackProviderId`. A note written via the fallback path is
 * marked in its frontmatter (`markFallback`) so `RecentDetailScreen` can
 * surface which provider actually served it — re-enrichment stays
 * user-initiated (`lib/noteReprocess.ts`), never automatic. Phase 3 also
 * adds the vision-routing rung (`resolveVisionProviderId`): a vision call
 * prefers the active entry's own vision model, then falls back to
 * `Settings.visionProviderId`'s, before throwing the existing not-configured
 * error.
 *
 * transcribeAudio/autoTranscribeIfEnabled live here directly (not in
 * llmClient.ts) because they're backend-agnostic on-device speech
 * recognition that reads settings and touches the vault writer — outside
 * llmClient.ts's "reads no settings" contract, which is specifically about
 * the OpenAI-compatible chat client. isPermanentError/isNotConfiguredError
 * stay static re-exports from llmClient.ts — they classify via the shared
 * HttpError base, so they work for any provider's error without a switch
 * here.
 */

import { getSettings, getPromptOverrides, DEFAULT_OMNIROUTE_MODEL, type Settings } from "./settings";
import {
  resolveActiveProvider,
  resolveEnhanceProvider,
  resolveVisionProvider,
} from "./llmProviders";
import * as providerKeys from "./providerKeys";
import * as llmClient from "./llmClient";
import type { EnrichResult, ProviderConfig } from "./llmClient";
import type { SelectedNote } from "./retrospective";
import { isLocalNetworkUrl } from "./netAllowlist";
import { upsertFrontmatterField } from "./frontmatter";
import {
  readNote,
  readPairedBinaryFromNote,
  updateNote,
  upsertSection,
} from "./writer";
import type { IdeaStatus } from "@carnet/shared";

// listModels is a straight re-export — it used to route through backendFor()
// like every other call here, so the local backend would hit localLlm.ts's
// listModels (its own blank-URL-defaults-to-loopback default and
// "Local LLM ..." message branding). Now it always hits the one merged
// llmClient.listModels (OmniRoute-shaped: no blank-URL default, generic
// "LLM provider ..." messages) regardless of activeProviderId — a narrowing,
// deliberately left as-is rather than special-cased. Safe in practice: the
// only real caller (SettingsScreen's model browser) always passes an
// explicit URL (form.omniRouteUrl), so the blank-URL-default path was
// already unreachable from that call site, and no test asserts on the
// message branding.
export {
  isPermanentError,
  isNotConfiguredError,
  isInsecureTransportError,
  listModels,
} from "./llmClient";
export type { EnrichResult } from "./llmClient";

/**
 * Resolve a provider list entry (by id — NOT necessarily the active one;
 * Phase 3's fallback chain calls this a second time with
 * `settings.fallbackProviderId`, and vision routing calls it with whichever
 * id `resolveVisionProviderId` picked) into the ProviderConfig llmClient.ts
 * expects, replicating each of the two known ids' exact pre-provider-list
 * defaulting so this refactor is behavior-preserving:
 *   - relais: blank URL gets the loopback default (never not-configured);
 *     blank model stays blank (llmClient throws not-configured) — there's no
 *     sensible hard-coded default for an arbitrary local deployment. One
 *     model covers text AND vision — no separate vision-model split like
 *     OmniRoute's chat/vision divide.
 *   - omniroute: blank URL stays blank (llmClient throws not-configured);
 *     blank model gets OmniRoute's hard-coded default (never not-configured).
 *   - any other id (cloud preset or custom entry): no special defaulting —
 *     a blank baseUrl/model throws not-configured exactly as llmClient.ts
 *     already does for any blank field.
 *
 * `label` (threaded into every llmClient.ts error/status message) is always
 * `provider.label` — relais and omniroute used to hard-code "Local LLM"/
 * "OmniRoute" here regardless of the entry's actual (possibly user-edited)
 * label, so an adjacent surface reading `provider.label` directly (or a
 * renamed preset) could disagree with dispatcher's own wording for the same
 * provider. Deleted as an unnecessary special case: the two ids still get
 * their own baseUrl/model defaulting above, just not a separate label.
 */
async function buildConfig(settings: Settings, providerId: string): Promise<ProviderConfig> {
  const provider = resolveActiveProvider(settings.llmProviders, providerId);
  const apiKey = await providerKeys.getKey(provider.id);

  // allowInsecureTransport (#176): threaded through unconditionally,
  // regardless of which id-specific branch resolves — it is a per-entry
  // consent flag (llmProviders.ts), not something any preset's defaulting
  // logic should special-case. `?? false` covers every entry persisted
  // before this field existed.
  const allowInsecureTransport = provider.allowInsecureTransport ?? false;

  if (provider.id === "relais") {
    return {
      baseUrl: provider.baseUrl.trim() || llmClient.DEFAULT_LOCAL_LLM_URL,
      apiKey,
      model: provider.model.trim(),
      visionModel: provider.model.trim(),
      label: provider.label,
      allowInsecureTransport,
    };
  }
  if (provider.id === "omniroute") {
    return {
      baseUrl: provider.baseUrl.trim(),
      apiKey,
      model: provider.model.trim() || DEFAULT_OMNIROUTE_MODEL,
      visionModel: provider.visionModel.trim(),
      label: provider.label,
      allowInsecureTransport,
    };
  }
  return {
    baseUrl: provider.baseUrl.trim(),
    apiKey,
    model: provider.model.trim(),
    visionModel: provider.visionModel.trim(),
    label: provider.label,
    allowInsecureTransport,
  };
}

/**
 * True when a failed call should retry once against `fallbackProviderId`
 * (Phase 3 — offline fallback chain). Built from ONLY the two classifiers
 * llmClient.ts already exports (`isPermanentError`, `isNotConfiguredError`)
 * — per the design, no new classifier.
 *
 *   - isPermanentError (4xx) -> NO retry. A bad API key or bad model id
 *     fails identically against the fallback; retrying could SUCCEED against
 *     a smaller/different fallback model, which would silently mask a
 *     misconfiguration the user needs to see and fix, not have hidden.
 *   - isNotConfiguredError -> NO retry. DECISION: a blank baseUrl/model on
 *     the PRIMARY is a configuration problem, not a reachability one — the
 *     user hasn't finished setting up their primary provider. Falling back
 *     silently here would hide that exactly the same way a bad key would:
 *     the user would see enrichment "working" via the fallback and never
 *     learn their primary is unset. The design's own framing — "never on a
 *     permanent 4xx... would mask a bad key" — applies just as much to a
 *     blank primary as to a bad one. This also keeps the contract literal:
 *     "on an UNREACHABLE-class failure ONLY" — not-configured never reaches
 *     the network at all, so it is definitionally not that class.
 *   - anything else (network error / timeout / 5xx, all surfacing as
 *     LlmClientError status 0 or >=500) -> retry. This is the
 *     "unreachable-class" failure the design calls out: the primary could
 *     not be reached, so trying a different reachable endpoint is the
 *     correct recovery and says nothing about whether the primary is
 *     correctly configured.
 */
function shouldRetryWithFallback(err: unknown): boolean {
  if (llmClient.isPermanentError(err)) return false;
  if (llmClient.isNotConfiguredError(err)) return false;
  return true;
}

/** Frontmatter field recording which provider actually served a note,
 * present ONLY when the fallback path did (Phase 3 provenance marker — see
 * the design doc's "Marking and re-enrichment"). A single lowercase word
 * with an enum-shaped value, matching this repo's existing frontmatter
 * vocabulary (prompts.ts/enrichSanitize.ts: `created`, `status`, `kind`,
 * `tags`) rather than introducing a camelCase/hyphenated key. The value is
 * the provider's stable id (e.g. "relais") — matching `kind`/`status`'s
 * existing enum-value convention — not its display label, which can hold
 * spaces/punctuation a future custom entry might pick. */
export const FALLBACK_PROVIDER_FIELD = "fallback";

/** Stamp the fallback marker via upsertFrontmatterField (frontmatter.ts) —
 * never hand-rolled, so the byte-compatibility guarantee for every OTHER
 * field is untouched; this only appends one new frontmatter line. Callers
 * invoke this ONLY on the fallback path — the primary path's markdown is
 * returned completely untouched, which is what keeps it byte-identical to
 * pre-Phase-3 output. */
function markFallback(markdown: string, fallbackProviderId: string): string {
  return upsertFrontmatterField(markdown, FALLBACK_PROVIDER_FIELD, fallbackProviderId);
}

/**
 * Resolution order for every enrichment/vision call (Phase 3 — offline
 * fallback chain):
 *   1. `primaryId`'s ProviderConfig.
 *   2. On an unreachable-class failure ONLY (`shouldRetryWithFallback`),
 *      retry EXACTLY ONCE against `settings.fallbackProviderId` — but only
 *      when it is set AND names a DIFFERENT provider than `primaryId`. A
 *      null fallback, or a fallback equal to the primary, is a no-op: the
 *      original error propagates exactly as it did before this phase.
 *   3. If the fallback attempt also fails, that error propagates unchanged
 *      — the existing offline queue (upstream of dispatcher.ts) is
 *      untouched by this phase.
 *
 * Returns `usedFallback`/`fallbackProviderId` alongside the result so
 * callers can stamp the written note's marker — see `markFallback`.
 */
async function withFallbackChain<T>(
  settings: Settings,
  primaryId: string,
  call: (config: ProviderConfig) => Promise<T>,
): Promise<{ result: T; usedFallback: boolean; fallbackProviderId: string | null }> {
  const primaryConfig = await buildConfig(settings, primaryId);
  try {
    const result = await call(primaryConfig);
    return { result, usedFallback: false, fallbackProviderId: null };
  } catch (err: unknown) {
    const fallbackId = settings.fallbackProviderId;
    if (!fallbackId || fallbackId === primaryId || !shouldRetryWithFallback(err)) {
      throw err;
    }
    const fallbackConfig = await buildConfig(settings, fallbackId);
    let result: T;
    try {
      result = await call(fallbackConfig);
    } catch (fallbackErr: unknown) {
      // A fallback that is merely UNCONFIGURED must not overwrite the primary's
      // error. Observed on-device 2026-08-05: OmniRoute timed out on a slow
      // reasoning model, the chain retried an unconfigured Relais, and the user
      // was told "Local LLM model not configured — set it in Settings" — which
      // points at the wrong provider and hides the real fault entirely. A
      // fallback that genuinely tried and failed still surfaces its own error,
      // since that reflects a real second attempt.
      if (llmClient.isNotConfiguredError(fallbackErr)) throw err;
      throw fallbackErr;
    }
    return { result, usedFallback: true, fallbackProviderId: fallbackId };
  }
}

/** Apply the fallback marker to an EnrichResult's markdown, but ONLY when
 * the fallback path actually served the call. Shared by every enrichment
 * entry point below so the byte-identical-on-primary guarantee lives in one
 * place rather than being re-implemented per call site. */
function withFallbackMarker(
  outcome: { result: EnrichResult; usedFallback: boolean; fallbackProviderId: string | null },
): EnrichResult {
  if (!outcome.usedFallback || !outcome.fallbackProviderId) return outcome.result;
  return {
    ...outcome.result,
    markdown: markFallback(outcome.result.markdown, outcome.fallbackProviderId),
  };
}

/**
 * Resolve which provider id should serve a vision-bearing call (Phase 3
 * vision-routing rung — see the design doc's "Vision routing"):
 *   1. the active entry, if it has an effective vision model.
 *   2. else `settings.visionProviderId`'s entry, if set and it has one.
 *   3. else the active entry's id anyway — `buildConfig`/llmClient.ts then
 *      throws the SAME not-configured error a blank vision model always
 *      threw, so this adds a rung without introducing a new failure mode.
 */
function resolveVisionProviderId(settings: Settings): string {
  const resolved = resolveVisionProvider(
    settings.llmProviders,
    settings.activeProviderId,
    settings.visionProviderId,
  );
  return resolved?.id ?? settings.activeProviderId;
}

export async function enrichIdea(text: string): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  const outcome = await withFallbackChain(settings, settings.activeProviderId, (config) =>
    llmClient.enrichIdea(text, config, overrides.idea),
  );
  return withFallbackMarker(outcome);
}

export async function enrichJournal(input: {
  transcript: string;
  notes: string;
}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  const outcome = await withFallbackChain(settings, settings.activeProviderId, (config) =>
    llmClient.enrichJournal(input, config, overrides.journal),
  );
  return withFallbackMarker(outcome);
}

export async function enrichPerson(input: {
  ocrResult: string;
  context: string;
}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  const outcome = await withFallbackChain(settings, settings.activeProviderId, (config) =>
    llmClient.enrichPerson(input, config, overrides.person),
  );
  return withFallbackMarker(outcome);
}

export async function enrichSharedImage(input: {
  base64: string;
  mimeType: string;
  context: string;
}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  const primaryId = resolveVisionProviderId(settings);
  const outcome = await withFallbackChain(settings, primaryId, (config) =>
    llmClient.enrichSharedImage(input, config, overrides.sharedImage),
  );
  return withFallbackMarker(outcome);
}

export async function enrichSharedLink(input: {
  url: string;
  text: string;
  context: string;
  onPreviewSettled?: () => void;
}): Promise<EnrichResult> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  const outcome = await withFallbackChain(settings, settings.activeProviderId, (config) =>
    llmClient.enrichSharedLink(input, config, overrides.sharedLink),
  );
  return withFallbackMarker(outcome);
}

export async function promoteIdea(
  currentMarkdown: string,
  target: IdeaStatus,
): Promise<EnrichResult> {
  const settings = await getSettings();
  const outcome = await withFallbackChain(settings, settings.activeProviderId, (config) =>
    llmClient.promoteIdea(currentMarkdown, target, config),
  );
  return withFallbackMarker(outcome);
}

/**
 * Config-only readiness check for the card scanner. Resolves the SAME vision
 * provider `ocrCardViaVision` would use and runs the same pre-flight asserts,
 * WITHOUT any network call — so opening the scanner costs one settings read,
 * never a request or a token.
 *
 * Deliberately not wrapped in `withFallbackChain`: `shouldRetryWithFallback`
 * returns false for a not-configured error, so an unconfigured primary never
 * falls back at runtime either. Probing the fallback here would under-warn on
 * exactly the setups that need the warning.
 *
 * Throws whatever the real call would throw at this stage; callers classify it
 * with the existing predicates rather than reading the message.
 */
export async function probeVisionReadiness(): Promise<void> {
  const settings = await getSettings();
  const config = await buildConfig(settings, resolveVisionProviderId(settings));
  const { url } = llmClient.assertVisionReady(config);
  assertVisionCredentialPresent(config, url);
}

/**
 * PROBE-ONLY credential check. A remote provider with a vision model, a URL,
 * and no API key passes every assert in `assertVisionReady` — `ocrCardViaVision`
 * simply omits the Authorization header — and then 401s after the user has
 * already framed and shot the card. That is exactly the late failure the
 * preflight banner exists to prevent, so the probe warns up front.
 *
 * Deliberately NOT part of `assertVisionReady` or `ocrCardViaVision`: a
 * genuinely keyless remote endpoint works today and must keep working, so the
 * real capture path still attempts the call and lets a 401 classify itself as
 * permanent. Moving this check into the shared asserts would break those setups
 * — keep it here.
 *
 * "Requires a key" is derived from the URL rather than a provider flag: a
 * loopback/LAN endpoint (Relais on 127.0.0.1, a self-hosted box at 192.168.x)
 * legitimately needs none, and a custom cloud entry is otherwise
 * indistinguishable from a custom LAN one by shape alone.
 *
 * The URL heuristic is deliberately narrow (loopback + dotted-quad RFC1918),
 * so a keyless https endpoint that is *privately* reachable — a Tailscale
 * 100.64/10 address, a `.local` name, `[::1]` — trips this banner too. That
 * is acceptable only because the banner is advisory (capture and OCR still
 * run), which is why the message is hedged with "usually" rather than
 * asserting the key is required.
 */
function assertVisionCredentialPresent(config: ProviderConfig, url: string): void {
  if (config.apiKey.trim()) return;
  if (isLocalNetworkUrl(url)) return;
  throw new llmClient.LlmClientError(
    `${config.label} has no API key — remote providers usually require one. Add it in Settings`,
    0,
    { notConfigured: true },
  );
}

/** What {@link enhanceProse} hands back: the raw result plus the fallback
 * facts and the resolved provider's display label (for the success snackbar). */
export interface EnhanceOutcome {
  result: EnrichResult;
  usedFallback: boolean;
  fallbackProviderId: string | null;
  providerLabel: string;
}

/**
 * Rewrite a note's prose body with the Enhance provider.
 *
 * Returns the result UNMARKED — deliberately the one enrichment entry point
 * that does not call withFallbackMarker. That helper runs
 * upsertFrontmatterField on the result, but this result is bare prose with no
 * frontmatter, so the marker would prepend a stray `---` block into the middle
 * of the note body. The fallback facts are handed outward instead, and
 * lib/enhanceProse.ts stamps them AFTER re-attaching the real frontmatter.
 */
export async function enhanceProse(body: string): Promise<EnhanceOutcome> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  // Resolved once — its id routes the call, its label names the provider in
  // the success snackbar. Unlike resolveVisionProviderId (which prefers the
  // ACTIVE entry whenever it is vision-capable), a configured
  // enhanceProviderId WINS here: reaching for a better model than the active
  // one is the entire point of the setting.
  const provider = resolveEnhanceProvider(
    settings.llmProviders,
    settings.activeProviderId,
    settings.enhanceProviderId,
  );
  // The model override applies to the PRIMARY attempt only. A model id is only
  // meaningful against the endpoint that lists it, so forcing e.g. a Sonnet id
  // onto a local Relais fallback would turn a recoverable network blip into a
  // hard "model not found". withFallbackChain calls this exactly once for the
  // primary and at most once more for the fallback, in that order, so the
  // first invocation is the primary. Keyed on call order rather than
  // config.label because labels are not unique — validateProvider permits two
  // entries to share one, and a same-labelled fallback would then wrongly
  // inherit the override.
  const enhanceModel = settings.enhanceModel.trim();
  let primaryAttempt = true;
  const outcome = await withFallbackChain(settings, provider.id, (config) => {
    const effective =
      enhanceModel && primaryAttempt ? { ...config, model: enhanceModel } : config;
    primaryAttempt = false;
    return llmClient.enhanceProse(body, effective, overrides.enhanceProse);
  });
  return {
    result: outcome.result,
    usedFallback: outcome.usedFallback,
    fallbackProviderId: outcome.fallbackProviderId,
    providerLabel: provider.label,
  };
}

/** What {@link askVault} hands back — same shape as EnhanceOutcome, for the
 * same reason (the success snackbar names the provider that answered). */
export interface AskOutcome {
  result: EnrichResult;
  usedFallback: boolean;
  fallbackProviderId: string | null;
  providerLabel: string;
}

/**
 * Answer `question` from `notes`. Routed through the same provider seam as
 * every other enrichment, so it works against OmniRoute and a local Relais
 * with no branching here.
 */
export async function askVault(
  question: string,
  notes: readonly SelectedNote[],
): Promise<AskOutcome> {
  const [settings, overrides] = await Promise.all([getSettings(), getPromptOverrides()]);
  const provider = resolveEnhanceProvider(
    settings.llmProviders,
    settings.activeProviderId,
    settings.enhanceProviderId,
  );
  const enhanceModel = settings.enhanceModel.trim();
  let primaryAttempt = true;
  const outcome = await withFallbackChain(settings, provider.id, (config) => {
    const effective =
      enhanceModel && primaryAttempt ? { ...config, model: enhanceModel } : config;
    primaryAttempt = false;
    return llmClient.askRetrospective(question, notes, effective, overrides.retrospective);
  });
  return {
    result: outcome.result,
    usedFallback: outcome.usedFallback,
    fallbackProviderId: outcome.fallbackProviderId,
    providerLabel: provider.label,
  };
}

export async function ocrCardViaVision(input: {
  base64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  const settings = await getSettings();
  const primaryId = resolveVisionProviderId(settings);
  const { result } = await withFallbackChain(settings, primaryId, (config) =>
    llmClient.ocrCardViaVision(input, config),
  );
  // No marker here: ocrCardViaVision returns raw OCR text, not a note's
  // markdown — there is no frontmatter to stamp. Its caller (enrichPerson,
  // via CaptureScreen's person flow) produces the actual note, and that
  // call's own fallback chain marks it if IT falls back.
  return result;
}

// ── On-device speech recognition (backend-agnostic) ─────────────────────────

/** Hard cap for the audio payload sent to on-device transcription. Pre-check
 * before the transcription call so users see a friendly error instead of a
 * confusing failure from the recognizer. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

/**
 * Transcribe an audio file using the on-device speech recognizer
 * (expo-speech-recognition → Google Soda on Android). Backend-agnostic —
 * doesn't route through either LLM provider — the prior chat-completion /
 * Whisper paths were swapped out after Gemini multimodal kept refusing
 * verbatim transcription via content-policy and the user's proxy didn't
 * expose a Whisper endpoint.
 *
 * On-device wins:
 *   - Free, no per-capture API cost
 *   - Private — audio never leaves the device
 *   - Works without any provider being configured / reachable
 *   - Same recognizer the Journal voice button already uses
 *
 * Caveat: requires the OS speech-recognition language pack to be
 * installed (one-time setup the user completes the first time they
 * tap any voice button — see the STT first-tap-bug memory).
 *
 * Pre-checks the 25 MB cap. Caller passes base64 (we already have it
 * from readPairedBinaryFromNote) and filename (extension matters for
 * the cache temp file's audio format detection).
 */
export async function transcribeAudio(input: {
  base64: string;
  mimeType: string;
  filename: string;
}): Promise<{ text: string; model: string }> {
  const approxBytes = Math.floor(input.base64.length * 0.75);
  if (approxBytes > MAX_TRANSCRIPTION_BYTES) {
    const mb = Math.round(approxBytes / 1024 / 1024);
    const capMb = Math.round(MAX_TRANSCRIPTION_BYTES / 1024 / 1024);
    throw new llmClient.LlmClientError(
      `Audio is ${mb} MB — transcription caps at ${capMb} MB. Split or compress before transcribing.`,
      413,
    );
  }

  // Dynamic import keeps the on-device dependency out of the
  // unit-test path (vitest can't load the native module under Node).
  // The runtime cost of the import is negligible; module cache after
  // first call.
  const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
  const text = await transcribeOnDevice({
    base64: input.base64,
    filename: input.filename,
  });
  return { text, model: "on-device" };
}

/**
 * Optional post-save hook for audio captures. When the user has flipped
 * `autoTranscribeOnSave` on in Settings, this reads the paired audio file
 * off disk, runs on-device transcription, and idempotently inserts a
 * `## Transcript` section back into the note via upsertSection.
 *
 * Best-effort by contract — NEVER throws. Returns null on success, an
 * error reason string on failure. Callers (AudioCaptureScreen,
 * ShareReceiveScreen audio branch) fire-and-forget after their saved
 * screen renders; they surface the reason in a HelperText if non-null
 * but never block the UX on a transcription failure.
 *
 * No-ops when:
 *   - autoTranscribeOnSave is false (most common path)
 *   - the note has no `../Audio/...` link (defensive)
 *   - any downstream step throws (readNote, transcribeAudio, updateNote)
 */
export async function autoTranscribeIfEnabled(
  filepath: string,
): Promise<string | null> {
  try {
    const settings = await getSettings();
    if (!settings.autoTranscribeOnSave) return null;

    const body = await readNote(filepath);
    const linkMatch = body.match(/\.\.\/Audio\/([^/\s)]+)/);
    if (!linkMatch) return "Note has no Audio/ link";
    const filename = linkMatch[1];

    const { base64, mime } = await readPairedBinaryFromNote(body);
    const { text } = await transcribeAudio({
      base64,
      mimeType: mime,
      filename,
    });
    const next = upsertSection(body, "Transcript", text);
    await updateNote(filepath, next);
    return null;
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}
