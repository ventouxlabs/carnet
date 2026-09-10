// @vitest-environment jsdom
//
// Screen smoke test (pattern: see TagBrowserScreen.test.tsx). Covers
// behaviors that are easy to silently break during refactors of this screen:
//
//   (a) the mount-time notification reconcile happy path — native ON +
//       permission revoked must force-stop the service AND render the
//       toggle OFF.
//   (a2) the SAME scenario but with a rejecting stop() — this is the one
//       that actually catches a regression of the stop()-before-assign
//       ordering fix (see lib/settingsPersistence.ts
//       reconcileInitialNotificationState and the comment at its call
//       site); (a) alone can't, because both orderings converge when
//       stop() resolves.
//
// The LLM provider UI (Phase 4 — see
// docs/superpowers/specs/2026-07-31-llm-provider-list-design.md, "UI") is
// components/LlmProviderSection.tsx, rendered here for real (not stubbed) —
// it owns its own persistence (savePersistedOnly) and its own SecureStore
// key IO (lib/providerKeys.ts, real, backed by an in-memory
// expo-secure-store mock below — same pattern as providerKeys.test.ts), so
// these tests exercise the actual switch/add/delete/health-check flows
// end-to-end, not a stub.
//
// Native-module-heavy children (DiagnosticsSection, VoiceSetupCheck) are
// stubbed out — they have their own dedicated tests and pull in
// AsyncStorage/expo-clipboard/on-device STT probes that are irrelevant here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { Settings } from "../lib/settings";
import { buildDefaultProviders, type LlmProvider } from "../lib/llmProviders";
import type { HealthResult } from "../lib/llmClient";

const customProvider: LlmProvider = {
  id: "custom-1",
  label: "My Server",
  baseUrl: "https://my.server",
  model: "",
  visionModel: "",
  preset: null,
};

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmProviders: buildDefaultProviders().map((p) =>
      p.id === "omniroute" ? { ...p, baseUrl: "https://llm.grepon.cc" } : p,
    ),
    activeProviderId: "omniroute",
    nextCustomSeq: 1,
    fallbackProviderId: null,
    visionProviderId: null,
    enhanceProviderId: null,
    enhanceModel: "",
    omniRouteApiKey: "",
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

// In-memory SecureStore mock — same pattern as providerKeys.test.ts. LLM
// provider keys (lib/providerKeys.ts) are REAL in this test file, not
// stubbed, so the key-deletion mandatory case has real evidence to assert
// against — a mocked providerKeys module could pass that test for the wrong
// reason (see the "mutate the source, confirm red" instruction).
const _secure = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => _secure.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    _secure.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    _secure.delete(k);
  }),
}));

const getSettings = vi.fn(async () => baseSettings());
const saveSettings = vi.fn(async (_s: Settings) => undefined);
const savePersistedOnly = vi.fn(async (_s: Settings) => undefined);
const hasKarakeepApiKey = vi.fn(async () => false);
const shouldShowMigrationBanner = vi.fn(async () => false);
const dismissMigrationBanner = vi.fn(async () => undefined);
const setKarakeepApiKey = vi.fn(async (_key: string) => undefined);

vi.mock("../lib/settings", () => ({
  DEFAULT_OMNIROUTE_MODEL: "openrouter/openai/gpt-4o-mini",
  DEFAULT_VISION_MODEL: "openrouter/openai/gpt-4o-mini",
  getSettings: () => getSettings(),
  saveSettings: (s: Settings) => saveSettings(s),
  savePersistedOnly: (s: Settings) => savePersistedOnly(s),
  hasKarakeepApiKey: () => hasKarakeepApiKey(),
  shouldShowMigrationBanner: () => shouldShowMigrationBanner(),
  dismissMigrationBanner: () => dismissMigrationBanner(),
  setKarakeepApiKey: (key: string) => setKarakeepApiKey(key),
}));

const listModels = vi.fn(async (_url: string, _key: string) => [
  "pick-me-model",
  "other-model",
]);
vi.mock("../lib/dispatcher", () => ({
  listModels: (url: string, key: string) => listModels(url, key),
}));

const healthCheck = vi.fn(async (_url: string): Promise<HealthResult> => "ok");
vi.mock("../lib/llmClient", () => ({
  healthCheck: (url: string) => healthCheck(url),
}));

const isAvailable = vi.fn(() => true);
const requestPermission = vi.fn(async () => true);
const start = vi.fn(async () => undefined);
const stop = vi.fn(async () => undefined);
const isEnabled = vi.fn(async () => false);
const permissionIsGranted = vi.fn(async () => true);
vi.mock("../lib/captureNotification", () => ({
  isAvailable: () => isAvailable(),
  requestPermission: () => requestPermission(),
  start: () => start(),
  stop: () => stop(),
  isEnabled: () => isEnabled(),
  permissionIsGranted: () => permissionIsGranted(),
}));

vi.mock("../components/DiagnosticsSection", () => ({
  DiagnosticsSection: () => null,
}));

vi.mock("../components/SettingsTransferSection", () => ({
  SettingsTransferSection: () => null,
}));

vi.mock("../voice/VoiceSetupCheck", () => ({
  VoiceSetupCheck: () => null,
}));

// migratePreVaultNotes (#172) has its own thorough behavioral coverage in
// lib/vaultMigration.test.ts — mocked here so these ADDITIVE tests exercise
// only the SettingsScreen WIRING (does Save call it, does the count render),
// per team-lead's follow-up: zero edits to the tests above this point.
const migratePreVaultNotes = vi.fn(async () => ({
  migrated: 0,
  failed: 0,
  failures: [] as { subdir: string; name: string; error: string }[],
}));
vi.mock("../lib/vaultMigration", () => ({
  migratePreVaultNotes: () => migratePreVaultNotes(),
}));

import SettingsScreen from "./SettingsScreen";

function renderScreen() {
  return render(
    <PaperProvider theme={carnetLight}>
      <SettingsScreen />
    </PaperProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _secure.clear();
  getSettings.mockResolvedValue(baseSettings());
  saveSettings.mockResolvedValue(undefined);
  savePersistedOnly.mockResolvedValue(undefined);
  hasKarakeepApiKey.mockResolvedValue(false);
  shouldShowMigrationBanner.mockResolvedValue(false);
  listModels.mockResolvedValue(["pick-me-model", "other-model"]);
  healthCheck.mockResolvedValue("ok");
  isAvailable.mockReturnValue(true);
  requestPermission.mockResolvedValue(true);
  start.mockResolvedValue(undefined);
  stop.mockResolvedValue(undefined);
  isEnabled.mockResolvedValue(false);
  permissionIsGranted.mockResolvedValue(true);
  migratePreVaultNotes.mockResolvedValue({ migrated: 0, failed: 0, failures: [] });
});

// RTL's automatic cleanup needs vitest globals (this repo runs without
// them), so unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe("SettingsScreen", () => {
  it("force-stops and renders the notification toggle OFF when native is ON but permission was revoked", async () => {
    isEnabled.mockResolvedValue(true);
    permissionIsGranted.mockResolvedValue(false);

    renderScreen();

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    // Switches render in JSX order: AI-behavior's two switches
    // (autoTranscribeOnSave, previewBeforeSave), then Capture surfaces'
    // persistent-notification switch — index 2 is the one under test.
    const switches = screen.getAllByRole("switch") as HTMLInputElement[];
    expect(switches).toHaveLength(3);
    expect(switches[2].checked).toBe(false);
  });

  it("keeps the JS-side hint (does NOT adopt reconciled OFF) when the force-stop itself rejects", async () => {
    // Regression guard for the mount-reconcile ordering fix. When stop()
    // resolves, both orderings (assign-then-stop vs stop-then-assign)
    // produce the same final state, so the test above alone can't catch a
    // reordering regression. This one can: with stop() before assign (the
    // fix), a rejecting stop() throws before `initialNotificationEnabled`
    // is ever reassigned, so the outer catch preserves the JS-side hint
    // (true here). Swap the two lines back (assign-then-stop, the bug) and
    // the assignment to `false` already landed before stop() rejects, so
    // this assertion flips and the test fails.
    isEnabled.mockResolvedValue(true);
    permissionIsGranted.mockResolvedValue(false);
    stop.mockRejectedValue(new Error("service already dead"));
    getSettings.mockResolvedValue(
      baseSettings({ persistentNotificationEnabled: true }),
    );

    renderScreen();

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    const switches = screen.getAllByRole("switch") as HTMLInputElement[];
    expect(switches[2].checked).toBe(true);
  });

  describe("LLM provider section", () => {
    it("switching the active provider persists it", async () => {
      renderScreen();

      fireEvent.click(await screen.findByText("Active provider — tap to change"));
      fireEvent.click(await screen.findByText("Relais (local)"));

      await waitFor(() => {
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ activeProviderId: "relais" }),
        );
      });
      // The section re-renders around the newly active entry.
      expect(await screen.findByPlaceholderText("http://127.0.0.1:8080")).toBeTruthy();
    });

    // The single-flight write chain itself (the CRITICAL lost-update fix)
    // has direct, mutation-tested coverage in lib/useProviderWriteChain.test.ts,
    // including the exact "two writes interleave, second must not clobber
    // the first" scenario. It is NOT re-tested by driving two overlapping
    // writes through this screen's rendered UI, because the UI-level half
    // of the same fix (below) disables the picker rows while a write is in
    // flight — so a second click genuinely can't start a second write here.
    // That's the fix working, not a gap: the two tests are complementary,
    // not the same test at two layers.
    it("Save is disabled while a write is in flight", async () => {
      // Companion to the chain test above: the UI-level guard that stops
      // the user from ever starting an overlapping write in the first
      // place. Delay the write so the disabled window is observable.
      let resolveWrite: (v: undefined) => void = () => undefined;
      savePersistedOnly.mockImplementation(
        () => new Promise<undefined>((resolve) => { resolveWrite = resolve; }),
      );

      renderScreen();

      fireEvent.click(await screen.findByText("Active provider — tap to change"));
      fireEvent.click(await screen.findByText("Relais (local)"));

      await waitFor(() => {
        const btn = screen.getByText("Save provider").closest("button");
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });

      resolveWrite(undefined);
      await waitFor(() => {
        const btn = screen.getByText("Save provider").closest("button");
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it("saveEntry rejects an invalid base URL instead of persisting it", async () => {
      // HIGH finding: saveEntry used to call nothing before persisting the
      // edit buffer — addCustom validated, saveEntry (the path every EDIT
      // takes) did not. Reproduced with a javascript: URL; any unparseable
      // or non-http(s) scheme is equally invalid.
      renderScreen();

      const baseUrlInput = await screen.findByPlaceholderText("https://...");
      fireEvent.change(baseUrlInput, { target: { value: "javascript:alert(1)" } });
      fireEvent.click(screen.getByText("Save provider"));

      expect(
        await screen.findByText(/Base URL must be a valid http:\/\/ or https:\/\/ address/i),
      ).toBeTruthy();
      expect(savePersistedOnly).not.toHaveBeenCalled();
    });

    it("adding a custom entry with a blank label is rejected — C7", async () => {
      renderScreen();

      fireEvent.click(await screen.findByText("Add custom provider"));
      fireEvent.change(screen.getByPlaceholderText("e.g. https://192.168.1.50:11434"), {
        target: { value: "https://my.server" },
      });
      // Label left blank.
      fireEvent.click(screen.getByText("Add"));

      expect(await screen.findByText(/Label is required/i)).toBeTruthy();
      expect(savePersistedOnly).not.toHaveBeenCalled();
    });

    it("clearing the active provider's key does not touch a different provider's key — C3", async () => {
      // Seed keys for TWO providers directly in the SecureStore stub, then
      // clear the ACTIVE one (omniroute) only.
      _secure.set("carnet_omniroute_api_key", "sk-omni");
      _secure.set("carnet.llm.key.openai", "sk-openai");

      renderScreen();
      await screen.findByText("Active provider — tap to change");

      fireEvent.click(await screen.findByText("Clear key"));

      await waitFor(() => expect(_secure.has("carnet_omniroute_api_key")).toBe(false));
      expect(_secure.get("carnet.llm.key.openai")).toBe("sk-openai");
    });

    it("switching the active provider clears the typed-but-unsaved API key field — C10", async () => {
      // This is the line that answers the cross-provider-key race: without
      // it, a key typed for A could get written under B's alias by a Save
      // tapped after switching.
      renderScreen();

      const keyInput = (await screen.findByPlaceholderText("sk-...")) as HTMLInputElement;
      fireEvent.change(keyInput, { target: { value: "sk-typed-for-omniroute" } });
      expect(keyInput.value).toBe("sk-typed-for-omniroute");

      fireEvent.click(screen.getByText("Active provider — tap to change"));
      fireEvent.click(await screen.findByText("Relais (local)"));

      await waitFor(() => {
        const relaisKeyInput = screen.getByPlaceholderText(
          "optional — leave blank for an unauthenticated loopback server",
        ) as HTMLInputElement;
        expect(relaisKeyInput.value).toBe("");
      });
    });

    it("editing two different providers' fields lands each under its own id, not swapped — C6", async () => {
      renderScreen();

      // Edit the active entry (OmniRoute)'s model.
      const modelInput = (await screen.findByPlaceholderText("e.g. gpt-4o-mini")) as HTMLInputElement;
      fireEvent.change(modelInput, { target: { value: "omniroute-model" } });
      fireEvent.click(screen.getByText("Save provider"));
      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({
            llmProviders: expect.arrayContaining([
              expect.objectContaining({ id: "omniroute", model: "omniroute-model" }),
            ]),
          }),
        ),
      );

      // Switch to Relais and edit ITS model.
      fireEvent.click(screen.getByText("Active provider — tap to change"));
      fireEvent.click(await screen.findByText("Relais (local)"));
      const relaisModelInput = (await screen.findByPlaceholderText(
        "e.g. gpt-4o-mini",
      )) as HTMLInputElement;
      fireEvent.change(relaisModelInput, { target: { value: "relais-model" } });
      fireEvent.click(screen.getByText("Save provider"));

      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({
            llmProviders: expect.arrayContaining([
              expect.objectContaining({ id: "relais", model: "relais-model" }),
              expect.objectContaining({ id: "omniroute", model: "omniroute-model" }),
            ]),
          }),
        ),
      );
    });

    it("Browse available models uses the freshly-typed key, not the stored one — C9", async () => {
      renderScreen();

      const keyInput = await screen.findByPlaceholderText("sk-...");
      fireEvent.change(keyInput, { target: { value: "sk-typed-not-yet-saved" } });

      const browseButtons = await screen.findAllByText("Browse available models");
      fireEvent.click(browseButtons[0]);

      await waitFor(() =>
        expect(listModels).toHaveBeenCalledWith(
          "https://llm.grepon.cc",
          "sk-typed-not-yet-saved",
        ),
      );
    });

    // #148 deduped the catalog to stop the model browser flickering, which also
    // removed the only visible sign that the gateway serves duplicate ids. This
    // guards the replacement signal: one console warning per fetch (not per
    // keystroke — the splitter reruns on every filter change).
    it("warns once per fetch when the catalog serves duplicate ids", async () => {
      listModels.mockResolvedValue(["dupe-model", "other-model", "dupe-model"]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      renderScreen();
      const browseButtons = await screen.findAllByText("Browse available models");
      fireEvent.click(browseButtons[0]);

      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith("[models] catalog served 1 duplicate id(s)"),
      );
      expect(
        warn.mock.calls.filter((c) => String(c[0]).startsWith("[models]")),
      ).toHaveLength(1);
      warn.mockRestore();
    });

    it("stays quiet for a duplicate-free catalog", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      renderScreen();
      const browseButtons = await screen.findAllByText("Browse available models");
      fireEvent.click(browseButtons[0]);

      await waitFor(() => expect(listModels).toHaveBeenCalled());
      expect(
        warn.mock.calls.filter((c) => String(c[0]).startsWith("[models]")),
      ).toHaveLength(0);
      warn.mockRestore();
    });

    it("no delete affordance for the active preset entry — C11", async () => {
      renderScreen();
      await screen.findByText("Active provider — tap to change");
      expect(screen.queryByText("Delete this provider")).toBeNull();
    });

    it("Test connection is disabled for a non-relais provider with a blank base URL", async () => {
      // MEDIUM finding: healthCheck defaults a blank URL to the loopback
      // address — fine for relais (its whole point), misleading for every
      // other provider, which would silently probe 127.0.0.1:8080 and
      // report "✓ Reachable" for an endpoint the user never configured.
      getSettings.mockResolvedValue(
        baseSettings({
          llmProviders: buildDefaultProviders(), // omniroute baseUrl blank
          activeProviderId: "omniroute",
        }),
      );

      renderScreen();

      const testBtn = await screen.findByText("Test connection");
      expect((testBtn.closest("button") as HTMLButtonElement).disabled).toBe(true);
    });

    it("a stale Test connection result is discarded after switching providers", async () => {
      // MEDIUM finding: a health check in flight when the user switches the
      // active provider must not render its result under the NEW provider's
      // header once it resolves.
      let resolveHealthCheck: (v: HealthResult) => void = () => undefined;
      healthCheck.mockImplementation(
        () => new Promise<HealthResult>((resolve) => { resolveHealthCheck = resolve; }),
      );

      renderScreen();

      fireEvent.click(await screen.findByText("Test connection"));
      // Switch away before the health check resolves, and wait for the
      // switch to fully LAND (loadEntryForEditing bumps
      // connectionRequestRef as part of that) before resolving the stale
      // check — otherwise this test would be racing its own setup instead
      // of deterministically exercising the stale-result guard.
      fireEvent.click(screen.getByText("Active provider — tap to change"));
      fireEvent.click(await screen.findByText("Relais (local)"));
      await screen.findByPlaceholderText("http://127.0.0.1:8080");

      // `waitFor(() => expect(x).toBeNull())` would trivially pass on its
      // FIRST check (x is already null before the stale result lands) —
      // that's a false negative for exactly this assertion, since it never
      // waits to see whether x becomes non-null shortly after. Flush the
      // resolved health check's continuation explicitly instead, then
      // assert once.
      await act(async () => {
        resolveHealthCheck("ok");
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByText("✓ Reachable")).toBeNull();
    });

    it("a stale local-readiness probe batch does not overwrite a fresher one after the provider list reloads (#85)", async () => {
      // The readiness-probe effect in LlmProviderSection.tsx re-runs
      // whenever `providers` reloads (e.g. adding a custom entry), and
      // guards its result with `if (cancelled) return;` so an IN-FLIGHT
      // batch from a stale provider list can never clobber a fresher one
      // that resolves first. Relais (always in buildDefaultProviders(), a
      // loopback URL) is the local provider this drives through both
      // batches.
      const relaisUrl = "http://127.0.0.1:8080";
      const resolvers: Array<(v: HealthResult) => void> = [];
      healthCheck.mockImplementation((url: string) => {
        if (url !== relaisUrl) return Promise.resolve("ok" as HealthResult);
        return new Promise<HealthResult>((resolve) => {
          resolvers.push(resolve);
        });
      });

      renderScreen();

      // Batch #1 (mount): wait for its Relais probe call to have started.
      await waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(1));

      // Reload the provider list WHILE batch #1 is still pending — adding a
      // custom entry is a real, user-triggered `providers` reload
      // (persistIdentity -> setProviders), the same trigger the probe
      // effect depends on.
      fireEvent.click(await screen.findByText("Add custom provider"));
      fireEvent.change(await screen.findByPlaceholderText("e.g. My Ollama"), {
        target: { value: "My Server" },
      });
      fireEvent.change(screen.getByPlaceholderText("e.g. https://192.168.1.50:11434"), {
        target: { value: "https://my.server" },
      });
      fireEvent.click(screen.getByText("Add"));
      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ nextCustomSeq: 2 }),
        ),
      );

      // Batch #2 (post-reload): wait for its Relais probe call to start.
      await waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(2));

      // Resolve the FRESH batch #2 first — Relais is reachable.
      await act(async () => {
        resolvers[1]("ok");
        await Promise.resolve();
        await Promise.resolve();
      });

      // THEN resolve the STALE batch #1 — Relais unreachable. Without the
      // cancelled-flag guard, this landing AFTER the fresh result would
      // overwrite it and the hint below would incorrectly reappear.
      await act(async () => {
        resolvers[0]("unreachable");
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Relais isn't the active provider (OmniRoute is, per baseSettings()),
      // so it's only visible as a "listed" row in the picker.
      fireEvent.click(await screen.findByText("Active provider — tap to change"));
      await screen.findByText("Relais (local)");
      expect(
        screen.queryByText(/make sure it's running on this device or network/i),
      ).toBeNull();
    });

    it("adding a custom entry, then deleting it, deletes its stored key", async () => {
      // Mutation-catch target: swapping providerKeys.removeProviderAndKey
      // for llmProviders.removeProvider in LlmProviderSection.tsx must turn
      // this test red — removeProvider never touches SecureStore, so the
      // key would still be sitting under "carnet.llm.key.custom-1" at the
      // final assertion.
      renderScreen();

      fireEvent.click(await screen.findByText("Add custom provider"));
      fireEvent.change(await screen.findByPlaceholderText("e.g. My Ollama"), {
        target: { value: "My Server" },
      });
      fireEvent.change(screen.getByPlaceholderText("e.g. https://192.168.1.50:11434"), {
        target: { value: "https://my.server" },
      });
      fireEvent.click(screen.getByText("Add"));

      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ nextCustomSeq: 2 }),
        ),
      );

      // Make the new entry active so its fields (and key field) render.
      fireEvent.click(await screen.findByText("Active provider — tap to change"));
      fireEvent.click(await screen.findByText("My Server"));
      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ activeProviderId: "custom-1" }),
        ),
      );

      // Type and save an API key for it.
      fireEvent.change(screen.getByPlaceholderText("sk-..."), {
        target: { value: "sk-custom-secret" },
      });
      fireEvent.click(screen.getByText("Save provider"));
      await waitFor(() => expect(_secure.get("carnet.llm.key.custom-1")).toBe("sk-custom-secret"));

      // Delete it via the active-entry delete affordance (visible because
      // it's a custom entry) and confirm.
      fireEvent.click(await screen.findByText("Delete this provider"));
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() => expect(_secure.has("carnet.llm.key.custom-1")).toBe(false));
    });

    it("a preset offers no delete affordance", async () => {
      renderScreen();

      // Seed a custom entry so the picker has both kinds of rows to compare.
      fireEvent.click(await screen.findByText("Add custom provider"));
      fireEvent.change(await screen.findByPlaceholderText("e.g. My Ollama"), {
        target: { value: "My Server" },
      });
      fireEvent.change(screen.getByPlaceholderText("e.g. https://192.168.1.50:11434"), {
        target: { value: "https://my.server" },
      });
      fireEvent.click(screen.getByText("Add"));
      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({ nextCustomSeq: 2 }),
        ),
      );

      fireEvent.click(await screen.findByText("Active provider — tap to change"));

      expect(await screen.findByLabelText("Delete My Server")).toBeTruthy();
      expect(screen.queryByLabelText("Delete OmniRoute")).toBeNull();
      expect(screen.queryByLabelText("Delete Relais (local)")).toBeNull();
    });

    it("deleting the active provider does not leave activeProviderId/fallbackProviderId/visionProviderId dangling", async () => {
      // custom-1 is active, its own fallback, AND its own vision provider —
      // deliberately, so the assertion below is NOT vacuous. Seeding
      // fallback/vision as null (as an earlier version of this test did)
      // would pass even if reassignIdentityAfterDelete never touched them,
      // since baseSettings() already defaults both to null.
      getSettings.mockResolvedValue(
        baseSettings({
          llmProviders: [...buildDefaultProviders(), customProvider],
          activeProviderId: "custom-1",
          fallbackProviderId: "custom-1",
          visionProviderId: "custom-1",
        }),
      );

      renderScreen();

      expect(await screen.findByText("Delete this provider")).toBeTruthy();
      fireEvent.click(screen.getByText("Delete this provider"));
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      await waitFor(() =>
        expect(savePersistedOnly).toHaveBeenCalledWith(
          expect.objectContaining({
            activeProviderId: "omniroute",
            fallbackProviderId: null,
            visionProviderId: null,
          }),
        ),
      );
      // The section re-renders around the reassigned active entry, not a
      // dangling reference to the just-deleted one.
      expect(await screen.findByText("OmniRoute")).toBeTruthy();
    });

    it("deleting the active provider's key survives even when the follow-up settings write fails", async () => {
      // HIGH finding: performDelete's key deletion is irreversible before
      // the settings write even starts. If that write then fails, the user
      // must be told the credential is ALREADY gone (not a generic
      // "failed to delete" that implies nothing happened).
      getSettings.mockResolvedValue(
        baseSettings({
          llmProviders: [...buildDefaultProviders(), customProvider],
          activeProviderId: "custom-1",
        }),
      );
      savePersistedOnly.mockRejectedValueOnce(new Error("disk full"));

      renderScreen();

      expect(await screen.findByText("Delete this provider")).toBeTruthy();
      fireEvent.click(screen.getByText("Delete this provider"));
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      expect(
        await screen.findByText(/Deleted the provider and its key, but saving the change failed/i),
      ).toBeTruthy();
      // The key is gone from SecureStore regardless of the settings-write
      // failure — deleteKey (inside removeProviderAndKey) already resolved
      // before persistIdentity was ever called.
      expect(_secure.has("carnet.llm.key.custom-1")).toBe(false);
    });

    describe("Test connection result", () => {
      it.each([
        ["unreachable", /check the URL and that the server is running/i],
        ["blocked-cleartext", /Android blocked this plain http/i],
        ["unsafe-url", /Not a valid local address/i],
        [
          "untrusted-tls",
          /certificate this device doesn't trust.*install a certificate/is,
        ],
        ["ok", /Reachable/],
      ] as const)("renders the %s message", async (result, pattern) => {
        // Keyed by base URL rather than call order. #85's readiness hint
        // makes LlmProviderSection auto-probe every LOCAL provider (Relais,
        // always present in buildDefaultProviders()) via this SAME
        // healthCheck the moment it mounts — a plain mockResolvedValueOnce
        // here would be racing that background probe rather than reliably
        // landing on the manual "Test connection" click below. Only the
        // ACTIVE provider's base URL (omniroute, set by baseSettings()) is
        // what this test's click actually probes, so key the mock on that
        // URL instead of on call order — deterministic regardless of
        // whether the background probe fires before or after the click.
        //
        // The non-active-URL fallback is "unauthorized" — a HealthResult
        // NOT in this table — rather than "ok": an "ok" fallback would make
        // this test pass even if the URL-keying above were broken (e.g. if
        // the click accidentally probed Relais's URL instead of the active
        // provider's), because "ok" happens to be this suite's overall
        // default too. "unauthorized" has no row here, so a mis-probed URL
        // fails loudly on every case instead of just the ones that aren't
        // "ok".
        const activeBaseUrl = "https://llm.grepon.cc";
        healthCheck.mockImplementation(async (url: string) =>
          url === activeBaseUrl ? result : "unauthorized",
        );

        renderScreen();

        fireEvent.click(await screen.findByText("Test connection"));
        expect(await screen.findByText(pattern)).toBeTruthy();
      });
    });
  });
});

// Pre-vault migration wiring (#172) — additive, appended after the
// pre-existing suite above (which stays untouched). vaultMigration.test.ts
// covers migratePreVaultNotes' own behavior exhaustively; these two only
// confirm SettingsScreen calls it (or doesn't) at the right moment and
// surfaces its result.
describe("SettingsScreen — pre-vault migration trigger", () => {
  it("sweeps and shows the migrated count when Save leaves a real vault configured", async () => {
    getSettings.mockResolvedValue(
      baseSettings({ captureFolderPath: "content://real-vault-tree" }),
    );
    migratePreVaultNotes.mockResolvedValue({
      migrated: 3,
      failed: 0,
      failures: [],
    });

    renderScreen();

    fireEvent.click(await screen.findByText("Save"));

    await waitFor(() => expect(migratePreVaultNotes).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("Moved 3 earlier captures into your vault"),
    ).toBeTruthy();
  });

  it("does not sweep when Save leaves no vault configured (internal storage)", async () => {
    getSettings.mockResolvedValue(baseSettings({ captureFolderPath: "" }));

    renderScreen();

    fireEvent.click(await screen.findByText("Save"));

    // "Settings saved" is the ordinary Save confirmation — waiting for it
    // gives the migration branch, if wrongly taken, time to have fired.
    await screen.findByText("Settings saved");
    expect(migratePreVaultNotes).not.toHaveBeenCalled();
  });
});
