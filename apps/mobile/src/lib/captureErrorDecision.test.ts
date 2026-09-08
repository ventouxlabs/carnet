import { beforeEach, describe, expect, it, vi } from "vitest";

const isPermanentErrorMock = vi.fn().mockReturnValue(false);
const isNotConfiguredErrorMock = vi.fn().mockReturnValue(false);
const isInsecureTransportErrorMock = vi.fn().mockReturnValue(false);

vi.mock("./dispatcher", () => ({
  isPermanentError: (...args: unknown[]) => isPermanentErrorMock(...args),
  isNotConfiguredError: (...args: unknown[]) => isNotConfiguredErrorMock(...args),
  isInsecureTransportError: (...args: unknown[]) => isInsecureTransportErrorMock(...args),
}));

import {
  askErrorMessage,
  classifyCaptureError,
  notConfiguredMessage,
} from "./captureErrorDecision";

beforeEach(() => {
  isPermanentErrorMock.mockReturnValue(false);
  isNotConfiguredErrorMock.mockReturnValue(false);
  isInsecureTransportErrorMock.mockReturnValue(false);
});

describe("classifyCaptureError", () => {
  it("surfaces the config message (not a queue) when the URL is unset, naming the active provider", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("no url"), "Groq");
    expect(decision).toEqual({
      kind: "notConfigured",
      message: notConfiguredMessage("Groq"),
    });
    expect(decision.kind === "notConfigured" && decision.message).toBe(
      "Groq URL not configured — set it in Settings.",
    );
  });

  it("falls back to provider-neutral phrasing when no label is supplied", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("no url"));
    expect(decision).toEqual({
      kind: "notConfigured",
      message: "your LLM provider URL not configured — set it in Settings.",
    });
  });

  it("surfaces the real message for a permanent (4xx) failure", () => {
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("HTTP 400 bad model"));
    expect(decision).toEqual({ kind: "permanent", message: "HTTP 400 bad model" });
  });

  it("stringifies a non-Error permanent failure", () => {
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError("boom");
    expect(decision).toEqual({ kind: "permanent", message: "boom" });
  });

  it("classifies a network/5xx failure as transient (caller should queue)", () => {
    const decision = classifyCaptureError(new Error("network down"));
    expect(decision).toEqual({ kind: "transient" });
  });

  it("surfaces an insecure-transport failure as config (never queued)", () => {
    isInsecureTransportErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("Insecure URL: use https:// for remote hosts"));
    // notConfigured, so the screen surfaces it and keeps the text — the same
    // no-enqueue path a blank URL takes. Queuing it would strand the row: the
    // drain now breaks on this error, blocking every healthy row behind it.
    expect(decision).toEqual({
      kind: "notConfigured",
      message: "Insecure URL: use https:// for remote hosts",
    });
  });

  it("keeps the provider's wording for insecure transport rather than the canonical config message", () => {
    // The message names the offending URL; flattening it into the generic
    // not-configured message would tell the user to set a URL that is
    // already set.
    isInsecureTransportErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("Insecure URL: http://box.example"), "Groq");
    expect(decision).not.toEqual({
      kind: "notConfigured",
      message: notConfiguredMessage("Groq"),
    });
    expect(decision.kind).not.toBe("transient");
  });

  it("prefers insecure-transport over permanent when both would match", () => {
    isInsecureTransportErrorMock.mockReturnValue(true);
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("x"));
    expect(decision.kind).toBe("notConfigured");
  });

  it("prefers not-configured over permanent when both would match", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    isPermanentErrorMock.mockReturnValue(true);
    const decision = classifyCaptureError(new Error("x"));
    expect(decision.kind).toBe("notConfigured");
  });
});

describe("askErrorMessage", () => {
  it("names the provider and points at Settings when the URL is unset", () => {
    isNotConfiguredErrorMock.mockReturnValue(true);
    expect(askErrorMessage(new Error("no url"), "Groq")).toBe(
      notConfiguredMessage("Groq"),
    );
  });

  it("surfaces an insecure-transport refusal verbatim — its wording names the URL", () => {
    // Same stance classifyCaptureError takes: the provider's own message is
    // more specific than the canonical not-configured constant.
    isInsecureTransportErrorMock.mockReturnValue(true);
    expect(askErrorMessage(new Error("http:// to a remote host"), "Groq")).toBe(
      "http:// to a remote host",
    );
  });

  it("surfaces a permanent 4xx message verbatim", () => {
    isPermanentErrorMock.mockReturnValue(true);
    expect(askErrorMessage(new Error("401 bad key"), "Groq")).toBe("401 bad key");
  });

  it("surfaces a transient failure's message too — Ask has no queue to fall back on", () => {
    // The one branch classifyCaptureError cannot serve: it returns
    // { kind: "transient" } with no copy because CaptureScreen enqueues
    // instead of showing anything. Ask must still tell the user what broke.
    expect(askErrorMessage(new Error("timed out after 30s"), "Groq")).toBe(
      "timed out after 30s",
    );
  });

  it("stringifies a non-Error throw rather than rendering undefined", () => {
    expect(askErrorMessage("plain string throw", "Groq")).toBe("plain string throw");
  });
});
