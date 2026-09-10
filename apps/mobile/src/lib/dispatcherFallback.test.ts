import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Phase 3 (LLM provider list — see
// docs/superpowers/specs/2026-07-31-llm-provider-list-design.md): the
// offline fallback chain, vision routing, probeVisionReadiness credential
// preflight, and insecure-transport error handling. Split out of
// dispatcher.test.ts once that file passed 1155 lines. See
// dispatcher.test.ts for the enrichment-dispatch tests and
// dispatcherTranscription.test.ts for transcribeAudio/autoTranscribeIfEnabled.

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
  enrichIdea,
  enrichSharedImage,
  ocrCardViaVision,
  probeVisionReadiness,
  isPermanentError,
  isNotConfiguredError,
  isInsecureTransportError,
  FALLBACK_PROVIDER_FIELD,
} from "./dispatcher";
import { getSettings } from "./settings";

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

// ── Phase 3: the offline fallback chain (see the design doc's "Offline
// fallback"). PLAIN_MARKDOWN carries no frontmatter block at all, so
// sanitizeAndNormalize (enrichSanitize.ts) bails out (no header to
// normalize) and llmClient.ts falls through to sanitizeMarkdown, which is a
// no-op on threat-free plain text — that is what makes byte-for-byte
// equality assertions meaningful here rather than fighting frontmatter
// canonicalization noise unrelated to this phase.
describe("offline fallback chain (Phase 3)", () => {
  const PLAIN_MARKDOWN = "# Idea\n\nSome idea body, no frontmatter at all.\n";
  const NETWORK_ERROR = new TypeError("Network request failed");

  function withFallback(id: string | null) {
    return {
      ...BASE_SETTINGS,
      fallbackProviderId: id,
      // BASE_SETTINGS' relais entry has a blank model (it's not used as a
      // fallback target elsewhere in this file) — give it one here so a
      // relais fallback attempt reaches the network instead of failing
      // its OWN not-configured check, which would confound these tests.
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-fallback-model" } : p,
      ),
    };
  }

  it("retries the fallback once when the primary is unreachable", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("relais"));
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);
    fetchMock.mockResolvedValueOnce(makeOkResponse(PLAIN_MARKDOWN));

    const result = await enrichIdea("primary unreachable");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toBe("https://llm.example.com/v1/chat/completions");
    expect(secondUrl).toBe("http://127.0.0.1:8080/v1/chat/completions");
    // Marker present, value = fallback provider id, rest of the markdown
    // byte-identical to what the fallback returned.
    expect(result.markdown).toBe(
      `---\n${FALLBACK_PROVIDER_FIELD}: relais\n---\n${PLAIN_MARKDOWN}`,
    );
  });

  it("does NOT retry on a permanent 4xx from the primary", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("relais"));
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "bad api key"));

    await expect(enrichIdea("bad primary key")).rejects.toSatisfy(
      (e: unknown) => isPermanentError(e),
    );
    // A retry against the fallback here would mask the bad key by possibly
    // succeeding against a different (e.g. local, unauthenticated) model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates when both the primary and the fallback are unreachable", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("relais"));
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);

    await expect(enrichIdea("both unreachable")).rejects.toThrow(
      /network error/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("behaves exactly as today when no fallback is configured", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback(null));
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);

    await expect(enrichIdea("no fallback configured")).rejects.toThrow(
      /network error/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when fallbackProviderId names the same provider as the primary", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("omniroute"));
    fetchMock.mockRejectedValueOnce(NETWORK_ERROR);

    await expect(enrichIdea("fallback equals primary")).rejects.toThrow(
      /network error/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when the PRIMARY is not-configured (blank URL) — a configuration problem, not a reachability one", async () => {
    // Critical: the fallback (relais) here is a FULLY VALID, reachable
    // config (withFallback() gives it a real model + the loopback default
    // URL) — if shouldRetryWithFallback's not-configured guard were
    // missing, this retry would actually succeed against it, and the
    // assertions below (zero fetch calls, a not-configured rejection) would
    // both flip. A relais entry that was ALSO not-configured would let this
    // test pass for the wrong reason regardless of the guard.
    const settings = withFallback("relais");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...settings,
      llmProviders: settings.llmProviders.map((p) =>
        p.id === "omniroute" ? { ...p, baseUrl: "" } : p,
      ),
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse(PLAIN_MARKDOWN));

    await expect(enrichIdea("blank primary url")).rejects.toSatisfy(
      (e: unknown) => isNotConfiguredError(e),
    );
    // Never even reaches the network — assertUrlConfigured throws
    // synchronously before any fetch, and no retry against the (otherwise
    // perfectly reachable) fallback is attempted.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("leaves the primary-path markdown completely byte-identical (no marker)", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(withFallback("relais"));
    fetchMock.mockResolvedValueOnce(makeOkResponse(PLAIN_MARKDOWN));

    const result = await enrichIdea("primary succeeds, no fallback used");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe(PLAIN_MARKDOWN);
    expect(result.markdown).not.toContain(FALLBACK_PROVIDER_FIELD);
  });
});

// ── Phase 3: vision routing rung (see the design doc's "Vision routing").
// enrichSharedImage is the representative call site here — ocrCardViaVision
// shares the same resolveVisionProviderId() helper in dispatcher.ts.
describe("vision routing (Phase 3)", () => {
  it("prefers the active entry's own vision model (today's behavior, unchanged)", async () => {
    // BASE_SETTINGS' omniroute entry already has visionModel set — the
    // common case, and the one every OTHER test in this file relies on.
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichSharedImage({ base64: "abc", mimeType: "image/jpeg", context: "" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("vision-model-xyz");
  });

  it("falls back to visionProviderId's entry when the active entry has no vision model", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      visionProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) => {
        if (p.id === "omniroute") return { ...p, visionModel: "" };
        if (p.id === "relais") {
          return { ...p, baseUrl: "http://192.168.1.9:8080", model: "vision-capable-local" };
        }
        return p;
      }),
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichSharedImage({ base64: "abc", mimeType: "image/jpeg", context: "" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://192.168.1.9:8080/v1/chat/completions");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("vision-capable-local");
  });

  it("throws the existing not-configured error (no new failure mode) when neither the active entry nor visionProviderId has a vision model", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      visionProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "omniroute" ? { ...p, visionModel: "" } : p,
      ),
      // relais keeps its BASE_SETTINGS visionModel/model, both "" — no
      // vision capability there either.
    });

    await expect(
      enrichSharedImage({ base64: "abc", mimeType: "image/jpeg", context: "" }),
    ).rejects.toSatisfy((e: unknown) => isNotConfiguredError(e));
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ── Issue #129: a keyless CLOUD provider passed every readiness assert and
// then 401'd after the user had already framed and shot the card. The
// credential check is PROBE-ONLY on purpose — a genuinely keyless remote
// endpoint still works on the real capture path.

describe("probeVisionReadiness credential preflight", () => {
  /** A remote, vision-capable custom entry. providerKeys' mock returns "" for
   * any id it doesn't know, so this provider is keyless by construction. */
  const KEYLESS_REMOTE = {
    id: "custom-1",
    label: "My Cloud",
    baseUrl: "https://vision.example.com",
    model: "m",
    visionModel: "vm",
    preset: "custom",
  };

  function settingsWith(provider: typeof KEYLESS_REMOTE) {
    return {
      ...BASE_SETTINGS,
      llmProviders: [...BASE_SETTINGS.llmProviders, provider],
      activeProviderId: provider.id,
    };
  }

  it("rejects a keyless remote provider so the banner shows before the user shoots", async () => {
    vi.mocked(getSettings).mockResolvedValue(settingsWith(KEYLESS_REMOTE));

    await expect(probeVisionReadiness()).rejects.toSatisfy(
      (e: unknown) => isNotConfiguredError(e),
    );
    await expect(probeVisionReadiness()).rejects.toThrow(/My Cloud has no API key/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("passes a keyless LOOPBACK provider — relais legitimately needs no key", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      activeProviderId: "relais",
      llmProviders: BASE_SETTINGS.llmProviders.map((p) =>
        p.id === "relais" ? { ...p, model: "local-vision" } : p,
      ),
    });

    await expect(probeVisionReadiness()).resolves.toBeUndefined();
  });

  it("passes a keyless LAN provider — a self-hosted box at 192.168.x needs no key either", async () => {
    vi.mocked(getSettings).mockResolvedValue(
      settingsWith({ ...KEYLESS_REMOTE, baseUrl: "http://192.168.1.20:4000" }),
    );

    await expect(probeVisionReadiness()).resolves.toBeUndefined();
  });

  it("passes a remote provider that HAS a key", async () => {
    // omniroute's key comes from the providerKeys mock ("test-key").
    vi.mocked(getSettings).mockResolvedValue(BASE_SETTINGS);

    await expect(probeVisionReadiness()).resolves.toBeUndefined();
  });

  it("still reports the missing vision model first — the probe adds a rung, it does not reorder", async () => {
    vi.mocked(getSettings).mockResolvedValue(
      settingsWith({ ...KEYLESS_REMOTE, visionModel: "" }),
    );

    await expect(probeVisionReadiness()).rejects.toThrow(/model not configured/i);
  });

  it("does NOT block the real capture path — a keyless remote call still goes out", async () => {
    // The whole point of keeping this check probe-only: a genuinely keyless
    // remote endpoint works today, and a 401 from one is already classified
    // permanent. Moving the check into assertVisionReady/ocrCardViaVision
    // would break those setups before a single byte left the device.
    vi.mocked(getSettings).mockResolvedValue(settingsWith(KEYLESS_REMOTE));
    fetchMock.mockResolvedValueOnce(makeOkResponse("Ada Lovelace"));

    await ocrCardViaVision({ base64: "abc", mimeType: "image/jpeg" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://vision.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("insecure-transport errors and the fallback chain", () => {
  const INSECURE_REMOTE = {
    id: "custom-insecure",
    label: "Insecure Cloud",
    baseUrl: "http://vision.example.com",
    model: "m",
    visionModel: "vm",
    preset: "custom",
  };

  it("still falls back to a working secondary — the flag must not gate fallback", async () => {
    // The load-bearing invariant of issue #129's fix: flagging
    // assertHttpsOrLocal as `notConfigured` would have been a one-liner, and
    // would have silently disabled the fallback chain for EVERY misconfigured
    // primary. `insecureTransport` is a separate flag precisely so this keeps
    // working.
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      llmProviders: [
        ...BASE_SETTINGS.llmProviders.map((p) =>
          p.id === "relais" ? { ...p, model: "local-small" } : p,
        ),
        INSECURE_REMOTE,
      ],
      activeProviderId: INSECURE_REMOTE.id,
      fallbackProviderId: "relais",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("# from the fallback\n"));

    const result = await enrichIdea("insecure primary");

    // The primary never reached the network; the fallback served the call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(result.markdown).toContain("from the fallback");
  });

  it("propagates the insecure error unchanged when no fallback is configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      llmProviders: [...BASE_SETTINGS.llmProviders, INSECURE_REMOTE],
      activeProviderId: INSECURE_REMOTE.id,
    });

    await expect(enrichIdea("insecure primary")).rejects.toSatisfy(
      (e: unknown) => isInsecureTransportError(e) && !isNotConfiguredError(e),
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// #176 — per-provider consent (LlmProvider.allowInsecureTransport) bypasses
// the transport gate for THAT provider's baseUrl, threaded through
// dispatcher.ts's buildConfig into ProviderConfig.
describe("allowInsecureTransport consent (#176)", () => {
  const TAILNET_REMOTE = {
    id: "custom-tailnet",
    label: "Tailnet box",
    baseUrl: "http://my-box.tailnet.ts.net",
    model: "m",
    visionModel: "vm",
    preset: "custom",
  };

  it("consent off: the gate still blocks an http:// tailnet-hostname primary", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      llmProviders: [...BASE_SETTINGS.llmProviders, TAILNET_REMOTE],
      activeProviderId: TAILNET_REMOTE.id,
    });

    await expect(enrichIdea("consent off")).rejects.toSatisfy(
      (e: unknown) => isInsecureTransportError(e),
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("consent on: an http:// tailnet-hostname primary passes the enrichment gate", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      llmProviders: [
        ...BASE_SETTINGS.llmProviders,
        { ...TAILNET_REMOTE, allowInsecureTransport: true },
      ],
      activeProviderId: TAILNET_REMOTE.id,
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("# consented\n"));

    const result = await enrichIdea("consent on");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://my-box.tailnet.ts.net/v1/chat/completions");
    expect(result.markdown).toContain("consented");
  });

  // Devil's-advocate MEDIUM finding: buildConfig resolves the primary's and
  // the fallback's ProviderConfig from TWO SEPARATE provider entries
  // (withFallbackChain calls buildConfig once per id), so consent must never
  // bleed from one into the other — but that property was previously
  // unverified by any test. This locks it down: a CONSENTED primary that
  // fails with an unreachable-class error must still hit the transport gate
  // on a NON-consented fallback, and the resulting error must be the
  // fallback's OWN insecure-transport rejection, not a silent pass-through
  // of the primary's consent.
  it("does not bleed a consented primary's allowInsecureTransport into a non-consented fallback", async () => {
    const CONSENTED_PRIMARY = {
      id: "custom-consented-primary",
      label: "Consented primary",
      baseUrl: "http://primary.example.com",
      model: "m",
      visionModel: "vm",
      preset: "custom",
      allowInsecureTransport: true,
    };
    const NON_CONSENTED_FALLBACK = {
      id: "custom-non-consented-fallback",
      label: "Non-consented fallback",
      baseUrl: "http://fallback.example.com",
      model: "m",
      visionModel: "vm",
      preset: "custom",
      // allowInsecureTransport intentionally absent — must default to false.
    };
    vi.mocked(getSettings).mockResolvedValue({
      ...BASE_SETTINGS,
      llmProviders: [
        ...BASE_SETTINGS.llmProviders,
        CONSENTED_PRIMARY,
        NON_CONSENTED_FALLBACK,
      ],
      activeProviderId: CONSENTED_PRIMARY.id,
      fallbackProviderId: NON_CONSENTED_FALLBACK.id,
    });
    // Primary is consented, so it clears the transport gate and reaches the
    // network — where it fails with an unreachable-class (network) error,
    // the one failure class that triggers a fallback retry.
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));

    await expect(enrichIdea("no-bleed check")).rejects.toSatisfy(
      (e: unknown) => isInsecureTransportError(e),
    );
    // Exactly one fetch: the primary's failed attempt. The fallback never
    // reaches the network at all — assertHttpsOrLocal rejects it before any
    // fetch, because ITS OWN allowInsecureTransport is false/absent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
