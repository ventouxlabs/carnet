// @vitest-environment jsdom
//
// Smoke test for the settings import/export section, plus one ordering guard.
//
// What this protects: the security property documented in confirmImport — this
// device's API keys must be cleared BEFORE the imported (untrusted) endpoints
// are persisted. The inverse ordering would briefly leave a real credential
// paired with an attacker-supplied baseUrl.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";

const setPreference = vi.fn();

vi.mock("../lib/settings", () => ({
  getSettings: vi.fn(),
  savePersistedOnly: vi.fn(async () => undefined),
  setKarakeepApiKey: vi.fn(async () => undefined),
}));
vi.mock("../lib/providerKeys", () => ({ deleteKey: vi.fn(async () => undefined) }));
vi.mock("../lib/settingsTransferFile", () => ({
  pickSettingsTransfer: vi.fn(),
  shareSettingsTransfer: vi.fn(async () => undefined),
}));
vi.mock("../lib/themePreference", () => ({
  useThemePreference: () => ({ preference: "system", setPreference }),
}));

import { buildDefaultProviders } from "../lib/llmProviders";
import { getSettings, savePersistedOnly, setKarakeepApiKey } from "../lib/settings";
import { deleteKey } from "../lib/providerKeys";
import { serializeSettingsTransfer } from "../lib/settingsTransfer";
import { pickSettingsTransfer, shareSettingsTransfer } from "../lib/settingsTransferFile";
import type { Settings } from "../lib/settings";
import { SettingsTransferSection } from "./SettingsTransferSection";

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

function renderSection() {
  const onImported = vi.fn(async () => undefined);
  const onError = vi.fn();
  render(
    <PaperProvider theme={carnetLight}>
      <SettingsTransferSection onImported={onImported} onError={onError} />
    </PaperProvider>,
  );
  return { onImported, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue(settings());
});
afterEach(cleanup);

describe("SettingsTransferSection", () => {
  it("renders both transfer actions", () => {
    renderSection();
    expect(screen.getByText("Export settings")).toBeTruthy();
    expect(screen.getByText("Import settings")).toBeTruthy();
  });

  it("exports the current settings through the share sheet", async () => {
    renderSection();
    fireEvent.click(screen.getByText("Export settings"));
    await waitFor(() => expect(shareSettingsTransfer).toHaveBeenCalledWith(expect.objectContaining({ activeProviderId: "omniroute" }), "system"));
  });

  it("surfaces an export failure through onError instead of throwing", async () => {
    const { onError } = renderSection();
    vi.mocked(shareSettingsTransfer).mockRejectedValueOnce(new Error("Sharing is not available on this device."));

    fireEvent.click(screen.getByText("Export settings"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Sharing is not available on this device."));
  });

  it("does nothing when the user cancels the file picker", async () => {
    renderSection();
    vi.mocked(pickSettingsTransfer).mockResolvedValueOnce(null);

    fireEvent.click(screen.getByText("Import settings"));
    await waitFor(() => expect(pickSettingsTransfer).toHaveBeenCalled());
    expect(screen.queryByText("Replace settings?")).toBeNull();
  });

  it("rejects a malformed file through onError without opening the confirm dialog", async () => {
    const { onError } = renderSection();
    vi.mocked(pickSettingsTransfer).mockResolvedValueOnce("not json at all");

    fireEvent.click(screen.getByText("Import settings"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This is not a valid Carnet settings file."));
    expect(screen.queryByText("Replace settings?")).toBeNull();
  });

  it("clears this device's API keys BEFORE persisting imported endpoints", async () => {
    const { onImported } = renderSection();
    vi.mocked(pickSettingsTransfer).mockResolvedValueOnce(serializeSettingsTransfer(settings(), "dark"));

    fireEvent.click(screen.getByText("Import settings"));
    await waitFor(() => expect(screen.getByText("Replace settings?")).toBeTruthy());

    fireEvent.click(screen.getByText("Import"));
    await waitFor(() => expect(savePersistedOnly).toHaveBeenCalled());

    // Every credential wipe must be ordered strictly before the write that
    // installs the imported baseUrls.
    const saveOrder = vi.mocked(savePersistedOnly).mock.invocationCallOrder[0]!;
    expect(vi.mocked(deleteKey).mock.invocationCallOrder.every((order) => order < saveOrder)).toBe(true);
    expect(vi.mocked(setKarakeepApiKey).mock.invocationCallOrder[0]!).toBeLessThan(saveOrder);
    expect(setKarakeepApiKey).toHaveBeenCalledWith("");

    expect(setPreference).toHaveBeenCalledWith("dark");
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });
});
