/**
 * Low-level OpenAI-compatible chat wire types and the fetch primitives built
 * on them, for the merged LLM client (./llmClient). Split out of
 * llmClient.ts as a move-only extraction — see llmClient.ts's module
 * comment for the full decomposition map.
 */

import {
  filterFrontmatterKeys,
  sanitizeAndNormalize,
  sanitizeMarkdown,
  type NoteType,
} from "./enrichSanitize";
import type { PromptPair } from "./prompts";
import { parseErrorBody, sanitizeErrorMessage, withTimeout } from "./httpClient";
import { LlmClientError, timeoutError } from "./llmErrors";
import { assertHttpsOrLocal, assertUrlConfigured } from "./llmGuards";
import { isLocalNetworkUrl } from "./netAllowlist";
// Type-only — no runtime import, so this cannot form a cycle with
// llmClient.ts (which imports executeChat/chatCompletion from here at
// runtime). Same pattern as syncConflicts.ts's `import type { NoteFileRef }
// from "./writer"`.
import type { EnrichResult } from "./llmClient";

/** OpenAI-compatible content part for multimodal messages. `input_audio`
 * is the OpenAI shape that LiteLLM bridges to Gemini's audio modality and
 * to OpenAI's own gpt-4o-audio-preview. `format` is the file extension
 * minus the dot (e.g. "m4a", "mp3", "wav"). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  /** String for text-only, array for multimodal (image + text). */
  content: string | ContentPart[];
}

export interface OpenAIChoice {
  message: OpenAIMessage;
}

export interface OpenAIResponse {
  model?: string;
  choices?: OpenAIChoice[];
  error?: { message?: string };
}

// Hard ceiling on any single request. Kept short because an unreachable host
// (e.g. a gateway on a tailnet with Tailscale down) must fail fast so the
// caller's offline-queue path fires instead of spinning.
// Trade-off: a genuine generation that runs longer than this is cut off.
export const FETCH_TIMEOUT_MS = 20_000;

/**
 * Longer ceiling for Enhance. The 20s above is tuned for CAPTURE, where an
 * unreachable host must fail fast so the offline queue takes over — but
 * Enhance has no queue path (it rewrites a note already on disk), is
 * explicitly user-initiated, and exists precisely to run a slower, stronger
 * model. Measured on-device 2026-08-05: `auto/best-reasoning` over a tailnet
 * blew past 20s, timed out, fell through to the Relais fallback, and surfaced
 * as "Local LLM model not configured" — i.e. the 20s cap made the feature's
 * headline use case (pick a better model) fail, and fail misleadingly.
 */
export const ENHANCE_TIMEOUT_MS = 120_000;

/**
 * Pick the request timeout for an ENRICHMENT/chat call (issue #179).
 * `FETCH_TIMEOUT_MS` is tuned for a cloud endpoint the offline queue must
 * fail past quickly — but a LOCAL provider (loopback/LAN — Relais or a
 * self-hosted OpenAI-compatible server) can be doing real on-device
 * inference, which is a completely different latency shape than "is the
 * host even reachable". Device-verified 2026-08-18 (issue #179, #85's
 * airplane-mode acceptance run, build c7fcb19): a live, authenticated,
 * model-resident Relais (Gemma 4 E2B, Tensor G5) fell back to CPU sampling
 * mid-generation and was still writing ~30s in when Carnet's 20s timeout
 * hung up on it (`SocketException: Broken pipe` in Relais's own logcat) —
 * "Test Connection" at the same moment reported reachable, because a
 * reachability probe and a generation call have wildly different budgets.
 *
 * Reuses `ENHANCE_TIMEOUT_MS` rather than a second 120s constant: the
 * rationale is identical to Enhance's own — this ceiling exists so a
 * legitimately slower model gets to finish instead of racing a budget sized
 * for "is anyone home" — and a duplicate constant holding the same value
 * would just be one more place to keep in sync for no behavioral gain.
 *
 * Deliberately NOT applied to `healthCheck`/`listModels` (./llmClient) —
 * those are reachability probes, not inference calls, and must keep
 * failing fast so the Settings screen's "Test Connection" / model browser
 * never stalls for two minutes against a genuinely down host.
 */
export function resolveEnrichmentTimeoutMs(baseUrl: string): number {
  return isLocalNetworkUrl(baseUrl) ? ENHANCE_TIMEOUT_MS : FETCH_TIMEOUT_MS;
}

/**
 * Shared network/timeout plumbing for every fetch this client makes:
 * timeout via {@link withTimeout}, a caught fetch-level failure re-thrown as
 * a status-0 `${label} network error — ...` LlmClientError (with the raw
 * message passed through {@link sanitizeErrorMessage}), and a non-2xx
 * response re-thrown as a `${label} error — ...` LlmClientError carrying
 * the real status via {@link parseErrorBody}.
 *
 * `parseResponse` runs INSIDE the same timeout-guarded callback as the
 * fetch — not after `guardedFetch` returns — so a connection that succeeds
 * but whose body never closes (e.g. a LiteLLM SSE response `response.json()`
 * never resolves for) still times out instead of hanging forever. Any error
 * `parseResponse` throws (a malformed-response LlmClientError, say) is not
 * caught here and propagates as-is, exactly as it did when each call site
 * inlined this same try/catch.
 *
 * Used by {@link executeChat}, `listModels`, and `ocrCardViaVision`
 * (./llmClient) — all three POST/GET to this client's endpoints and need
 * identical classification of network failures and non-2xx responses.
 * `healthCheck` (./llmClient) is deliberately NOT routed through this: it
 * never throws — a network failure or non-2xx there resolves to a
 * `HealthResult` string ("unreachable"/"unauthorized"/etc.) so the Settings
 * screen's "Test Connection" button never crashes on an unsafe URL or a
 * downed server. That control-flow shape (return-a-status vs. throw) is a
 * real difference in what the call sites need, not incidental duplication,
 * so it stays a separate implementation rather than being forced through
 * this helper.
 */
export async function guardedFetch<T>(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs: number,
  parseResponse: (response: Response) => Promise<T>,
): Promise<T> {
  return await withTimeout(
    timeoutMs,
    (ms) => timeoutError(label, ms),
    async (signal) => {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal });
      } catch (e: unknown) {
        // Timeout already arrives as a shaped LlmClientError — don't double-wrap.
        if (e instanceof LlmClientError) throw e;
        const raw = e instanceof Error ? e.message : String(e);
        const msg = sanitizeErrorMessage(raw);
        throw new LlmClientError(`${label} network error — ${msg}`, 0);
      }

      // Body reads run INSIDE the timeout — a never-closing body hangs here
      // just like a stuck connect would.
      if (!response.ok) {
        throw new LlmClientError(
          `${label} error — ${await parseErrorBody(response)}`,
          response.status,
        );
      }

      return await parseResponse(response);
    },
  );
}

/**
 * Low-level POST to /v1/chat/completions. Sends arbitrary OpenAI-compatible
 * messages — text or multimodal. Used both for the text-only modes
 * (idea/journal/person) and for vision-enabled share-target enrichment.
 *
 * stream: false is REQUIRED. Some OpenAI-compatible gateways (LiteLLM-style
 * proxies) default to text/event-stream even when stream is omitted. RN's
 * fetch then hangs on `await response.json()` because the SSE body never
 * closes into a parseable JSON document.
 *
 * CONTENT-BEARING classification (#176 security review): `messages` always
 * carries the user's note text (or an image data URL), regardless of
 * whether `apiKey` is blank — so `assertHttpsOrLocal` below stays
 * UNCONDITIONAL BY DEFAULT, unlike the probe-only sites in llmClient.ts
 * (listModels/healthCheck), which skip the gate entirely for a keyless
 * call. A keyless `http://public-host` must still be refused here — UNLESS
 * the caller's resolved provider has explicit consent
 * (`allowInsecureTransport`, default false), threaded straight through.
 */
export async function executeChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  noteType: NoteType | null,
  label: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
  allowInsecureTransport = false,
): Promise<EnrichResult> {
  const trimmed = assertUrlConfigured(baseUrl, label);
  const trimmedUrl = trimmed.replace(/\/+$/, "");
  assertHttpsOrLocal(trimmedUrl, label, allowInsecureTransport);

  const url = `${trimmedUrl}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false });

  return await guardedFetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
    },
    label,
    timeoutMs,
    async (response) => {
      const json = (await response.json()) as OpenAIResponse;
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim().length) {
        throw new LlmClientError(
          `${label} returned an empty or malformed response`,
          response.status,
        );
      }

      const markdown = gateModelMarkdown(stripCodeFences(content), noteType);
      const modelUsed = json.model ?? model;
      return { markdown, model: modelUsed };
    },
  );
}

/**
 * Security gate (B3) for every model reply: neutralize any executable content
 * the model emitted (Dataview/Templater/raw HTML/javascript: links) and, for a
 * note type, canonicalize the frontmatter BEFORE the markdown reaches any
 * caller or the vault. Neutralization is unconditional; when frontmatter
 * normalization fails (malformed / missing required keys) the neutralized —
 * and therefore inert — markdown is still returned rather than a note that
 * could execute. The key allowlist applies to BOTH branches: a reply that
 * omits a required key must not smuggle `dg-publish: true` through the
 * fallback.
 *
 * `noteType: null` marks a BODY-ONLY reply (Enhance, Ask) with no frontmatter
 * contract: it lands below an app-owned header, so a leading `---` block in it
 * is prose, and a key allowlist would delete that prose.
 */
function gateModelMarkdown(stripped: string, noteType: NoteType | null): string {
  if (noteType === null) return sanitizeMarkdown(stripped);
  return filterFrontmatterKeys(
    sanitizeAndNormalize(stripped, noteType) ?? sanitizeMarkdown(stripped),
    noteType,
  );
}

/**
 * Text-only chat completion. Builds [system, user] from a PromptPair and
 * delegates to executeChat. Used for the idea / journal / person modes.
 */
export async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: PromptPair,
  noteType: NoteType | null,
  label: string,
  timeoutMs?: number,
  allowInsecureTransport = false,
): Promise<EnrichResult> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  return executeChat(
    baseUrl,
    apiKey,
    model,
    messages,
    noteType,
    label,
    timeoutMs,
    allowInsecureTransport,
  );
}

/** Strip a leading ``` fence (and matching trailer). Does not trim unfenced content. */
export function stripCodeFences(raw: string): string {
  const leftTrimmed = raw.trimStart();
  if (!leftTrimmed.startsWith("```")) return raw;
  const rest = leftTrimmed.slice(3);
  const afterLang = rest.includes("\n") ? rest.slice(rest.indexOf("\n") + 1) : rest;
  const stripped = afterLang.trimEnd().endsWith("```")
    ? afterLang.trimEnd().slice(0, -3).trimEnd()
    : afterLang;
  return stripped;
}
