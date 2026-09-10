import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  documentDirectory: "file:///docs/",
  EncodingType: { UTF8: "utf8" },
  writeAsStringAsync: vi.fn(async () => undefined),
  readAsStringAsync: vi.fn(async () => "{}"),
}));

import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import { buildDefaultProviders } from "./llmProviders";
import type { Settings } from "./settings";
import { pickSettingsTransfer, shareSettingsTransfer } from "./settingsTransferFile";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmProviders: buildDefaultProviders(),
    activeProviderId: "omniroute",
    nextCustomSeq: 1,
    fallbackProviderId: null,
    visionProviderId: null,
    enhanceProviderId: null,
    enhanceModel: "",
    omniRouteApiKey: "omni-secret",
    localLlmApiKey: "local-secret",
    persistentNotificationEnabled: true,
    autoTranscribeOnSave: true,
    useExistingTagsForAutoTag: true,
    richEditorEnabled: true,
    previewBeforeSave: true,
    captureFolderPath: "/storage/emulated/0/carnet",
    promptOverrides: { idea: "Keep it brief" },
    karakeepUrl: "https://keep.example.com",
    karakeepApiKey: "karakeep-secret",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
});

describe("settings transfer file", () => {
  it("refuses to export when the platform has no share sheet", async () => {
    vi.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);
    await expect(shareSettingsTransfer(settings(), "system")).rejects.toThrow("Sharing is not available");
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it("writes the export to the cache directory and hands it to the share sheet", async () => {
    await shareSettingsTransfer(settings(), "dark");

    const [uri, contents] = vi.mocked(FileSystem.writeAsStringAsync).mock.calls[0]!;
    expect(uri).toBe("file:///cache/carnet-settings.json");
    expect(JSON.parse(contents as string)).toMatchObject({
      format: "carnet-settings",
      version: 1,
      settings: { themePreference: "dark" },
    });
    expect(Sharing.shareAsync).toHaveBeenCalledWith(uri, expect.objectContaining({ mimeType: "application/json" }));
  });

  it("never writes an API key into the exported file", async () => {
    await shareSettingsTransfer(settings(), "system");

    const [, contents] = vi.mocked(FileSystem.writeAsStringAsync).mock.calls[0]!;
    expect(contents).not.toContain("omni-secret");
    expect(contents).not.toContain("local-secret");
    expect(contents).not.toContain("karakeep-secret");
  });

  it("returns null when the user cancels the picker", async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: true, assets: null });
    await expect(pickSettingsTransfer()).resolves.toBeNull();
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it("reports a clear error when the picker returns no asset", async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [] });
    await expect(pickSettingsTransfer()).rejects.toThrow("No settings file was selected.");
  });

  it("reads the picked file as UTF-8", async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///picked/carnet-settings.json", name: "carnet-settings.json", size: 12, mimeType: "application/json", lastModified: 0 }],
    });
    vi.mocked(FileSystem.readAsStringAsync).mockResolvedValue('{"format":"carnet-settings"}');

    await expect(pickSettingsTransfer()).resolves.toBe('{"format":"carnet-settings"}');
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith(
      "file:///picked/carnet-settings.json",
      { encoding: "utf8" },
    );
  });
});
