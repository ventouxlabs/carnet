import { describe, expect, it } from "vitest";

import { buildDefaultProviders } from "./llmProviders";
import type { Settings } from "./settings";
import {
  parseSettingsTransfer,
  reissueImportedCustomProviderIds,
  serializeSettingsTransfer,
} from "./settingsTransfer";

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

describe("settings transfer", () => {
  it("serializes non-secret settings in a versioned format", () => {
    const exported = serializeSettingsTransfer(settings(), "dark");
    expect(exported).toContain('"format": "carnet-settings"');
    expect(exported).toContain('"version": 1');
    expect(exported).toContain('"themePreference": "dark"');
    expect(exported).not.toContain("omni-secret");
    expect(exported).not.toContain("local-secret");
    expect(exported).not.toContain("karakeep-secret");
    expect(exported).not.toContain("ApiKey");
  });

  it("imports valid settings but resets package-scoped state", () => {
    const imported = parseSettingsTransfer(serializeSettingsTransfer(settings(), "light"));
    expect(imported.activeProviderId).toBe("omniroute");
    expect(imported.captureFolderPath).toBe("/storage/emulated/0/carnet");
    expect(imported.persistentNotificationEnabled).toBe(false);
    expect(imported.promptOverrides).toEqual({ idea: "Keep it brief" });
    expect(imported.themePreference).toBe("light");
  });

  it("round-trips useExistingTagsForAutoTag when disabled", () => {
    const imported = parseSettingsTransfer(
      serializeSettingsTransfer(settings({ useExistingTagsForAutoTag: false }), "light"),
    );
    expect(imported.useExistingTagsForAutoTag).toBe(false);
  });

  it("accepts an export written before useExistingTagsForAutoTag existed", () => {
    // v0.11.0 and earlier exported no such field. The validator must treat it
    // as optional and default it to true, not refuse the whole import — see
    // the prompt-override case below for the same bug class biting before.
    // Bumping VERSION instead would reject every v1 export outright, which is
    // strictly worse.
    const raw = serializeSettingsTransfer(settings(), "light");
    const parsed = JSON.parse(raw) as { settings: Record<string, unknown> };
    delete parsed.settings.useExistingTagsForAutoTag;
    const imported = parseSettingsTransfer(JSON.stringify(parsed));
    expect(imported.useExistingTagsForAutoTag).toBe(true);
  });

  it("rejects a non-boolean useExistingTagsForAutoTag", () => {
    const raw = serializeSettingsTransfer(settings(), "light");
    const parsed = JSON.parse(raw) as { settings: Record<string, unknown> };
    parsed.settings.useExistingTagsForAutoTag = "yes";
    expect(() => parseSettingsTransfer(JSON.stringify(parsed))).toThrow(
      /incomplete or malformed/,
    );
  });

  it("round-trips every prompt override key, including the two non-capture-mode ones", () => {
    // isPromptOverrides is an allowlist used as a VALIDATOR by
    // isValidSettingsShape, so an unlisted key doesn't merely get dropped —
    // it fails shape validation and the whole import is refused. That made a
    // user's own export unimportable as soon as they customized the Enhance
    // or Ask prompt, neither of which is a capture mode.
    const overrides = {
      idea: "Keep it brief",
      journal: "Second person",
      person: "Just the facts",
      sharedImage: "Describe it",
      sharedLink: "Summarize it",
      enhanceProse: "Tighten the prose",
      retrospective: "Cite every claim",
    };
    const imported = parseSettingsTransfer(
      serializeSettingsTransfer(settings({ promptOverrides: overrides })),
    );
    expect(imported.promptOverrides).toEqual(overrides);
  });

  it("drops a SAF capture folder URI because its permission cannot transfer", () => {
    const imported = parseSettingsTransfer(
      serializeSettingsTransfer(
        settings({ captureFolderPath: "content://com.android.externalstorage/tree/primary%3Acarnet" }),
      ),
    );
    expect(imported.captureFolderPath).toBe("");
  });

  it("rejects malformed, unsupported, and dangling-provider files", () => {
    expect(() => parseSettingsTransfer("not json")).toThrow("not a valid");
    expect(() =>
      parseSettingsTransfer(JSON.stringify({ format: "carnet-settings", version: 2, settings: {} })),
    ).toThrow("unsupported version");

    const parsed = JSON.parse(serializeSettingsTransfer(settings())) as {
      settings: { activeProviderId: string };
    };
    parsed.settings.activeProviderId = "missing";
    expect(() => parseSettingsTransfer(JSON.stringify(parsed))).toThrow("missing provider");
  });

  // #176 — allowInsecureTransport is a per-device trust decision, not a
  // portable setting: an imported provider must land with consent CLEARED,
  // even if the source device had it enabled.
  it("strips allowInsecureTransport on import", () => {
    const imported = parseSettingsTransfer(
      serializeSettingsTransfer(
        settings({
          llmProviders: [
            ...buildDefaultProviders().map((p) =>
              p.id === "omniroute" ? { ...p, allowInsecureTransport: true } : p,
            ),
          ],
        }),
      ),
    );
    const omniroute = imported.llmProviders.find((p) => p.id === "omniroute");
    expect(omniroute?.allowInsecureTransport).toBe(false);
  });

  it("reissues custom ids so an imported endpoint cannot inherit a local key", () => {
    const imported = parseSettingsTransfer(
      serializeSettingsTransfer(
        settings({
          llmProviders: [
            ...buildDefaultProviders(),
            {
              id: "custom-1",
              label: "Imported server",
              baseUrl: "https://imported.example.com",
              model: "model",
              visionModel: "",
              preset: null,
            },
          ],
          activeProviderId: "custom-1",
          nextCustomSeq: 2,
        }),
      ),
    );
    const reissued = reissueImportedCustomProviderIds(imported, 8);
    expect(reissued.llmProviders.at(-1)?.id).toBe("custom-8");
    expect(reissued.activeProviderId).toBe("custom-8");
    expect(reissued.nextCustomSeq).toBe(9);
  });
});
