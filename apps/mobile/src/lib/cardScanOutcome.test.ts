import { beforeEach, describe, expect, it, vi } from "vitest";

// Same seam as captureErrorDecision.test.ts: ./dispatcher pulls the React
// Native module graph, so the predicates are mocked here. Their real contract
// (status 0 + `notConfigured` flag, blank vision model included) is covered
// against real LlmClientError shapes in llmClient.test.ts:211-222 and 476-490.
const isPermanentErrorMock = vi.fn().mockReturnValue(false);
const isNotConfiguredErrorMock = vi.fn().mockReturnValue(false);
const isInsecureTransportErrorMock = vi.fn().mockReturnValue(false);
const probeVisionReadinessMock = vi.fn(async () => undefined);

vi.mock("./dispatcher", () => ({
  isPermanentError: (...args: unknown[]) => isPermanentErrorMock(...args),
  isNotConfiguredError: (...args: unknown[]) => isNotConfiguredErrorMock(...args),
  isInsecureTransportError: (...args: unknown[]) => isInsecureTransportErrorMock(...args),
  probeVisionReadiness: () => probeVisionReadinessMock(),
}));

import {
  cardScanHint,
  cardScanPreflightHint,
  classifyCardScanOcrError,
  probeCardScanReadiness,
} from "./cardScanOutcome";

beforeEach(() => {
  isPermanentErrorMock.mockReturnValue(false);
  isNotConfiguredErrorMock.mockReturnValue(false);
  isInsecureTransportErrorMock.mockReturnValue(false);
  probeVisionReadinessMock.mockReset().mockResolvedValue(undefined);
});

describe("classifyCardScanOcrError", () => {
  it("classifies an unconfigured provider from the typed flag, not the message text", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    const error = new Error("OmniRoute URL not configured — set it in Settings");

    expect(classifyCardScanOcrError(error)).toEqual({
      kind: "notConfigured",
      message: "OmniRoute URL not configured — set it in Settings",
    });
    expect(isNotConfiguredErrorMock).toHaveBeenCalledWith(error);
  });

  it("keeps the provider's own wording so a blank vision model stays distinguishable from a blank URL", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    expect(classifyCardScanOcrError(new Error("Vision model not configured — set it in Settings")).message)
      .toContain("Vision model");
  });

  it("classifies an insecure remote URL as configuration, never as a retryable outage", () => {
    // assertHttpsOrLocal carries `insecureTransport`, NOT `notConfigured` — the
    // latter would disable the provider fallback chain. Post-capture copy must
    // still send the user to Settings rather than tell them to scan again,
    // which can never succeed against a plain-http remote URL.
    isInsecureTransportErrorMock.mockReturnValue(true);
    const message =
      "OmniRoute URL must use https:// (or be a loopback/LAN address) to protect the API key";

    const outcome = classifyCardScanOcrError(new Error(message));

    expect(outcome).toEqual({ kind: "notConfigured", message });
    expect(cardScanHint(outcome)).not.toMatch(/scan again/i);
  });

  it("classifies an insecure transport before consulting the 4xx status", () => {
    isInsecureTransportErrorMock.mockReturnValue(true);
    isPermanentErrorMock.mockReturnValue(true);
    expect(classifyCardScanOcrError(new Error("ambiguous")).kind).toBe("notConfigured");
  });

  it("classifies a 4xx as permanent", () => {
    isPermanentErrorMock.mockReturnValue(true);
    expect(classifyCardScanOcrError(new Error("OmniRoute error — bad api key")).kind).toBe("permanent");
  });

  it("classifies anything unflagged as transient", () => {
    expect(classifyCardScanOcrError(new Error("OmniRoute network error — timeout")).kind).toBe("transient");
  });

  it("prefers notConfigured when an error somehow satisfies both predicates", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    isPermanentErrorMock.mockReturnValue(true);
    expect(classifyCardScanOcrError(new Error("ambiguous")).kind).toBe("notConfigured");
  });

  it("treats a non-Error throw as transient without crashing", () => {
    expect(classifyCardScanOcrError("boom")).toEqual({ kind: "transient", message: "boom" });
  });
});

describe("probeCardScanReadiness", () => {
  it("reports ok when the vision config passes its pre-flight asserts", async () => {
    await expect(probeCardScanReadiness()).resolves.toEqual({ kind: "ok" });
  });

  it("classifies an unconfigured provider without making a network call", async () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    probeVisionReadinessMock.mockRejectedValue(
      new Error("Vision model not configured — set it in Settings"),
    );

    await expect(probeCardScanReadiness()).resolves.toEqual({
      kind: "notConfigured",
      message: "Vision model not configured — set it in Settings",
    });
  });

  it("never rejects, so opening the scanner cannot fail on a probe error", async () => {
    probeVisionReadinessMock.mockRejectedValue(new Error("boom"));
    await expect(probeCardScanReadiness()).resolves.toEqual({ kind: "notConfigured", message: "boom" });
  });

  it("treats an insecure-URL failure as configuration, not a retryable outage", async () => {
    // assertHttpsOrLocal throws status 0 with NO notConfigured flag, so the
    // shared classifier calls it "transient". The probe makes no network call,
    // so "transient" is impossible here by construction — and telling the user
    // to scan again is wrong advice, since only Settings can fix a plain-http
    // remote URL. This is the exact wrong-retry-advice class the feature exists
    // to remove, so it must not reappear inside the preflight path.
    probeVisionReadinessMock.mockRejectedValue(
      new Error("OmniRoute URL must use https:// (or be a loopback/LAN address) to protect the API key"),
    );

    const outcome = await probeCardScanReadiness();

    expect(outcome.kind).toBe("notConfigured");
    expect(cardScanPreflightHint(outcome)).toMatch(/https/i);
  });
});

describe("cardScanPreflightHint", () => {
  it("warns about an unconfigured provider and says capture still works", () => {
    const hint = cardScanPreflightHint({
      kind: "notConfigured",
      message: "OmniRoute URL not configured — set it in Settings",
    });
    expect(hint).toContain("set it in Settings");
    expect(hint).toMatch(/still capture/i);
  });

  it("does not claim the image was saved — nothing has been captured yet", () => {
    const hint = cardScanPreflightHint({ kind: "notConfigured", message: "no url" });
    expect(hint).not.toMatch(/is saved for later/i);
    expect(hint).toMatch(/no image is saved/i);
  });

  it("stays silent for outcomes that are not knowable before a call", () => {
    // permanent/transient describe a call that already failed; warning about
    // them on open would be noise the user cannot act on.
    expect(cardScanPreflightHint({ kind: "ok" })).toBeNull();
    expect(cardScanPreflightHint({ kind: "permanent", message: "bad key" })).toBeNull();
    expect(cardScanPreflightHint({ kind: "transient", message: "timeout" })).toBeNull();
  });
});

describe("cardScanHint", () => {
  it("never tells an unconfigured user to scan again", () => {
    const hint = cardScanHint({
      kind: "notConfigured",
      message: "OmniRoute URL not configured — set it in Settings",
    });
    expect(hint).toContain("set it in Settings");
    expect(hint).toContain("saved");
    expect(hint).not.toMatch(/scan again to retry/i);
  });

  it("does tell a transient failure to scan again", () => {
    expect(cardScanHint({ kind: "transient", message: "network error" })).toMatch(/scan again/i);
  });

  it("tells a permanent failure that retrying is pointless", () => {
    expect(cardScanHint({ kind: "permanent", message: "bad api key" })).toMatch(/retrying won't help/i);
  });

  it("always confirms the image survived, whatever the cause", () => {
    for (const outcome of [
      { kind: "notConfigured" as const, message: "no url" },
      { kind: "permanent" as const, message: "bad key" },
      { kind: "transient" as const, message: "timeout" },
    ]) {
      expect(cardScanHint(outcome)).toMatch(/saved/i);
    }
  });

  it("has no hint when OCR succeeded", () => {
    expect(cardScanHint({ kind: "ok" })).toBeNull();
  });
});
