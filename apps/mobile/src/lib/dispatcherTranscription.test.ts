import { beforeEach, describe, expect, it, vi } from "vitest";

// ── On-device speech recognition (backend-agnostic) — split out of
// dispatcher.test.ts once that file passed 1155 lines. transcribeAudio and
// autoTranscribeIfEnabled live directly in dispatcher.ts (they read settings
// and touch the vault writer, outside llmClient.ts's "reads no settings"
// contract) — their tests moved here from omniroute.test.ts originally, then
// out of the main dispatcher.test.ts. See dispatcher.test.ts for the
// enrichment-dispatch tests and dispatcherFallback.test.ts for the Phase 3
// offline fallback chain / vision routing / insecure-transport tests.

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

import { transcribeAudio, autoTranscribeIfEnabled, MAX_TRANSCRIPTION_BYTES } from "./dispatcher";
import * as llmClient from "./llmClient";
import { getSettings } from "./settings";

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(getSettings).mockResolvedValue(BASE_SETTINGS);
});

// ── transcribeAudio (on-device path) — moved from omniroute.test.ts. Lives in
// dispatcher.ts now (backend-agnostic on-device speech recognition, not part
// of the llmClient.ts OpenAI-compatible client).

describe("transcribeAudio (on-device path)", () => {
  beforeEach(async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    vi.mocked(transcribeOnDevice).mockReset();
  });

  it("returns the on-device transcript + 'on-device' model on the happy path", async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    vi.mocked(transcribeOnDevice).mockResolvedValueOnce("hello world");

    const out = await transcribeAudio({
      base64: "AAAA",
      mimeType: "audio/mp4",
      filename: "clip.m4a",
    });

    expect(out.text).toBe("hello world");
    expect(out.model).toBe("on-device");
    // transcribeAudio forwards only base64 + filename; the mimeType is used
    // for the cap pre-check and not threaded into the on-device wrapper.
    expect(transcribeOnDevice).toHaveBeenCalledWith({
      base64: "AAAA",
      filename: "clip.m4a",
    });
  });

  it("propagates the on-device error through to the caller", async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    vi.mocked(transcribeOnDevice).mockRejectedValueOnce(
      new Error("On-device STT error: no-speech — no speech detected"),
    );

    await expect(
      transcribeAudio({
        base64: "AAAA",
        mimeType: "audio/mp4",
        filename: "clip.m4a",
      }),
    ).rejects.toThrow(/no-speech/);
  });

  it("does not throw at exactly the 25 MB cap — invokes the on-device wrapper", async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    vi.mocked(transcribeOnDevice).mockResolvedValueOnce("ok");
    // floor(len * 0.75) === MAX_TRANSCRIPTION_BYTES — sits exactly on the cap,
    // which is allowed (the guard is strictly greater-than).
    const atCap = "A".repeat(Math.ceil(MAX_TRANSCRIPTION_BYTES / 0.75));

    const out = await transcribeAudio({
      base64: atCap,
      mimeType: "audio/mp4",
      filename: "atcap.m4a",
    });

    expect(out.text).toBe("ok");
    expect(transcribeOnDevice).toHaveBeenCalledTimes(1);
  });

  it("throws an LlmClientError 413 just over the cap, before calling the wrapper", async () => {
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    // Two chars past the boundary → floor(len * 0.75) > MAX_TRANSCRIPTION_BYTES.
    const overCap = "A".repeat(Math.ceil(MAX_TRANSCRIPTION_BYTES / 0.75) + 2);

    try {
      await transcribeAudio({
        base64: overCap,
        mimeType: "audio/mp4",
        filename: "huge.m4a",
      });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(llmClient.LlmClientError);
      expect((e as llmClient.LlmClientError).status).toBe(413);
      expect((e as llmClient.LlmClientError).message).toContain("transcription caps");
    }
    // Pre-flight short-circuits before invoking the wrapper.
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("MAX_TRANSCRIPTION_BYTES is 25 MB", () => {
    expect(MAX_TRANSCRIPTION_BYTES).toBe(25 * 1024 * 1024);
  });
});

// ── autoTranscribeIfEnabled — moved from omniroute.test.ts alongside
// transcribeAudio.

describe("autoTranscribeIfEnabled", () => {
  const AUDIO_NOTE = `---\nkind: shared-audio\n---\n# Audio\n\n## File\n[clip.m4a](../Audio/clip.m4a)\n\n## Context\n(none)\n`;
  // Only the toggle differs from the default — derive it so a Settings
  // interface change updates one fixture (BASE_SETTINGS), not two.
  const SETTINGS_TOGGLE_ON = { ...BASE_SETTINGS, autoTranscribeOnSave: true };

  beforeEach(async () => {
    const { readNote, readPairedBinaryFromNote, updateNote, upsertSection } =
      await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    // Reset + reseed getSettings so a queued mockResolvedValueOnce from a
    // prior test can't leak in (defense against order-dependence — the
    // toggle-on tests below queue one-shot overrides). Default: toggle OFF.
    vi.mocked(getSettings).mockReset();
    vi.mocked(getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(readNote).mockReset();
    vi.mocked(readPairedBinaryFromNote).mockReset();
    vi.mocked(updateNote).mockReset();
    vi.mocked(transcribeOnDevice).mockReset();
    // mockClear (not mockReset) — keep upsertSection's format implementation,
    // just drop call history so per-test toHaveBeenCalledWith stays clean.
    vi.mocked(upsertSection).mockClear();
  });

  it("no-ops (returns null) when autoTranscribeOnSave is false", async () => {
    // Default global settings mock has autoTranscribeOnSave: false.
    const { readNote } = await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");
    const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
    expect(result).toBeNull();
    // Short-circuits before reading the note OR hitting the recognizer.
    expect(readNote).not.toHaveBeenCalled();
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("returns null on the full happy path (read, transcribe, upsert, update)", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote, readPairedBinaryFromNote, updateNote, upsertSection } =
      await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
    vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
      base64: "AAAA",
      mime: "audio/mp4",
    });
    vi.mocked(transcribeOnDevice).mockResolvedValueOnce("hello world");

    const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
    expect(result).toBeNull();

    // Pin that the filename extracted by the ../Audio/ regex ("clip.m4a")
    // reaches the on-device wrapper, alongside the binary's base64.
    expect(transcribeOnDevice).toHaveBeenCalledWith({
      base64: "AAAA",
      filename: "clip.m4a",
    });
    // Pin what's forwarded to upsertSection: original note body, the
    // "Transcript" heading, the transcript text. (The "## Transcript"
    // substring asserted below comes from the MOCKED upsertSection's format
    // string — real section-insertion behavior is covered in writer.test.ts.)
    expect(upsertSection).toHaveBeenCalledWith(
      AUDIO_NOTE,
      "Transcript",
      "hello world",
    );
    expect(updateNote).toHaveBeenCalledTimes(1);
    const [filepath, newBody] = vi.mocked(updateNote).mock.calls[0];
    expect(filepath).toBe("/vault/Ideas/foo.md");
    expect(newBody).toContain("## Transcript");
    expect(newBody).toContain("hello world");
  });

  it("returns 'Note has no Audio/ link' when body doesn't reference Audio/", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote, readPairedBinaryFromNote } = await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockResolvedValueOnce(
      `---\nkind: idea\n---\n# Plain idea\n\nNo binary link here.\n`,
    );

    const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
    expect(result).toBe("Note has no Audio/ link");
    expect(readPairedBinaryFromNote).not.toHaveBeenCalled();
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("returns the readNote error message when reading the note throws", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote } = await import("./writer");
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockRejectedValueOnce(
      new Error("ENOENT: no such file"),
    );

    const result = await autoTranscribeIfEnabled("/vault/Ideas/gone.md");
    expect(result).toContain("ENOENT");
    expect(transcribeOnDevice).not.toHaveBeenCalled();
  });

  it("returns the transcribeAudio error message when the on-device recognizer fails", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote, readPairedBinaryFromNote, updateNote } = await import(
      "./writer"
    );
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
    vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
      base64: "AAAA",
      mime: "audio/mp4",
    });
    vi.mocked(transcribeOnDevice).mockRejectedValueOnce(
      new Error("On-device STT error: no-speech — no speech detected"),
    );

    const result = await autoTranscribeIfEnabled("/vault/Ideas/foo.md");
    expect(result).toContain("no-speech");
    // updateNote MUST NOT run on transcribe failure — the original note
    // stays untouched.
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("never throws — returns an error string even when updateNote rejects", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(SETTINGS_TOGGLE_ON);
    const { readNote, readPairedBinaryFromNote, updateNote } = await import(
      "./writer"
    );
    const { transcribeOnDevice } = await import("./audioTranscribeOnDevice");

    vi.mocked(readNote).mockResolvedValueOnce(AUDIO_NOTE);
    vi.mocked(readPairedBinaryFromNote).mockResolvedValueOnce({
      base64: "AAAA",
      mime: "audio/mp4",
    });
    vi.mocked(transcribeOnDevice).mockResolvedValueOnce("ok");
    vi.mocked(updateNote).mockRejectedValueOnce(
      new Error("SAF tree permission revoked"),
    );

    // .resolves asserts the helper does NOT throw AND returns the error
    // string in one idiomatic line — and preserves the failure if it ever
    // does throw (the old manual try/catch swallowed the stack).
    await expect(
      autoTranscribeIfEnabled("/vault/Ideas/foo.md"),
    ).resolves.toContain("SAF tree permission revoked");
  });
});
