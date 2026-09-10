import { describe, expect, it, vi } from "vitest";

// settingsPersistence -> settingsForm -> ./settings pulls in native
// AsyncStorage/SecureStore bindings at import time — mock them so this
// injected-IO test can load the module under Node + vitest. Same pattern as
// settingsForm.test.ts.
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

import type { Settings } from "./settings";
import type { FormState } from "./settingsForm";
import { buildDefaultProviders } from "./llmProviders";
import {
  clearApiKey,
  persistNotificationHint,
  reconcileInitialNotificationState,
  saveSettingsWithKeys,
  toggleNotification,
} from "./settingsPersistence";

const baseForm: FormState = {
  persistentNotificationEnabled: true,
  autoTranscribeOnSave: false,
  useExistingTagsForAutoTag: true,
  richEditorEnabled: true,
  previewBeforeSave: false,
  captureFolderPath: "",
  promptOverrides: {},
  karakeepUrl: "",
};

const storedSettings: Settings = {
  llmProviders: buildDefaultProviders(),
  activeProviderId: "omniroute",
  nextCustomSeq: 1,
  fallbackProviderId: null,
  visionProviderId: null,
  enhanceProviderId: null,
  enhanceModel: "",
  omniRouteApiKey: "sk-existing",
  localLlmApiKey: "local-existing",
  persistentNotificationEnabled: true,
  autoTranscribeOnSave: false,
  useExistingTagsForAutoTag: true,
  richEditorEnabled: true,
  previewBeforeSave: false,
  captureFolderPath: "",
  promptOverrides: {},
  karakeepUrl: "",
  karakeepApiKey: "kk-existing",
};

function makeSaveIO(overrides: Partial<{
  getSettings: () => Promise<Settings>;
  saveSettings: () => Promise<void>;
  setKarakeepApiKey: () => Promise<void>;
}> = {}) {
  return {
    getSettings: vi.fn(overrides.getSettings ?? (async () => storedSettings)),
    saveSettings: vi.fn(overrides.saveSettings ?? (async () => undefined)),
    setKarakeepApiKey: vi.fn(overrides.setKarakeepApiKey ?? (async () => undefined)),
  };
}

describe("saveSettingsWithKeys", () => {
  it("threads the existing stored keys into the saved Settings", async () => {
    const io = makeSaveIO();
    await saveSettingsWithKeys(baseForm, { karakeep: "" }, io);
    expect(io.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        omniRouteApiKey: "sk-existing",
        karakeepApiKey: "kk-existing",
        localLlmApiKey: "local-existing",
      }),
    );
  });

  it("threads the LLM provider identity through unchanged from getSettings' snapshot", async () => {
    const io = makeSaveIO();
    await saveSettingsWithKeys(baseForm, { karakeep: "" }, io);
    expect(io.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        llmProviders: storedSettings.llmProviders,
        activeProviderId: storedSettings.activeProviderId,
        nextCustomSeq: storedSettings.nextCustomSeq,
        fallbackProviderId: storedSettings.fallbackProviderId,
        visionProviderId: storedSettings.visionProviderId,
      }),
    );
  });

  it("writes the pending karakeep key only when non-empty, and reports it", async () => {
    // Mutation-catch: if the `.length > 0` guard were removed (always
    // write), the setter would be called even with an empty pending string.
    const io = makeSaveIO();
    const result = await saveSettingsWithKeys(baseForm, { karakeep: "" }, io);
    expect(io.setKarakeepApiKey).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, keysWritten: { karakeep: false } });
  });

  it("writes the pending karakeep key when provided", async () => {
    const io = makeSaveIO();
    const result = await saveSettingsWithKeys(baseForm, { karakeep: "kk-new" }, io);
    expect(io.setKarakeepApiKey).toHaveBeenCalledWith("kk-new");
    expect(result).toEqual({ ok: true, keysWritten: { karakeep: true } });
  });

  it("returns ok:false with a formatted error when saveSettings rejects", async () => {
    const io = makeSaveIO({
      saveSettings: async () => {
        throw new Error("disk full");
      },
    });
    const result = await saveSettingsWithKeys(baseForm, { karakeep: "kk-new" }, io);
    expect(result).toEqual({
      ok: false,
      error: "Save failed: disk full",
      keysWritten: { karakeep: false },
    });
    // The key write must not have been attempted after the settings save failed.
    expect(io.setKarakeepApiKey).not.toHaveBeenCalled();
  });

  it("returns ok:false when the key write rejects, without crediting it as written", async () => {
    const io = makeSaveIO({
      setKarakeepApiKey: async () => {
        throw new Error("keychain locked");
      },
    });
    const result = await saveSettingsWithKeys(baseForm, { karakeep: "kk-new" }, io);
    expect(result).toEqual({
      ok: false,
      error: "Save failed: keychain locked",
      keysWritten: { karakeep: false },
    });
  });
});

describe("clearApiKey", () => {
  it("returns ok:true after the setter resolves", async () => {
    const setKey = vi.fn(async () => undefined);
    const result = await clearApiKey(setKey);
    expect(setKey).toHaveBeenCalledWith("");
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false with a formatted error when the setter rejects", async () => {
    // Mutation-catch: if the catch block returned `{ ok: true }` (swallowing
    // the error), this assertion would fail — a reject must never report
    // success, since the screen uses `ok` to decide whether to flip the
    // "configured" flag off.
    const setKey = vi.fn(async () => {
      throw new Error("keychain locked");
    });
    const result = await clearApiKey(setKey);
    expect(result).toEqual({
      ok: false,
      error: "Failed to clear the key: keychain locked",
    });
  });
});

function makeNotificationIO(overrides: Partial<{
  isAvailable: () => boolean;
  requestPermission: () => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}> = {}) {
  return {
    isAvailable: vi.fn(overrides.isAvailable ?? (() => true)),
    requestPermission: vi.fn(overrides.requestPermission ?? (async () => true)),
    start: vi.fn(overrides.start ?? (async () => undefined)),
    stop: vi.fn(overrides.stop ?? (async () => undefined)),
  };
}

describe("toggleNotification", () => {
  it("returns ok:false without touching native calls when unavailable", async () => {
    const io = makeNotificationIO({ isAvailable: () => false });
    const result = await toggleNotification(true, io);
    expect(result).toEqual({
      ok: false,
      error:
        "Persistent notification needs a native build (Expo Go can't host it).",
    });
    expect(io.requestPermission).not.toHaveBeenCalled();
    expect(io.start).not.toHaveBeenCalled();
  });

  it("requests permission and starts when turning on and permission is granted", async () => {
    const io = makeNotificationIO();
    const result = await toggleNotification(true, io);
    expect(io.requestPermission).toHaveBeenCalled();
    expect(io.start).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("does not call start when permission is denied", async () => {
    // Mutation-catch: if the `if (!granted) return` guard were dropped,
    // start() would be called even after a denial.
    const io = makeNotificationIO({ requestPermission: async () => false });
    const result = await toggleNotification(true, io);
    expect(io.start).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("stops (not starts) when turning off, without requesting permission", async () => {
    const io = makeNotificationIO();
    const result = await toggleNotification(false, io);
    expect(io.stop).toHaveBeenCalled();
    expect(io.start).not.toHaveBeenCalled();
    expect(io.requestPermission).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false with a formatted error when start() rejects", async () => {
    const io = makeNotificationIO({
      start: async () => {
        throw new Error("service unavailable");
      },
    });
    const result = await toggleNotification(true, io);
    expect(result).toEqual({
      ok: false,
      error: "Failed to start notification: service unavailable",
    });
  });

  it("returns ok:false with a formatted error when stop() rejects", async () => {
    const io = makeNotificationIO({
      stop: async () => {
        throw new Error("service unavailable");
      },
    });
    const result = await toggleNotification(false, io);
    expect(result).toEqual({
      ok: false,
      error: "Failed to stop notification: service unavailable",
    });
  });
});

describe("reconcileInitialNotificationState", () => {
  it("falls back to the JS hint when the native module is unavailable", () => {
    const result = reconcileInitialNotificationState({
      jsHint: true,
      nativeAvailable: false,
      enabledNative: false,
      permissionGranted: false,
    });
    expect(result).toEqual({ value: true, shouldStopNative: false });
  });

  it("is false, no stop, when native is available but reports OFF", () => {
    const result = reconcileInitialNotificationState({
      jsHint: true,
      nativeAvailable: true,
      enabledNative: false,
      permissionGranted: false,
    });
    expect(result).toEqual({ value: false, shouldStopNative: false });
  });

  it("is true, no stop, when native is ON and permission is granted", () => {
    const result = reconcileInitialNotificationState({
      jsHint: false,
      nativeAvailable: true,
      enabledNative: true,
      permissionGranted: true,
    });
    expect(result).toEqual({ value: true, shouldStopNative: false });
  });

  it("is false WITH a force-stop when native is ON but permission was revoked", () => {
    // Mutation-catch: if shouldStopNative were hardcoded to false, this is
    // the one case (the "invisible notification" drift) where the caller
    // must force-stop the native service — this assertion catches a
    // regression that drops that side effect.
    const result = reconcileInitialNotificationState({
      jsHint: true,
      nativeAvailable: true,
      enabledNative: true,
      permissionGranted: false,
    });
    expect(result).toEqual({ value: false, shouldStopNative: true });
  });
});

describe("persistNotificationHint", () => {
  // The fixture's own persistentNotificationEnabled (false) deliberately
  // DIFFERS from the value passed to persistNotificationHint (true) below.
  // If the fixture and the passed value matched, a broken implementation
  // that just re-saved `current` unchanged (dropping the merge entirely)
  // would still pass — see the mutation-catch note on the first test.
  const settingsBeforeToggle: Settings = { ...storedSettings, persistentNotificationEnabled: false };

  it("saves the settings blob with the new notification value merged in, via savePersistedOnly", async () => {
    // Mutation-catch: if the merge were dropped (e.g.
    // `savePersistedOnly(current)` instead of
    // `savePersistedOnly({...current, persistentNotificationEnabled: next})`),
    // this would assert persistentNotificationEnabled: false (the fixture's
    // own value) against the expected true and fail.
    const getSettings = vi.fn(async () => settingsBeforeToggle);
    const savePersistedOnly = vi.fn(async () => undefined);
    await persistNotificationHint(true, { getSettings, savePersistedOnly });
    expect(savePersistedOnly).toHaveBeenCalledWith({
      ...settingsBeforeToggle,
      persistentNotificationEnabled: true,
    });
  });

  it("swallows a save failure instead of throwing (best-effort), after still attempting the merged save", async () => {
    const getSettings = vi.fn(async () => settingsBeforeToggle);
    const savePersistedOnly = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(
      persistNotificationHint(true, { getSettings, savePersistedOnly }),
    ).resolves.toBeUndefined();
    expect(savePersistedOnly).toHaveBeenCalledWith({
      ...settingsBeforeToggle,
      persistentNotificationEnabled: true,
    });
  });
});
