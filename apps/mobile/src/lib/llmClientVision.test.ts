// ── llmClientVision.test.ts ───────────────────────────────────────────────────
// Split out of llmClient.test.ts once that file passed 1078 lines —
// ocrCardViaVision (business-card OCR folded into chat vision, B2) is a
// coherent standalone facade-function concern, distinct from the
// enrich/promote content facade covered in llmClient.test.ts.

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

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  classifyBusinessCardViaVision,
  ocrCardViaVision,
  LlmClientError,
  isPermanentError,
  isNotConfiguredError,
  type ProviderConfig,
} from "./llmClient";

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

describe("ocrCardViaVision", () => {
  const CARD_PROMPT =
    "Transcribe ALL text on this business card exactly as printed. Preserve every field: name, title, company, phone numbers, email addresses, websites, physical address, and any other text. Output plain text, one field per line. Do not invent, omit, or normalize anything.";

  it("posts a single multimodal user turn to /v1/chat/completions using the vision model", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("Jane Doe\nCEO\nACME"));

    const result = await ocrCardViaVision(
      { base64: "QkFTRTY0", mimeType: "image/png" },
      CONFIG,
    );

    expect(result).toEqual({ text: "Jane Doe\nCEO\nACME" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      temperature: number;
      messages: Array<{ role: string; content: unknown }>;
    };
    // Vision model, not the chat model; deterministic; non-streaming.
    expect(body.model).toBe("vision-model-xyz");
    expect(body.model).not.toBe("gpt-4o-mini");
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0);
    // Single user turn only — no system message.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: CARD_PROMPT },
      { type: "image_url", image_url: { url: "data:image/png;base64,QkFTRTY0" } },
    ]);
    // Auth header threaded through.
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("preserves model output verbatim for raw OCR provenance", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("  Jane Doe, CEO \n"));
    const result = await ocrCardViaVision({ base64: "abc", mimeType: "image/jpeg" }, CONFIG);
    expect(result).toEqual({ text: "  Jane Doe, CEO \n" });
  });

  it("falls back to image/jpeg for a non-allowlisted mime", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("ok"));
    await ocrCardViaVision({ base64: "abc", mimeType: "application/octet-stream" }, CONFIG);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
    };
    expect(body.messages[0].content[1].image_url?.url).toBe(
      "data:image/jpeg;base64,abc",
    );
  });

  it("throws 'no OCR text' when the model returns empty content", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("   "));
    await expect(
      ocrCardViaVision({ base64: "abc", mimeType: "image/jpeg" }, CONFIG),
    ).rejects.toThrow("OmniRoute response contained no OCR text");
  });

  it("uses the long local-inference timeout tier for a local baseUrl, not the short reachability tier (#179)", async () => {
    // ocrCardViaVision used to hardcode FETCH_TIMEOUT_MS regardless of
    // provider — vision OCR against a cold local model has the same
    // slow-generation shape as text enrichment, so it now goes through
    // resolveEnrichmentTimeoutMs (./llmHttp) like the rest of enrichment.
    vi.useFakeTimers();
    try {
      fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
      let settled = false;
      let err: unknown;
      void ocrCardViaVision({ base64: "abc", mimeType: "image/jpeg" }, LOCAL_CONFIG).then(
        (v) => {
          settled = true;
          return v;
        },
        (e: unknown) => {
          settled = true;
          err = e;
        },
      );
      // Well past the old 20s short tier — must NOT have settled yet.
      await vi.advanceTimersByTimeAsync(21_000);
      expect(settled).toBe(false);
      // Advance to just past the 120s long tier and confirm it now has.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(settled).toBe(true);
      expect((err as Error).message).toBe(
        "Local LLM unreachable — timed out after 120s.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a permanent LlmClientError on a 4xx response", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    let caught: unknown;
    try {
      await ocrCardViaVision({ base64: "abc", mimeType: "image/jpeg" }, CONFIG);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect(isPermanentError(caught)).toBe(true);
  });

  it("surfaces a not-configured LlmClientError when the vision model is blank", async () => {
    let caught: unknown;
    try {
      await ocrCardViaVision(
        { base64: "abc", mimeType: "image/jpeg" },
        { ...CONFIG, visionModel: "" },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a not-configured LlmClientError when the URL is blank", async () => {
    let caught: unknown;
    try {
      await ocrCardViaVision(
        { base64: "abc", mimeType: "image/jpeg" },
        { ...CONFIG, baseUrl: "" },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmClientError);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Parity guarantees carried over from the retired ocr.test.ts: URL trim and
  // no-key header omission were explicit assertions for the old /v1/ocr client
  // and must hold for the vision path too.
  it("trims trailing slashes from the base URL", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("ok"));
    await ocrCardViaVision(
      { base64: "abc", mimeType: "image/jpeg" },
      { ...CONFIG, baseUrl: "https://llm.example.com///" },
    );
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("ok"));
    await ocrCardViaVision(
      { base64: "abc", mimeType: "image/jpeg" },
      { ...CONFIG, apiKey: "" },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("uses the single configured model (no separate vision model) for the local backend", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("Jane Doe\nCEO\njane@example.com"));

    const result = await ocrCardViaVision(
      { base64: "abc123", mimeType: "image/jpeg" },
      LOCAL_CONFIG,
    );

    expect(result.text).toBe("Jane Doe\nCEO\njane@example.com");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("test-local-model");
  });
});

describe("classifyBusinessCardViaVision", () => {
  it("asks the vision model for one fail-closed classification label before OCR", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse(" uncertain "));

    const result = await classifyBusinessCardViaVision(
      { base64: "QkFTRTY0", mimeType: "image/png" },
      CONFIG,
    );

    expect(result).toEqual({ classification: "uncertain" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.model).toBe("vision-model-xyz");
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Is this image a business card? Reply with exactly one label: card, not-card, or uncertain. Use uncertain whenever the image is ambiguous, unreadable, or not clearly a business card.",
          },
          { type: "image_url", image_url: { url: "data:image/png;base64,QkFTRTY0" } },
        ],
      },
    ]);
  });
});
