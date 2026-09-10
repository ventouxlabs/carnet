import { describe, expect, it, vi } from "vitest";

// ./settings pulls in the native AsyncStorage/SecureStore bindings (via
// expo-modules-core) at import time — mock them so this pure-helper test can
// load the module under Node + vitest. Same pattern as settings.test.ts.
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import {
  apiKeyFieldLabel,
  apiKeyFieldPlaceholder,
  captureFolderLabel,
  composeSettingsForSave,
  errorMessage,
  existingApiKeysFromSettings,
  formStateFromSettings,
  type FormState,
} from "./settingsForm";
import type { Settings } from "./settings";
import { buildDefaultProviders } from "./llmProviders";

const baseForm: FormState = {
  persistentNotificationEnabled: true,
  autoTranscribeOnSave: false,
  useExistingTagsForAutoTag: true,
  richEditorEnabled: true,
  previewBeforeSave: false,
  captureFolderPath: "content://tree/primary%3AObsidian",
  promptOverrides: { idea: "custom idea prompt" },
  karakeepUrl: "https://karakeep.example.com",
};

const keys = {
  omniRouteApiKey: "sk-existing",
  karakeepApiKey: "kk-existing",
  localLlmApiKey: "",
};

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmProviders: buildDefaultProviders(),
    activeProviderId: "omniroute",
    nextCustomSeq: 3,
    fallbackProviderId: "relais",
    visionProviderId: "openai",
    enhanceProviderId: null,
    enhanceModel: "",
    omniRouteApiKey: "sk-existing",
    localLlmApiKey: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    useExistingTagsForAutoTag: true,
    richEditorEnabled: true,
    previewBeforeSave: false,
    captureFolderPath: "",
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "",
    ...overrides,
  };
}

describe("composeSettingsForSave", () => {
  it("threads form fields through verbatim and carries the existing keys", () => {
    const current = baseSettings();
    const next = composeSettingsForSave(baseForm, keys, current);
    expect(next.omniRouteApiKey).toBe("sk-existing");
    expect(next.karakeepApiKey).toBe("kk-existing");
    expect(next.localLlmApiKey).toBe("");
    expect(next.persistentNotificationEnabled).toBe(true);
    expect(next.autoTranscribeOnSave).toBe(false);
    expect(next.richEditorEnabled).toBe(true);
    expect(next.previewBeforeSave).toBe(false);
    expect(next.captureFolderPath).toBe("content://tree/primary%3AObsidian");
    expect(next.promptOverrides).toEqual({ idea: "custom idea prompt" });
    expect(next.karakeepUrl).toBe("https://karakeep.example.com");
  });

  it("threads the LLM identity fields straight through from currentSettings, unchanged", () => {
    // This is the load-bearing behavior of Phase 4: the Settings Save button
    // must never overwrite what LlmProviderSection has already persisted on
    // its own, independent writes.
    const current = baseSettings({
      activeProviderId: "custom-1",
      nextCustomSeq: 7,
      fallbackProviderId: "relais",
      visionProviderId: "custom-1",
    });
    const next = composeSettingsForSave(baseForm, keys, current);
    expect(next.llmProviders).toBe(current.llmProviders);
    expect(next.activeProviderId).toBe("custom-1");
    expect(next.nextCustomSeq).toBe(7);
    expect(next.fallbackProviderId).toBe("relais");
    expect(next.visionProviderId).toBe("custom-1");
  });

  it("passes empty existing keys straight through (so saveSettings clears them)", () => {
    const next = composeSettingsForSave(
      baseForm,
      { omniRouteApiKey: "", karakeepApiKey: "", localLlmApiKey: "" },
      baseSettings(),
    );
    expect(next.omniRouteApiKey).toBe("");
    expect(next.karakeepApiKey).toBe("");
  });

  it("threads the existing localLlmApiKey through unchanged", () => {
    const next = composeSettingsForSave(
      baseForm,
      { ...keys, localLlmApiKey: "local-secret" },
      baseSettings(),
    );
    expect(next.localLlmApiKey).toBe("local-secret");
  });

  it("does not mutate the input form or currentSettings", () => {
    const current = baseSettings();
    const currentSnapshot = { ...current };
    const form = { ...baseForm };
    composeSettingsForSave(form, keys, current);
    expect(form).toEqual(baseForm);
    expect(current).toEqual(currentSnapshot);
  });
});

describe("captureFolderLabel", () => {
  it("returns an empty string for a blank path", () => {
    expect(captureFolderLabel("")).toBe("");
  });

  it("returns a plain filesystem path unchanged", () => {
    expect(captureFolderLabel("/storage/emulated/0/carnet")).toBe(
      "/storage/emulated/0/carnet",
    );
  });

  it("decodes and trims a SAF tree URI to its readable tail", () => {
    expect(
      captureFolderLabel(
        "content://com.android.externalstorage.documents/tree/primary%3AObsidian%2FCarnet",
      ),
    ).toBe("primary:Obsidian/Carnet");
  });

  it("returns the decoded whole string when there is no tree/ segment", () => {
    expect(captureFolderLabel("content://provider/document%2Ffoo")).toBe(
      "content://provider/document/foo",
    );
  });
});

describe("errorMessage", () => {
  it("uses the Error's message when e is an Error instance", () => {
    expect(errorMessage(new Error("boom"), "Save failed")).toBe(
      "Save failed: boom",
    );
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain string", "Save failed")).toBe(
      "Save failed: plain string",
    );
  });

  it("truncates the underlying message to 120 chars", () => {
    const long = "x".repeat(200);
    const result = errorMessage(new Error(long), "Save failed");
    // "Save failed: " (13 chars) + 120 chars of message
    expect(result).toBe(`Save failed: ${"x".repeat(120)}`);
  });
});

describe("existingApiKeysFromSettings", () => {
  const base: Settings = baseSettings({
    omniRouteApiKey: "sk-existing",
    localLlmApiKey: "local-secret",
    karakeepApiKey: "kk-existing",
  });

  it("reads each key straight through when present", () => {
    expect(existingApiKeysFromSettings(base)).toEqual({
      omniRouteApiKey: "sk-existing",
      karakeepApiKey: "kk-existing",
      localLlmApiKey: "local-secret",
    });
  });

  it("defaults missing/undefined keys to empty string, not undefined", () => {
    // Mutation-catch: if the implementation returned `s.omniRouteApiKey`
    // verbatim (no `?? ""`), this would assert undefined !== "" and fail —
    // a caller (saveSettings) that treats undefined as "no key" differently
    // from "" would then wipe/keep the key incorrectly.
    const sparse = {
      ...base,
      omniRouteApiKey: undefined as unknown as string,
      karakeepApiKey: undefined as unknown as string,
      localLlmApiKey: undefined as unknown as string,
    };
    expect(existingApiKeysFromSettings(sparse)).toEqual({
      omniRouteApiKey: "",
      karakeepApiKey: "",
      localLlmApiKey: "",
    });
  });
});

describe("apiKeyFieldLabel", () => {
  it("appends (configured) when a key is stored and nothing new is typed", () => {
    expect(apiKeyFieldLabel("OmniRoute API key", true, 0)).toBe(
      "OmniRoute API key (configured)",
    );
  });

  it("drops the suffix once the user starts typing a replacement", () => {
    expect(apiKeyFieldLabel("OmniRoute API key", true, 3)).toBe(
      "OmniRoute API key",
    );
  });

  it("drops the suffix when no key is configured", () => {
    expect(apiKeyFieldLabel("OmniRoute API key", false, 0)).toBe(
      "OmniRoute API key",
    );
  });
});

describe("apiKeyFieldPlaceholder", () => {
  it("shows the configured hint when a key is stored", () => {
    expect(apiKeyFieldPlaceholder(true, "sk-...")).toBe(
      "•••• configured — tap to replace",
    );
  });

  it("falls back to the caller-supplied blank-state hint otherwise", () => {
    expect(apiKeyFieldPlaceholder(false, "sk-...")).toBe("sk-...");
  });
});

describe("formStateFromSettings", () => {
  const settings: Settings = baseSettings({
    activeProviderId: "relais",
    autoTranscribeOnSave: true,
    useExistingTagsForAutoTag: true,
    previewBeforeSave: true,
    captureFolderPath: "/storage/emulated/0/carnet",
    promptOverrides: { idea: "custom" },
    karakeepUrl: "https://karakeep.example.com",
  });

  it("maps every non-secret, non-LLM-identity Settings field onto FormState", () => {
    expect(formStateFromSettings(settings, false)).toEqual({
      persistentNotificationEnabled: false,
      autoTranscribeOnSave: true,
      useExistingTagsForAutoTag: true,
      richEditorEnabled: true,
      previewBeforeSave: true,
      captureFolderPath: "/storage/emulated/0/carnet",
      promptOverrides: { idea: "custom" },
      karakeepUrl: "https://karakeep.example.com",
    });
  });

  it("uses the passed-in notification value, NOT settings.persistentNotificationEnabled", () => {
    // Mutation-catch: if the implementation read
    // `s.persistentNotificationEnabled` instead of the second parameter,
    // this would assert false (settings' own value) and fail — the whole
    // point of the separate parameter is that the caller reconciles this
    // value against native state before the form is built.
    const result = formStateFromSettings(settings, true);
    expect(result.persistentNotificationEnabled).toBe(true);
  });
});
