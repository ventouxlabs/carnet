import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock settings ─────────────────────────────────────────────────────────────
// BASE_SETTINGS is the default getSettings() shape with Karakeep configured.
// Hoisted via vi.hoisted so it can be referenced inside the vi.mock factory
// (which vitest hoists above module scope) and by per-test overrides.
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
    ],
    activeProviderId: "omniroute",
    nextCustomSeq: 1,
    fallbackProviderId: null,
    visionProviderId: null,
    enhanceProviderId: null,
    enhanceModel: "",
    omniRouteApiKey: "omni-key",
    localLlmApiKey: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    useExistingTagsForAutoTag: true,
    richEditorEnabled: false,
    previewBeforeSave: false,
    captureFolderPath: "",
    promptOverrides: {},
    karakeepUrl: "https://karakeep.example.com",
    karakeepApiKey: "kk-secret-token-xyz123",
  },
}));

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue(BASE_SETTINGS),
}));

// ── Mock fetch ────────────────────────────────────────────────────────────────
function makeOkResponse(json: unknown, status = 201): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  const body = JSON.stringify({ error: message });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

// ── Mock XMLHttpRequest ───────────────────────────────────────────────────────
// uploadAsset POSTs multipart via XMLHttpRequest (not fetch) — see karakeep.ts.
// Each test sets MockXHR.onSend to drive the request to load/error/timeout.
class MockXHR {
  static instances: MockXHR[] = [];
  static onSend: (xhr: MockXHR) => void = () => {};
  status = 0;
  responseText = "";
  timeout = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value;
  }
  send(body: unknown): void {
    this.body = body;
    MockXHR.instances.push(this);
    MockXHR.onSend(this); // may set status/responseText then call onload, or throw
  }
}
globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;
/** Drive the next XHR send to a successful load with the given status + JSON. */
function xhrRespond(json: unknown, status = 200): void {
  MockXHR.onSend = (xhr) => {
    xhr.status = status;
    xhr.responseText = JSON.stringify(json);
    xhr.onload?.();
  };
}

import {
  createTextBookmark,
  updateTextBookmark,
  attachTags,
  uploadAsset,
  attachAssetToBookmark,
  assetContentPath,
  KarakeepError,
  isNotConfiguredError,
} from "./karakeep";

describe("assetContentPath", () => {
  it("builds the relative /api/assets/{id} serving path", () => {
    expect(assetContentPath("as_1")).toBe("/api/assets/as_1");
  });

  it("percent-encodes an id with URL-significant characters", () => {
    expect(assetContentPath("a b/c?d")).toBe("/api/assets/a%20b%2Fc%3Fd");
  });
});

interface CreateBody {
  type: string;
  text: string;
  title?: string;
  createdAt?: string;
}

interface UpdateBody {
  type?: string;
  text: string;
  title?: string;
  createdAt?: string;
}

interface TagsBody {
  tags: Array<{ tagName: string; attachedBy: string }>;
}

beforeEach(() => {
  fetchMock.mockReset();
  MockXHR.instances = [];
  MockXHR.onSend = () => {};
});

// ── createTextBookmark ────────────────────────────────────────────────────────

describe("createTextBookmark", () => {
  it("POSTs to /api/v1/bookmarks with Bearer auth and a text body, returns the id", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_123" }));

    const result = await createTextBookmark({
      text: "# My Idea\n\nbody",
      title: "My Idea",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://karakeep.example.com/api/v1/bookmarks");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer kk-secret-token-xyz123",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );

    const body = JSON.parse(init.body as string) as CreateBody;
    expect(body.type).toBe("text");
    expect(body.text).toBe("# My Idea\n\nbody");
    expect(body.title).toBe("My Idea");

    expect(result).toEqual({ id: "bk_123" });
  });

  it("omits title and createdAt from the body when not provided", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_456" }));

    await createTextBookmark({ text: "raw text" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as CreateBody;
    expect(body.type).toBe("text");
    expect(body.text).toBe("raw text");
    expect("title" in body).toBe(false);
    expect("createdAt" in body).toBe(false);
  });

  it("includes createdAt in the body when provided", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_789" }));

    await createTextBookmark({
      text: "x",
      createdAt: "2026-06-12T10:00:00.000Z",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as CreateBody;
    expect(body.createdAt).toBe("2026-06-12T10:00:00.000Z");
  });

  it("trims trailing slashes from the configured URL", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "https://karakeep.example.com///",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_1" }));

    await createTextBookmark({ text: "x" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://karakeep.example.com/api/v1/bookmarks");
  });

  it("accepts a 200 status as success", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_200" }, 200));
    const result = await createTextBookmark({ text: "x" });
    expect(result.id).toBe("bk_200");
  });

  it("throws a not-configured KarakeepError when the URL is blank, without calling fetch", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "",
    });
    let caught: unknown;
    try {
      await createTextBookmark({ text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(0);
    expect(isNotConfiguredError(caught)).toBe(true);
    expect((caught as KarakeepError).message).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a KarakeepError with the HTTP status on a 4xx (e.g. 401)", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "Invalid API key"));
    let caught: unknown;
    try {
      await createTextBookmark({ text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(401);
    expect((caught as KarakeepError).message).toContain("Invalid API key");
    expect(isNotConfiguredError(caught)).toBe(false);
  });

  it("throws a KarakeepError with status 0 on a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    let caught: unknown;
    try {
      await createTextBookmark({ text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(0);
    expect(isNotConfiguredError(caught)).toBe(false);
  });

  it("never leaks the api key in a thrown network error message (sanitize)", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed Bearer kk-secret-token-xyz123 unreachable"),
    );
    let caught: unknown;
    try {
      await createTextBookmark({ text: "x" });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).not.toContain("kk-secret-token-xyz123");
    expect((caught as Error).message).toContain("Bearer [redacted]");
  });

  it("throws when the response has no string id", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ notId: true }));
    await expect(createTextBookmark({ text: "x" })).rejects.toThrow(
      /malformed bookmark/i,
    );
  });

  it("rejects non-https URLs (non-localhost) without calling fetch", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "http://evil.example.com",
    });
    await expect(createTextBookmark({ text: "x" })).rejects.toThrow(
      /https:\/\//,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows http://localhost for dev", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "http://localhost:3000",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_local" }));
    await expect(createTextBookmark({ text: "x" })).resolves.toEqual({
      id: "bk_local",
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/bookmarks");
  });
});

// ── attachTags ────────────────────────────────────────────────────────────────

describe("attachTags", () => {
  it("POSTs to /api/v1/bookmarks/{id}/tags with the correct body shape", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ attached: [] }, 200));

    await attachTags("bk_123", ["idea", "ml"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://karakeep.example.com/api/v1/bookmarks/bk_123/tags",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer kk-secret-token-xyz123",
    );

    const body = JSON.parse(init.body as string) as TagsBody;
    expect(body.tags).toEqual([
      { tagName: "idea", attachedBy: "human" },
      { tagName: "ml", attachedBy: "human" },
    ]);
  });

  it("does not call fetch when the tag list is empty", async () => {
    await attachTags("bk_123", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a KarakeepError on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(404, "Bookmark not found"));
    let caught: unknown;
    try {
      await attachTags("bk_missing", ["idea"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(404);
  });
});

// ── updateTextBookmark ──────────────────────────────────────────────────────────

describe("updateTextBookmark", () => {
  it("PATCHes /api/v1/bookmarks/{id} with text + title (no type field), returns the server id", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_123" }, 200));

    const result = await updateTextBookmark("bk_123", {
      text: "# Updated\n\nnew body",
      title: "Updated",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://karakeep.example.com/api/v1/bookmarks/bk_123");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer kk-secret-token-xyz123",
    );

    const body = JSON.parse(init.body as string) as UpdateBody;
    // An update must NOT re-send `type` — it's a partial patch of an existing
    // text bookmark.
    expect("type" in body).toBe(false);
    expect(body.text).toBe("# Updated\n\nnew body");
    expect(body.title).toBe("Updated");

    expect(result).toEqual({ id: "bk_123" });
  });

  it("omits title and createdAt when not provided, includes createdAt when provided", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_1" }, 200));
    await updateTextBookmark("bk_1", { text: "x" });
    let body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as UpdateBody;
    expect("title" in body).toBe(false);
    expect("createdAt" in body).toBe(false);

    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_1" }, 200));
    await updateTextBookmark("bk_1", {
      text: "x",
      createdAt: "2026-06-12T10:00:00.000Z",
    });
    body = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as UpdateBody;
    expect(body.createdAt).toBe("2026-06-12T10:00:00.000Z");
  });

  it("prefers the server-returned id over the passed id when present", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "bk_server" }, 200));
    const result = await updateTextBookmark("bk_passed", { text: "x" });
    expect(result.id).toBe("bk_server");
  });

  it("tolerates a 204/empty body — returns the passed id on a successful update", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await updateTextBookmark("bk_known", { text: "x" });
    expect(result).toEqual({ id: "bk_known" });
  });

  it("tolerates a 200 with no id — returns the passed id", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ ok: true }, 200));
    const result = await updateTextBookmark("bk_known", { text: "x" });
    expect(result).toEqual({ id: "bk_known" });
  });

  it("throws a KarakeepError with status 404 when the bookmark is gone (caller can fall back to create)", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(404, "Bookmark not found"));
    let caught: unknown;
    try {
      await updateTextBookmark("bk_deleted", { text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(404);
  });

  it("throws a not-configured KarakeepError on a blank URL without calling fetch", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "",
    });
    let caught: unknown;
    try {
      await updateTextBookmark("bk_1", { text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(isNotConfiguredError(caught)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks the api key in a thrown network error message", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed Bearer kk-secret-token-xyz123 unreachable"),
    );
    let caught: unknown;
    try {
      await updateTextBookmark("bk_1", { text: "x" });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).not.toContain("kk-secret-token-xyz123");
    expect((caught as Error).message).toContain("Bearer [redacted]");
  });

  it("rejects non-https URLs (non-localhost) without calling fetch", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "http://evil.example.com",
    });
    await expect(updateTextBookmark("bk_1", { text: "x" })).rejects.toThrow(
      /https:\/\//,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── uploadAsset ─────────────────────────────────────────────────────────────────

describe("uploadAsset", () => {
  const input = { uri: "file:///vault/Photos/a.jpg", mime: "image/jpeg", filename: "a.jpg" };

  it("POSTs multipart via XHR to /api/v1/assets with a `file` field and Bearer auth, returns assetId", async () => {
    xhrRespond({ assetId: "as_abc" }, 200);

    const result = await uploadAsset(input);

    expect(MockXHR.instances).toHaveLength(1);
    const xhr = MockXHR.instances[0];
    expect(xhr.url).toBe("https://karakeep.example.com/api/v1/assets");
    expect(xhr.method).toBe("POST");
    expect(xhr.headers["Authorization"]).toBe("Bearer kk-secret-token-xyz123");
    // No Content-Type — XHR derives the multipart boundary from the FormData.
    expect("Content-Type" in xhr.headers).toBe(false);
    expect(xhr.body).toBeInstanceOf(FormData);
    expect((xhr.body as FormData).has("file")).toBe(true);
    // The upload must go via XHR, never fetch (the fetch+FormData path crashes
    // on Hermes — see karakeep.ts).
    expect(fetchMock).not.toHaveBeenCalled();

    expect(result).toEqual({ assetId: "as_abc" });
  });

  it("accepts an `id` field as the asset id when `assetId` is absent (version variance)", async () => {
    xhrRespond({ id: "as_via_id" }, 200);
    await expect(uploadAsset(input)).resolves.toEqual({ assetId: "as_via_id" });
  });

  it("throws a malformed-asset error when the response has neither assetId nor id", async () => {
    xhrRespond({ notAssetId: true }, 200);
    await expect(uploadAsset(input)).rejects.toThrow(/malformed asset/i);
  });

  it("throws a malformed-asset error on a non-JSON 2xx body", async () => {
    MockXHR.onSend = (xhr) => {
      xhr.status = 200;
      xhr.responseText = "not json";
      xhr.onload?.();
    };
    await expect(uploadAsset(input)).rejects.toThrow(/malformed asset/i);
  });

  it("throws a KarakeepError carrying the HTTP status on a non-ok response (e.g. 413)", async () => {
    MockXHR.onSend = (xhr) => {
      xhr.status = 413;
      xhr.responseText = JSON.stringify({ error: "Payload too large" });
      xhr.onload?.();
    };
    let caught: unknown;
    try {
      await uploadAsset(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(413);
  });

  it("throws a status-0 KarakeepError on a network error", async () => {
    MockXHR.onSend = (xhr) => xhr.onerror?.();
    let caught: unknown;
    try {
      await uploadAsset(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(0);
  });

  it("throws a status-0 KarakeepError mentioning the timeout on ontimeout", async () => {
    MockXHR.onSend = (xhr) => xhr.ontimeout?.();
    let caught: unknown;
    try {
      await uploadAsset(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(0);
    expect((caught as Error).message).toMatch(/timed out/i);
  });

  it("settles (does not hang) with a status-0 KarakeepError on abort", async () => {
    MockXHR.onSend = (xhr) => xhr.onabort?.();
    let caught: unknown;
    try {
      await uploadAsset(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(0);
  });

  it("throws a not-configured KarakeepError on a blank URL without sending", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({ ...BASE_SETTINGS, karakeepUrl: "" });
    await expect(uploadAsset(input)).rejects.toThrow(/not configured/i);
    expect(MockXHR.instances).toHaveLength(0);
  });

  it("rejects non-https URLs (non-localhost) without sending", async () => {
    const { getSettings } = await import("./settings");
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      karakeepUrl: "http://evil.example.com",
    });
    await expect(uploadAsset(input)).rejects.toThrow(/https:\/\//);
    expect(MockXHR.instances).toHaveLength(0);
  });

  it("never leaks the api key in a thrown network error message", async () => {
    MockXHR.onSend = () => {
      throw new TypeError("upload failed Bearer kk-secret-token-xyz123 unreachable");
    };
    let caught: unknown;
    try {
      await uploadAsset(input);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).not.toContain("kk-secret-token-xyz123");
    expect((caught as Error).message).toContain("Bearer [redacted]");
  });
});

// ── attachAssetToBookmark ───────────────────────────────────────────────────────

interface AttachAssetBody {
  id: string;
  assetType: string;
}

describe("attachAssetToBookmark", () => {
  it("POSTs to /api/v1/bookmarks/{id}/assets with {id, assetType:'userUploaded'} by default", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "att_1" }, 201));

    await attachAssetToBookmark("bk_123", "as_abc");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://karakeep.example.com/api/v1/bookmarks/bk_123/assets");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer kk-secret-token-xyz123",
    );

    const body = JSON.parse(init.body as string) as AttachAssetBody;
    // The asset id goes in the `id` field (NOT `assetId`) per the Karakeep API.
    expect(body.id).toBe("as_abc");
    expect(body.assetType).toBe("userUploaded");
  });

  it("uses a caller-provided assetType when passed", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ id: "att_2" }, 201));
    await attachAssetToBookmark("bk_1", "as_1", "bannerImage");
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as AttachAssetBody;
    expect(body.assetType).toBe("bannerImage");
  });

  it("throws a KarakeepError carrying the status on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(404, "Bookmark not found"));
    let caught: unknown;
    try {
      await attachAssetToBookmark("bk_missing", "as_1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KarakeepError);
    expect((caught as KarakeepError).status).toBe(404);
  });
});
