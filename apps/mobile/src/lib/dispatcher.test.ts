import { beforeEach, describe, expect, it, vi } from "vitest";

// ── LLM provider list Phase 1: dispatcher.ts no longer swaps between two
// whole client modules (omniroute.ts / localLlm.ts) — both were merged into
// ONE llmClient.ts, parameterized by a ProviderConfig dispatcher.ts resolves
// from settings. So these tests exercise the REAL llmClient.ts (unmocked)
// against a mocked global fetch, and verify "did the dispatcher route to the
// right backend" via the resulting HTTP request (URL + model) rather than via
// module-identity/call-count assertions — there's no second module left to
// assert "was NOT called" against.
//
// This file covers enrichment dispatch: enhanceProse routing, backend
// routing (buildConfig), the online enrichIdea path, error classification,
// and per-mode prompt override forwarding. On-device transcription
// (transcribeAudio/autoTranscribeIfEnabled) lives in
// dispatcherTranscription.test.ts; the Phase 3 offline fallback chain,
// vision routing, probeVisionReadiness, and insecure-transport handling live
// in dispatcherFallback.test.ts — split out once this file passed 1155
// lines, each file duplicating only the mock/setup boilerplate it needs.

const { BASE_SETTINGS } = vi.hoisted(() => ({
  BASE_SETTINGS: {
    llmProviders: [
      {
        id: "omniroute",
        label: "OmniRoute",
        baseUrl: "https://llm.example.com",
        model: "gpt-4o-mini",
        visionModel: "vision-model-xyz",
        preset: "omniroute",
      },
      {
        id: "relais",
        label: "Relais (local)",
        baseUrl: "http://127.0.0.1:8080",
        model: "",
        visionModel: "",
        preset: "relais",
      },
    ],
    activeProviderId: "omniroute",
    nextCustomSeq: 1,
    fallbackProviderId: null,
    visionProviderId: null,
    enhanceProviderId: null,
    enhanceModel: "",
    omniRouteApiKey: "test-key",
    localLlmApiKey: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    useExistingTagsForAutoTag: true,
    richEditorEnabled: false,
    previewBeforeSave: false,
    captureFolderPath: "",
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "",
  },
}));

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue(BASE_SETTINGS),
  getPromptOverrides: vi.fn().mockResolvedValue({}),
  DEFAULT_OMNIROUTE_MODEL: "openrouter/openai/gpt-4o-mini",
}));

// providerKeys.ts is the real per-provider SecureStore lookup — mocked here
// so this suite doesn't need a native SecureStore shim. Routes the two known
// ids to BASE_SETTINGS' key fields; anything else gets "" (no custom-provider
// key tests in this file).
vi.mock("./vaultTagHint", () => ({
  getVaultTagStrings: vi.fn(async () => []),
}));

vi.mock("./providerKeys", () => ({
  getKey: vi.fn(async (id: string) => {
    if (id === "omniroute") return BASE_SETTINGS.omniRouteApiKey;
    if (id === "relais") return BASE_SETTINGS.localLlmApiKey;
    return "";
  }),
  setKey: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("./writer", () => ({
  readNote: vi.fn(),
  readPairedBinaryFromNote: vi.fn(),
  updateNote: vi.fn(),
  upsertSection: vi.fn(
    (md: string, heading: string, body: string) =>
      `${md}\n\n## ${heading}\n\n${body}\n`,
  ),
}));

vi.mock("./audioTranscribeOnDevice", () => ({
  transcribeOnDevice: vi.fn(),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  askVault,
  enrichIdea,
  enhanceProse,
  enrichJournal,
  enrichPerson,
  enrichSharedImage,
  enrichSharedLink,
  promoteIdea,
  isPermanentError,
  isNotConfiguredError,
} from "./dispatcher";
import * as llmClient from "./llmClient";
import { getSettings, getPromptOverrides } from "./settings";
import { getVaultTagStrings } from "./vaultTagHint";

function makeOkResponse(markdown: string, model = "test-model"): Response {
  const body = JSON.stringify({
    model,
    choices: [{ message: { role: "assistant", content: markdown } }],
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(getSettings).mockResolvedValue(BASE_SETTINGS);
});

// ── Required test 1 + 2: the dispatcher resolves the right ProviderConfig per
// backend and reaches the real llmClient.ts with it — the load-bearing "zero
// behavior change" guarantee for existing users, now verified via the actual
// HTTP request rather than via a second module's call count.

describe("enhanceProse routing", () => {
  it("uses the active provider when no enhanceProviderId is set", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("routes to enhanceProviderId's entry OVER the active one", async () => {
    // The test that proves "a better llm" actually takes effect. The active
    // entry has a perfectly good text model; the Enhance entry must still win.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais"
          ? { ...p, baseUrl: "http://127.0.0.1:8080", model: "big-local-model" }
          : p,
      ),
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    const outcome = await enhanceProse("rough prose");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("big-local-model");
    expect(outcome.providerLabel).toBe("Relais (local)");
  });

  it("falls back to the active entry when enhanceProviderId is stale", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceProviderId: "custom-deleted",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
  });

  it("sends enhanceModel instead of the provider's own model", async () => {
    // The point of the feature: same endpoint, stronger model. Captures keep
    // running on gpt-4o-mini; Enhance overrides just the model string.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceModel: "anthropic/claude-sonnet-5",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("anthropic/claude-sonnet-5");
  });

  it("treats a whitespace-only enhanceModel as unset", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceModel: "   ",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("does NOT force enhanceModel onto the fallback provider", async () => {
    // A model id only exists on the endpoint that listed it. Carrying a
    // Sonnet id onto the local Relais fallback would turn a recoverable
    // network blip into a hard "model not found".
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceModel: "anthropic/claude-sonnet-5",
      fallbackProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-small" } : p,
      ),
    });
    // Primary attempt fails in the unreachable class, triggering the retry.
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    await enhanceProse("rough prose");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const primary = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    const fallback = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    expect(primary.model).toBe("anthropic/claude-sonnet-5");
    expect(fallback.model).toBe("local-small");
  });

  it("keeps the PRIMARY error when the fallback is merely unconfigured", async () => {
    // Observed on-device 2026-08-05: OmniRoute timed out on a slow reasoning
    // model, the chain retried an unconfigured Relais, and the user was told
    // "Local LLM model not configured — set it in Settings". That names the
    // wrong provider and hides the real fault, so the primary error must win.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      fallbackProviderId: "relais", // relais has model: "" -> not configured
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));

    await expect(enhanceProse("rough prose")).rejects.toThrow(/Network request failed/);
    // The fallback never got as far as a request — it failed on config.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still surfaces a fallback error when the fallback genuinely tried", async () => {
    // A configured fallback that actually attempted and failed reflects a real
    // second attempt, so its error is the honest one to show.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      fallbackProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-small" } : p,
      ),
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "fallback key rejected"));

    await expect(enhanceProse("rough prose")).rejects.toThrow(/fallback key rejected/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns prose with NO frontmatter marker spliced into it", async () => {
    // enhanceProse is the one entry point that must skip withFallbackMarker:
    // the result is bare prose, so a marker would prepend a stray `---` block
    // into the note body. lib/enhanceProse.ts stamps AFTER re-attaching the
    // real frontmatter instead.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      fallbackProviderId: "relais",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("polished prose"));

    const outcome = await enhanceProse("rough prose");

    expect(outcome.result.markdown).not.toContain("---");
    expect(outcome.result.markdown).toContain("polished prose");
  });
});

describe("dispatcher backend routing", () => {
  it("routes to the OmniRoute config when llmBackend is 'omniroute' (the default)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("route to omniroute");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("routes to the local-LLM config when llmBackend is 'local'", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      activeProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais"
          ? { ...p, baseUrl: "http://127.0.0.1:8080", model: "local-model" }
          : p,
      ),
    });
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("# from local\n", "local-model"),
    );

    const result = await enrichIdea("route to local");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("local-model");
    // The user's text must actually be forwarded, not just the URL/model —
    // the OmniRoute routing test asserts the equivalent via
    // body.messages.at(-1)?.content in the "online path" describe below;
    // this restores the same check for the local backend.
    expect(body.messages.at(-1)?.content).toContain("route to local");
    expect(result.markdown).toBe("# from local\n");
  });

  it("defaults the local backend's blank URL to the loopback address", async () => {
    // localLlmUrl blank is a valid, expected state for the local backend
    // (zero-setup disconnected flow) — unlike OmniRoute's blank URL, which is
    // not-configured. This defaulting now lives in dispatcher.ts's
    // buildConfig (it used to live in localLlm.ts's getBaseUrl()).
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      activeProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, baseUrl: "", model: "local-model" } : p,
      ),
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("# from local\n"));

    await enrichIdea("blank local url");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });

  it("names the relais entry's OWN (possibly user-edited) label in its error messages, not a hardcoded 'Local LLM'", async () => {
    // buildConfig used to hard-code label: "Local LLM" for relais regardless
    // of the entry's actual label — adjacent surfaces that read
    // resolveActiveProvider(...).label directly (e.g. syncStatus.ts,
    // CaptureScreen's providerLabel) would then disagree with dispatcher's
    // own error wording for the very same provider. A renamed entry exposes
    // the mismatch most clearly.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      activeProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, label: "My Local Box", model: "" } : p,
      ),
    });

    await expect(enrichIdea("blank model")).rejects.toThrow(
      "My Local Box model not configured — set it in Settings",
    );
  });
});

describe("dispatcher online path (enrichIdea) hits the same HTTP request", () => {
  it("posts to /v1/chat/completions with the configured model + user text", async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("a raw thought via the dispatcher");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(false);
    expect(body.messages.at(-1)?.content).toContain(
      "a raw thought via the dispatcher",
    );
  });

  it("produces an identical request whether called via the dispatcher or llmClient directly with the equivalent config", async () => {
    // Fresh Response per call — a Response body can only be read once.
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeOkResponse("# Same\n\nbody\n")),
    );

    await enrichIdea("parity check");
    const [dispUrl, dispInit] = fetchMock.mock.calls[0] as [string, RequestInit];

    fetchMock.mockClear();
    const omniroute = BASE_SETTINGS.llmProviders.find((p) => p.id === "omniroute")!;
    await llmClient.enrichIdea("parity check", {
      baseUrl: omniroute.baseUrl,
      apiKey: BASE_SETTINGS.omniRouteApiKey,
      model: omniroute.model,
      visionModel: omniroute.visionModel,
      label: "OmniRoute",
    });
    const [directUrl, directInit] = fetchMock.mock.calls[0] as [string, RequestInit];

    // Compare the request essentials — URL, method, headers, and body. The
    // per-call AbortSignal instance differs by design, so it's excluded.
    expect(dispUrl).toBe(directUrl);
    expect(dispInit.method).toBe(directInit.method);
    expect(dispInit.headers).toEqual(directInit.headers);
    expect(dispInit.body).toBe(directInit.body);
  });
});

// ── Required test 3: the error predicates still correctly classify errors that
// flow through the dispatcher — a permanent (4xx) failure and a not-configured
// (blank URL) failure, both surfaced via a dispatcher enrich call.

describe("dispatcher preserves error classification", () => {
  it("classifies a 4xx from a dispatcher enrich call as permanent", async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(401, "Unauthorized"));

    const err = await enrichIdea("doomed").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(llmClient.LlmClientError);
    expect(isPermanentError(err)).toBe(true);
    expect(isNotConfiguredError(err)).toBe(false);
  });

  it("classifies a blank-URL failure through the dispatcher as not-configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "omniroute" ? { ...p, baseUrl: "" } : p,
      ),
    });

    const err = await enrichIdea("no url set").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(llmClient.LlmClientError);
    expect(isNotConfiguredError(err)).toBe(true);
    // A not-configured failure is NOT a permanent 4xx — the drain must break
    // and wait rather than burn retries.
    expect(isPermanentError(err)).toBe(false);
    // No HTTP request should have been attempted with a blank URL.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a transient network failure through the dispatcher as neither permanent nor not-configured", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));

    const err = await enrichIdea("blip").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(llmClient.LlmClientError);
    expect(isPermanentError(err)).toBe(false);
    expect(isNotConfiguredError(err)).toBe(false);
  });
});

// ── dispatcher forwards the CORRECT per-mode prompt override ─────────────────
// Pre-merge, omniroute.test.ts mocked getPromptOverrides and asserted the
// override reached body.messages[0].content directly inside omniroute.ts.
// That responsibility moved into dispatcher.ts's buildConfig/overrides
// plumbing (llmClient.ts now only proves it uses whatever override string
// it's handed as an argument — see llmClient.test.ts's "enrich entry points
// honor prompt overrides"). These tests close the gap: a dispatcher that
// forwarded the WRONG override field (e.g. overrides.journal into
// enrichIdea) or dropped the argument entirely would pass every other test
// in this suite. Each override string below is distinct so a mismatched
// wire-up fails loudly rather than by coincidence.

describe("dispatcher forwards the correct per-mode prompt override", () => {
  it("enrichIdea forwards overrides.idea", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      idea: "OVERRIDE-IDEA-7f3a",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("text");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-IDEA-7f3a");
  });

  it("enrichJournal forwards overrides.journal", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      journal: "OVERRIDE-JOURNAL-9c1d",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichJournal({ transcript: "t", notes: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-JOURNAL-9c1d");
  });

  it("enrichPerson forwards overrides.person", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      person: "OVERRIDE-PERSON-2e8b",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichPerson({ ocrResult: "Jane Doe", context: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-PERSON-2e8b");
  });

  it("enrichSharedImage forwards overrides.sharedImage", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      sharedImage: "OVERRIDE-SHAREDIMAGE-4b6f",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichSharedImage({ base64: "abc", mimeType: "image/jpeg", context: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-SHAREDIMAGE-4b6f");
  });

  it("enrichSharedLink forwards overrides.sharedLink", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      sharedLink: "OVERRIDE-SHAREDLINK-5d0a",
    });
    // url: "" skips the preview fetch entirely (text-only share) — keeps
    // this test to a single fetch call, matching the pattern already used
    // elsewhere for the no-preview path.
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichSharedLink({ url: "", text: "some shared text", context: "" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toBe("OVERRIDE-SHAREDLINK-5d0a");
  });

  it("promoteIdea applies NO override — the current, correct behaviour", async () => {
    // Even with every override field populated, promoteIdea must never read
    // any of them: dispatcher.ts's promoteIdea only calls getSettings(), not
    // getPromptOverrides() — matching omniroute.ts's original promoteIdea,
    // which never threaded prompt overrides either.
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      idea: "OVERRIDE-IDEA-7f3a",
      journal: "OVERRIDE-JOURNAL-9c1d",
      person: "OVERRIDE-PERSON-2e8b",
      sharedImage: "OVERRIDE-SHAREDIMAGE-4b6f",
      sharedLink: "OVERRIDE-SHAREDLINK-5d0a",
    });
    const currentMd = "---\nstatus: seedling\n---\n# My Idea\n\nRaw thought.\n";
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: developing\n---\n# My Idea\n\nMore.\n"),
    );

    await promoteIdea(currentMd, "developing");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).not.toContain("OVERRIDE-");
  });
});

describe("askVault routing", () => {
  it("resolves the enhance provider and returns its label with the result", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("You wrote about X in March."));

    const outcome = await askVault("What did I write about X?", [
      { uri: "file:///v/Ideas/a.md", title: "A", body: "notes about X", truncated: false },
    ]);

    expect(outcome.providerLabel).toBe("OmniRoute");
    expect(outcome.result.markdown).toBe("You wrote about X in March.");
    expect(outcome.usedFallback).toBe(false);
  });

  it("falls back to the fallback provider on a retryable primary failure", async () => {
    // Same shape as "does NOT force enhanceModel onto the fallback provider"
    // above: the primary attempt fails in the unreachable class, triggering
    // exactly one retry against the configured fallback.
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      fallbackProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-small" } : p,
      ),
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    fetchMock.mockResolvedValueOnce(makeOkResponse("fallback answer"));

    const outcome = await askVault("q?", []);

    expect(outcome.usedFallback).toBe(true);
    expect(outcome.fallbackProviderId).toBe("relais");
    expect(outcome.result.markdown).toBe("fallback answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT force enhanceModel onto the fallback provider", async () => {
    // Verbatim twin of the enhanceProse case above, and that duplication is
    // the point: askVault carries its own copy of the primary-only model
    // latch. Until this test existed the copy was inert under test —
    // BASE_SETTINGS.enhanceModel is "" and the askVault fallback test above
    // never inspects a request body, so deleting `primaryAttempt` from
    // askVault failed nothing and the two copies could silently drift. This
    // is the feature's headline cross-backend path (remote primary, local
    // Relais fallback), which is exactly where forcing a primary's model id
    // onto an endpoint that never listed it turns a recoverable network blip
    // into a hard "model not found".
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      enhanceModel: "anthropic/claude-sonnet-5",
      fallbackProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-small" } : p,
      ),
    });
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    fetchMock.mockResolvedValueOnce(makeOkResponse("fallback answer"));

    await askVault("q?", []);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const primary = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    const fallback = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as { model: string };
    expect(primary.model).toBe("anthropic/claude-sonnet-5");
    expect(fallback.model).toBe("local-small");
  });
});

// ── vault tag awareness (v0.4 S3) ────────────────────────────────────────────
//
// Same rationale as the prompt-override block above: llmClient applies the
// hint, but only the dispatcher decides WHETHER to (the setting) and WHAT
// vocabulary to pass. A dispatcher that dropped the argument or ignored the
// toggle would pass every llmClient test.

describe("dispatcher threads the vault tag vocabulary", () => {
  function systemOf(call = 0): string {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return (JSON.parse(init.body as string) as { messages: Array<{ content: string }> })
      .messages[0].content;
  }

  it("passes the vocabulary when useExistingTagsForAutoTag is true", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      useExistingTagsForAutoTag: true,
    });
    vi.mocked(getVaultTagStrings).mockResolvedValueOnce(["dev", "journal"]);
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("text");

    expect(systemOf()).toContain("dev, journal");
  });

  it("passes nothing when useExistingTagsForAutoTag is false", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      useExistingTagsForAutoTag: false,
    });
    vi.mocked(getVaultTagStrings).mockResolvedValueOnce(["dev", "journal"]);
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("text");

    expect(systemOf()).not.toContain("This vault already uses these tags");
  });

  it("keeps the vocabulary alongside a per-mode prompt override", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      useExistingTagsForAutoTag: true,
    });
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      idea: "OVERRIDE-IDEA-b21e",
    });
    vi.mocked(getVaultTagStrings).mockResolvedValueOnce(["dev"]);
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("text");

    const system = systemOf();
    expect(system).toContain("OVERRIDE-IDEA-b21e");
    expect(system).toContain("dev");
  });

  it("still enriches when the tag lookup yields nothing", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      useExistingTagsForAutoTag: true,
    });
    vi.mocked(getVaultTagStrings).mockResolvedValueOnce([]);
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await expect(enrichIdea("text")).resolves.toBeTruthy();
    expect(systemOf()).not.toContain("This vault already uses these tags");
  });
});
