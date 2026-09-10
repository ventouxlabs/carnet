// ── llmClient.test.ts ─────────────────────────────────────────────────────────
// The retargeted omniroute.test.ts + localLlm.test.ts suites — the safety net
// for the Phase 1 client merge (docs/superpowers/specs/2026-07-31-llm-provider-
// list-design.md). llmClient.ts reads no settings, so every call site here
// passes an explicit ProviderConfig instead of the old settings-mock-driven
// getBaseUrl/getApiKey/getModel plumbing. Test bodies are otherwise unchanged
// from their omniroute/localLlm origin — same assertions, same fixtures,
// same fetch-mock shapes — the config argument is the only structural change,
// exactly the class of change the merge's evidence tests were designed to
// tolerate.
//
// transcribeAudio/autoTranscribeIfEnabled moved to dispatcher.ts (they read
// settings + touch the writer, outside llmClient's "reads no settings"
// contract) — their retargeted tests live in dispatcher.test.ts instead.
//
// This file covers the core enrich/promote/share facade: request shape,
// timeout handling, model routing, HTTPS enforcement, prompt overrides, and
// withSystemOverride. Split out once this file passed 1078 lines:
// llmClientErrorMessages.test.ts (per-provider error message text),
// llmClientModels.test.ts (listModels/healthCheck), and
// llmClientVision.test.ts (ocrCardViaVision) — each a coherent standalone
// facade-function concern, each duplicating only the CONFIG/LOCAL_CONFIG
// fixtures and response helpers it actually needs.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  const body = JSON.stringify({ error: { message } });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeHtmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  askRetrospective,
  enrichIdea,
  enrichJournal,
  enrichPerson,
  enrichSharedImage,
  enrichSharedLink,
  promoteIdea,
  LlmClientError,
  isPermanentError,
  isNotConfiguredError,
  withSystemOverride,
  type ProviderConfig,
} from "./llmClient";
import {
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildPromoteIdeaPrompt,
  buildRetrospectivePrompt,
} from "./prompts";
import type { SelectedNote } from "./retrospective";

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

// Mirrors omniroute.test.ts's BASE_SETTINGS-derived config: an https gateway
// with distinct chat/vision models — the OmniRoute-shaped case.
const CONFIG: ProviderConfig = {
  baseUrl: "https://llm.example.com",
  apiKey: "test-key",
  model: "gpt-4o-mini",
  visionModel: "vision-model-xyz",
  label: "OmniRoute",
};

// Mirrors localLlm.test.ts's BASE_SETTINGS-derived config: a loopback server,
// no key, ONE model covering text and vision.
const LOCAL_CONFIG: ProviderConfig = {
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  model: "test-local-model",
  visionModel: "test-local-model",
  label: "Local LLM",
};

beforeEach(() => {
  fetchMock.mockReset();
});

// ── network hard timeout ──────────────────────────────────────────────────────

describe("LLM client request hard timeout", () => {
  it("rejects instead of hanging when the fetch never settles (unreachable host)", async () => {
    // Simulates the provider unreachable (e.g. Tailscale down): the fetch
    // promise never resolves and RN's AbortController.abort() does NOT
    // cancel a stuck connect. Without the Promise.race hard timeout this
    // would hang forever.
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      const assertion = expect(
        enrichIdea("offline thought", CONFIG),
      ).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(21_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the timeout as an LlmClientError with status 0 (network-class)", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      // Capture the rejection without an unhandled-rejection while advancing.
      const caught = enrichIdea("offline thought", CONFIG).then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(21_000);
      const err = await caught;
      expect(err).toBeInstanceOf(LlmClientError);
      expect((err as LlmClientError).status).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when fetch connects but the body read (response.json) never settles", async () => {
    // The subtler hang: the connection succeeds and headers arrive, but the
    // body never closes (LiteLLM SSE). A fetch-only timeout misses this; the
    // whole-operation timeout must still fire because the body read runs
    // inside it.
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}), // body never resolves
      } as unknown as Response);
      const assertion = expect(
        enrichIdea("offline thought", CONFIG),
      ).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(21_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── enrichIdea ────────────────────────────────────────────────────────────────

describe("enrichIdea", () => {
  it("POSTs to /v1/chat/completions with model + system + user messages", async () => {
    const expectedMarkdown = "---\nstatus: seedling\n---\n# My Idea\n\nbody\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse(expectedMarkdown));

    const result = await enrichIdea("my raw idea", CONFIG);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");

    const prompt = buildIdeaPrompt("my raw idea");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
    expect(body.messages[1].content).toContain("my raw idea");

    expect(result.markdown).toBe(expectedMarkdown);
    expect(result.model).toBe("test-model");
  });

  it("parses choices[0].message.content correctly", async () => {
    const md = "---\nstatus: seedling\n---\n# Cool\n\nThought.\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse(md, "omni-v2"));
    const result = await enrichIdea("cool thought", CONFIG);
    expect(result.markdown).toBe(md);
    expect(result.model).toBe("omni-v2");
  });

  it("strips defensive code fences from LLM response", async () => {
    const inner = "---\nstatus: seedling\n---\n# Title\n\nbody\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse("```markdown\n" + inner + "```"));
    const result = await enrichIdea("fenced idea", CONFIG);
    expect(result.markdown).toBe(inner.trimEnd());
  });

  it("surfaces HTTP errors with response body in the message", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    await expect(enrichIdea("x", CONFIG)).rejects.toThrow("Invalid API key");
  });

  it("throws LlmClientError with the HTTP status on a 4xx", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    let caught: unknown;
    try {
      await enrichIdea("x", CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect((caught as LlmClientError).status).toBe(401);
    expect(isPermanentError(caught)).toBe(true);
  });

  it("throws LlmClientError with status 0 on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    let caught: unknown;
    try {
      await enrichIdea("x", CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect((caught as LlmClientError).status).toBe(0);
    expect(isPermanentError(caught)).toBe(false);
    // A real network failure is transient (queue it), NOT a config problem.
    expect(isNotConfiguredError(caught)).toBe(false);
  });

  it("throws a not-configured LlmClientError when the URL is blank", async () => {
    let caught: unknown;
    try {
      await enrichIdea("x", { ...CONFIG, baseUrl: "" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    // Status 0 like a network error, but flagged not-configured so callers
    // surface it instead of silently queuing for an endpoint that can't exist.
    expect((caught as LlmClientError).status).toBe(0);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(isPermanentError(caught)).toBe(false);
    expect((caught as LlmClientError).message).toMatch(/not configured/i);
    // No fetch should even be attempted with a blank URL.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts Bearer tokens from network error messages", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed Bearer secret-token-xyz123 unreachable"),
    );
    let caught: unknown;
    try {
      await enrichIdea("x", CONFIG);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).not.toContain("secret-token-xyz123");
    expect((caught as Error).message).toContain("Bearer [redacted]");
  });

  it("throws when choices array is missing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ model: "x" }), { status: 200 }),
    );
    await expect(enrichIdea("x", CONFIG)).rejects.toThrow("empty or malformed");
  });

  it("posts to the configured base URL's /v1/chat/completions with no Authorization header when no API key is set", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("a raw thought", LOCAL_CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("test-local-model");
  });

  it("sends an Authorization header when a local-LLM API key is configured", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Idea\n\nbody\n"));

    await enrichIdea("a raw thought", { ...LOCAL_CONFIG, apiKey: "local-secret" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer local-secret");
  });

  it("classifies a 4xx response as a permanent LlmClientError", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(400, "bad request"));

    const err = await enrichIdea("doomed", LOCAL_CONFIG).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(LlmClientError);
    expect(isPermanentError(err)).toBe(true);
    expect(isNotConfiguredError(err)).toBe(false);
  });
});

// ── enrichJournal ─────────────────────────────────────────────────────────────

describe("enrichJournal", () => {
  it("POSTs with the journal prompt containing transcript", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\ndate: 2026-05-16\n---\n# Summary\n"),
    );
    await enrichJournal({ transcript: "today I met Alice", notes: "" }, CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildJournalPrompt("today I met Alice", "");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
  });
});

// ── enrichPerson ──────────────────────────────────────────────────────────────

describe("enrichPerson", () => {
  it("POSTs with the person prompt containing OCR and context", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nname: Jane Doe\n---\n# Jane Doe\n"),
    );
    await enrichPerson({ ocrResult: "Jane Doe, CEO", context: "met at conference" }, CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildPersonPrompt("Jane Doe, CEO", "met at conference");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
  });
});

// ── promoteIdea ───────────────────────────────────────────────────────────────

describe("promoteIdea", () => {
  it("POSTs with the promote prompt and returns updated markdown", async () => {
    const updatedMd = "---\nstatus: developing\n---\n# My Idea\n\nMore developed.\n";
    fetchMock.mockResolvedValueOnce(makeOkResponse(updatedMd));

    const currentMd = "---\nstatus: seedling\n---\n# My Idea\n\nRaw thought.\n";
    const result = await promoteIdea(currentMd, "developing", CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildPromoteIdeaPrompt(currentMd, "developing");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
    expect(result.markdown).toBe(updatedMd);
  });
});

describe("askRetrospective", () => {
  const NOTES: SelectedNote[] = [
    { uri: "file:///v/Ideas/a.md", title: "A", body: "notes about X", truncated: false },
  ];

  it("POSTs the retrospective prompt and returns the synthesized answer", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("You wrote about X in March."));

    const result = await askRetrospective("What did I write about X?", NOTES, CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildRetrospectivePrompt("What did I write about X?", NOTES);
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
    expect(result.markdown).toBe("You wrote about X in March.");
  });

  it("rejects a blank config URL immediately, without ever POSTing", async () => {
    await expect(
      askRetrospective("q?", NOTES, { ...CONFIG, baseUrl: "" }),
    ).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the override system message when configured", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("answer"));

    await askRetrospective(
      "q?",
      NOTES,
      CONFIG,
      "You are an extremely terse retrospective assistant.",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].content).toBe(
      "You are an extremely terse retrospective assistant.",
    );
  });
});

// ── model routing: chat vs vision (B1 model split) ───────────────────────────

describe("model routing (chat text vs image vision)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("enrichSharedImage requests the vision model, not the chat model", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nkind: shared-image\n---\n# Photo\n"),
    );

    await enrichSharedImage(
      { base64: "QkFTRTY0", mimeType: "image/jpeg", context: "test ctx" },
      CONFIG,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    // CONFIG: model = "gpt-4o-mini", visionModel = "vision-model-xyz".
    expect(body.model).toBe("vision-model-xyz");
    expect(body.model).not.toBe("gpt-4o-mini");
  });

  it("enrichIdea requests the chat model, not the vision model", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));
    await enrichIdea("a plain thought", CONFIG);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.model).not.toBe("vision-model-xyz");
  });

  it("enrichJournal requests the chat model, not the vision model", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# j\n"));
    await enrichJournal({ transcript: "today", notes: "" }, CONFIG);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("surfaces a not-configured LlmClientError when the vision model is blank", async () => {
    // Blank vision model must route through the SAME isNotConfiguredError
    // degraded path as a blank URL — never a crash, never a new error shape,
    // and never a silent fetch to a text-only fallback model.
    let caught: unknown;
    try {
      await enrichSharedImage(
        { base64: "QkFTRTY0", mimeType: "image/jpeg", context: "ctx" },
        { ...CONFIG, visionModel: "" },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(isPermanentError(caught)).toBe(false);
    expect((caught as LlmClientError).status).toBe(0);
    // No fetch attempted — the config gap short-circuits before the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── HTTPS enforcement ─────────────────────────────────────────────────────────

describe("HTTPS enforcement", () => {
  it("rejects http:// URLs (non-localhost)", async () => {
    await expect(
      enrichIdea("x", { ...CONFIG, baseUrl: "http://evil.example.com" }),
    ).rejects.toThrow(/https:\/\//);
    // Ensure no fetch was attempted
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows http://localhost for dev", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));
    await expect(
      enrichIdea("x", { ...CONFIG, baseUrl: "http://localhost:8080", apiKey: "" }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ── enrichSharedLink ──────────────────────────────────────────────────────────

describe("enrichSharedLink", () => {
  it("rejects a blank config URL immediately, without awaiting the preview fetch", async () => {
    // The preview fetch NEVER resolves. If enrichSharedLink awaited it before
    // checking config.baseUrl, this test would hang until vitest's own test
    // timeout — proving the not-configured check must fire before the
    // `await previewPromise`, not after (a blank-URL user must not wait on
    // fetchUrlPreview's 8s internal timeout for a spinner that was always
    // going nowhere).
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

    await expect(
      enrichSharedLink(
        { url: "https://example.com/article", text: "", context: "" },
        { ...CONFIG, baseUrl: "" },
      ),
    ).rejects.toThrow(/not configured/i);

    // Only the not-configured check ran — the preview fetch was never
    // resolved/consumed, and no chat-completion POST was ever reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches the URL preview and threads it into the chat prompt", async () => {
    const previewHtml = `
      <html><head>
        <title>Plain Title</title>
        <meta property="og:title" content="A Real Article">
        <meta property="og:description" content="Detailed summary here.">
        <meta property="og:site_name" content="Example News">
      </head></html>
    `;
    fetchMock.mockResolvedValueOnce(makeHtmlResponse(previewHtml));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# Saved Article\n\nbody\n"),
    );

    const result = await enrichSharedLink(
      { url: "https://example.com/article", text: "", context: "" },
      CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call: GET the page for preview
    const [previewUrl, previewInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(previewUrl).toBe("https://example.com/article");
    expect(previewInit.method).toBe("GET");
    // Second call: POST to chat completions with preview lines in user content
    const [chatUrl, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(chatUrl).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(chatInit.body as string) as RequestBody;
    expect(body.messages[1].role).toBe("user");
    const userContent = body.messages[1].content;
    expect(userContent).toContain("Site: Example News");
    expect(userContent).toContain("Page title: A Real Article");
    expect(userContent).toContain("Page description: Detailed summary here.");
    expect(userContent).toContain("URL: https://example.com/article");
    expect(result.markdown).toContain("Saved Article");
  });

  it("falls back to URL-string-only prompt when preview fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# Fallback Note\n"),
    );

    const result = await enrichSharedLink(
      { url: "https://offline.example.com/p", text: "", context: "" },
      CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(chatInit.body as string) as RequestBody;
    const userContent = body.messages[1].content;
    // Structural assertion: URL still present, no preview lines injected.
    // We deliberately do not assert on system-prompt wording — that copy
    // is allowed to evolve without breaking this test.
    expect(userContent).toContain("URL: https://offline.example.com/p");
    expect(userContent).not.toContain("Site:");
    expect(userContent).not.toContain("Page title:");
    expect(userContent).not.toContain("Page description:");
    expect(result.markdown).toContain("Fallback Note");
  });

  it("skips the preview fetch when no URL is provided (text-only share)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# Text Note\n"),
    );

    await enrichSharedLink(
      { url: "", text: "Some shared snippet of text without a URL.", context: "" },
      CONFIG,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [chatUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(chatUrl).toBe("https://llm.example.com/v1/chat/completions");
  });

  it("invokes onPreviewSettled exactly once when the preview promise resolves", async () => {
    const previewHtml = `<html><head><title>x</title></head></html>`;
    fetchMock.mockResolvedValueOnce(makeHtmlResponse(previewHtml));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# y\n"),
    );

    const settled = vi.fn();
    await enrichSharedLink(
      { url: "https://example.com/cb", text: "", context: "", onPreviewSettled: settled },
      CONFIG,
    );

    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("invokes onPreviewSettled even when the preview fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# y\n"),
    );

    const settled = vi.fn();
    await enrichSharedLink(
      { url: "https://example.com/cb-fail", text: "", context: "", onPreviewSettled: settled },
      CONFIG,
    );

    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("does not include preview lines when preview returns null fields", async () => {
    // Preview fetch succeeds but the page has no title or description.
    fetchMock.mockResolvedValueOnce(
      makeHtmlResponse("<html><head></head><body></body></html>"),
    );
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\n---\n# Empty-page Note\n"),
    );

    await enrichSharedLink(
      { url: "https://blank.example.com/", text: "", context: "" },
      CONFIG,
    );

    const [, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(chatInit.body as string) as RequestBody;
    const userContent = body.messages[1].content;
    expect(userContent).not.toContain("Site:");
    expect(userContent).not.toContain("Page title:");
  });
});

// ── withSystemOverride (pure helper) ──────────────────────────────────────────

describe("withSystemOverride", () => {
  const pair = { system: "default-system", user: "user-content" };

  it("returns the pair unchanged when override is undefined", () => {
    expect(withSystemOverride(pair, undefined)).toEqual(pair);
  });

  it("returns the pair unchanged when override is an empty string", () => {
    expect(withSystemOverride(pair, "")).toEqual(pair);
  });

  it("returns the pair unchanged when override is whitespace only", () => {
    expect(withSystemOverride(pair, "   \n\t ")).toEqual(pair);
  });

  it("swaps in the override system, preserving the user content", () => {
    const result = withSystemOverride(pair, "my custom system");
    expect(result).toEqual({
      system: "my custom system",
      user: "user-content",
    });
  });

  it("trims surrounding whitespace from the override", () => {
    const result = withSystemOverride(pair, "  trimmed  ");
    expect(result.system).toBe("trimmed");
  });
});

// ── journal + person tag slots (the LLM-tagging gap closure) ──────────────────

describe("journal + person prompts auto-tagging", () => {
  it("buildJournalPrompt requests 2-3 tags and exposes slots in frontmatter", () => {
    const { system } = buildJournalPrompt("woke up early, ran 5k", "");
    // Instruction line
    expect(system).toMatch(/Suggest 2-3 relevant tags/i);
    // Frontmatter slots — tags array starts with `journal` then user slots
    expect(system).toContain("tags: [journal, {tag1}, {tag2}]");
  });

  it("buildPersonPrompt requests tags and adds them after the base tags", () => {
    const { system } = buildPersonPrompt("John Doe\nAcme Inc.", "met at conf");
    expect(system).toMatch(/suggest 2-3 relevant tags/i);
    expect(system).toContain("tags: [person, networking, {tag1}, {tag2}]");
  });
});

// ── enrich entry points honor prompt overrides ────────────────────────────────

describe("enrich entry points honor prompt overrides", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("enrichIdea uses the override system message when configured", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea(
      "the override should reach the API",
      CONFIG,
      "You are an extremely terse summariser. Respond in one line.",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe(
      "You are an extremely terse summariser. Respond in one line.",
    );
  });

  it("enrichIdea falls back to default when override is empty", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichIdea("default path", CONFIG, "");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    // Default idea prompt contains its signature phrase
    expect(body.messages[0].content).toMatch(
      /Suggest 2-3 relevant tags|personal knowledge assistant/,
    );
  });

  it("enrichJournal applies the journal override, not the idea override", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichJournal({ transcript: "test", notes: "" }, CONFIG, "journal-custom");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].content).toBe("journal-custom");
  });

  it("enrichSharedImage applies the sharedImage override via its inline splice", async () => {
    // sharedImage uses an inline splice (not withSystemOverride) because its
    // user content is OpenAIMessage[] not PromptPair — pin the inline path so
    // it can't drift from the helper-driven entry points silently.
    fetchMock.mockResolvedValueOnce(
      makeOkResponse(
        "---\nkind: shared-image\n---\n# x\n\n## What's in this\nstuff\n",
      ),
    );

    await enrichSharedImage(
      { base64: "QkFTRTY0", mimeType: "image/jpeg", context: "test ctx" },
      CONFIG,
      "shared-image-custom-system",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("shared-image-custom-system");
    // User content stays multimodal (the image bytes still attach)
    expect(Array.isArray(body.messages[1].content)).toBe(true);
  });
});

// ── vault tag awareness (v0.4 S3) ────────────────────────────────────────────
//
// The hint must land on the FINAL system string, i.e. AFTER withSystemOverride
// has replaced it. Baking it into prompts.ts would silently drop the hint for
// anyone using PromptOverridesSection, which is the whole reason this lives at
// the entry points rather than in the builders.

describe("vault tag hint", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  function systemOf(call: number = 0): string {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    return body.messages[0].content;
  }

  it("appends the vault tag vocabulary to the system prompt", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Note"));
    await enrichIdea("some idea", CONFIG, undefined, ["dev", "journal"]);
    expect(systemOf()).toContain("dev, journal");
  });

  it("leaves the system prompt untouched when no tags are supplied", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Note"));
    await enrichIdea("some idea", CONFIG);
    expect(systemOf()).not.toContain("This vault already uses these tags");
  });

  it("keeps the tag hint when the user has overridden the system prompt", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Note"));
    await enrichIdea("some idea", CONFIG, "My own instructions.", ["dev"]);
    const system = systemOf();
    expect(system).toContain("My own instructions.");
    expect(system).toContain("dev");
  });

  it("applies the hint to journal captures", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Note"));
    await enrichJournal({ transcript: "spoke", notes: "" }, CONFIG, undefined, ["dev"]);
    expect(systemOf()).toContain("dev");
  });

  it("applies the hint to person captures", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Note"));
    await enrichPerson({ ocrResult: "card", context: "" }, CONFIG, undefined, ["dev"]);
    expect(systemOf()).toContain("dev");
  });

  it("applies the hint to shared-link captures", async () => {
    // A URL-bearing share fetches the page preview FIRST, so the chat call is
    // the second fetch — mock both and read the last call, not call 0.
    fetchMock.mockResolvedValue(makeOkResponse("# Note"));
    await enrichSharedLink(
      { url: "https://example.com", text: "", context: "" },
      CONFIG,
      undefined,
      ["dev"],
    );
    expect(systemOf(fetchMock.mock.calls.length - 1)).toContain("dev");
  });

  it("appends the hint to the multimodal shared-image system message", async () => {
    // enrichSharedImage splices the override inline rather than going through
    // withSystemOverride (its user content is multimodal), so it is the one
    // path that could regress independently.
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Note"));
    await enrichSharedImage(
      { base64: "AAAA", mimeType: "image/png", context: "" },
      CONFIG,
      undefined,
      ["dev"],
    );
    expect(systemOf()).toContain("dev");
  });

  it("keeps the hint on a shared image whose system prompt is overridden", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Note"));
    await enrichSharedImage(
      { base64: "AAAA", mimeType: "image/png", context: "" },
      CONFIG,
      "Custom image instructions.",
      ["dev"],
    );
    const system = systemOf();
    expect(system).toContain("Custom image instructions.");
    expect(system).toContain("dev");
  });
});
