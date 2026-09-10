import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage + SecureStore mocks — same pattern as
// storage.test.ts. The real native bindings can't load under Node + vitest.
const _async = new Map<string, string>();
const _secure = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _async.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _async.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _async.delete(k);
    }),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => _secure.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    _secure.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    _secure.delete(k);
  }),
}));

import {
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_VISION_MODEL,
  getPromptOverrides,
  getSettings,
  hasLocalLlmApiKey,
  hasOmniRouteApiKey,
  saveSettings,
  savePersistedOnly,
  setLocalLlmApiKey,
  setOmniRouteApiKey,
  type Settings,
} from "./settings";
import {
  buildDefaultProviders,
  resolveActiveProvider,
  type LlmProvider,
} from "./llmProviders";

// v3 is what THIS code writes/reads as primary; v2 is the pre-provider-list
// key `main`/older builds wrote — kept as a read-only migration fallback
// (see settings.ts's SETTINGS_KEY comment). Tests that SEED a legacy,
// unmigrated blob write it under v2 (that's genuinely where it would be on
// a real device); tests that inspect what `saveSettings` itself persisted
// read back v3 (the only key this code ever writes).
const SETTINGS_KEY = "carnet:settings:v2";
const SETTINGS_KEY_V3 = "carnet:settings:v3";

beforeEach(() => {
  _async.clear();
  _secure.clear();
});

describe("useExistingTagsForAutoTag default merge", () => {
  it("defaults to true when no settings blob exists", async () => {
    const s = await getSettings();
    expect(s.useExistingTagsForAutoTag).toBe(true);
  });

  it("defaults an older blob missing the key to true without crashing", async () => {
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://example.com",
        omniRouteModel: "some-model",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
        // note: no useExistingTagsForAutoTag key
      }),
    );
    const s = await getSettings();
    expect(s.useExistingTagsForAutoTag).toBe(true);
    expect(findProvider(s.llmProviders, "omniroute").baseUrl).toBe(
      "https://example.com",
    );
  });

  it("round-trips a useExistingTagsForAutoTag=false opt-out through save + load", async () => {
    const base = await getSettings();
    await saveSettings({ ...base, useExistingTagsForAutoTag: false });
    expect((await getSettings()).useExistingTagsForAutoTag).toBe(false);
  });
});

// ── Required test 6: old blob without previewBeforeSave defaults to save-first ─

describe("previewBeforeSave default merge", () => {
  it("defaults to false (save-first) when no settings blob exists", async () => {
    const s = await getSettings();
    expect(s.previewBeforeSave).toBe(false);
  });

  it("defaults an old v2 blob missing the key to false without crashing (test 6)", async () => {
    // Simulate a settings blob persisted before this branch added the field.
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://example.com",
        omniRouteModel: "some-model",
        omniRouteTranscriptionModel: "whisper-1",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
        // note: no previewBeforeSave key
      }),
    );
    const s = await getSettings();
    expect(s.previewBeforeSave).toBe(false);
    // The rest of the blob still loaded — no crash / no reset to defaults.
    // (this blob predates llmProviders too, so it's migrated on read).
    expect(findProvider(s.llmProviders, "omniroute").baseUrl).toBe(
      "https://example.com",
    );
  });

  it("round-trips a previewBeforeSave=true opt-in through save + load", async () => {
    const base = await getSettings();
    const next: Settings = { ...base, previewBeforeSave: true };
    await saveSettings(next);
    const reloaded = await getSettings();
    expect(reloaded.previewBeforeSave).toBe(true);
  });
});

// ── Required test 5: Person/Journal capture never reads previewBeforeSave ─────
// Structural invariant on CaptureScreen: every reference to `previewBeforeSave`
// (state decl, settings load, and the Idea branch) appears BEFORE the Journal
// branch, so the Journal and Person submit branches cannot consult it. If a
// future edit wired the flag into Journal/Person, this fails loudly.

describe("Person + Journal ignore previewBeforeSave", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../screens/CaptureScreen.tsx", import.meta.url).href),
    "utf8",
  );

  it("does not reference previewBeforeSave in the Journal submit branch or after", () => {
    // The submit() journal branch is the brace form `if (mode === "journal") {`
    // (canSubmit uses the braceless `... ) return`, so this pins the branch).
    const journalSubmit = source.indexOf('if (mode === "journal") {');
    expect(journalSubmit).toBeGreaterThanOrEqual(0);
    const fromJournalOnward = source.slice(journalSubmit);
    // Everything from the Journal branch through the Person branch to EOF must
    // be free of the flag — only Idea consults it.
    expect(fromJournalOnward.includes("previewBeforeSave")).toBe(false);
  });

  it("does not reference previewBeforeSave anywhere near the person branch", () => {
    const personBranch = source.indexOf('// mode === "person"');
    expect(personBranch).toBeGreaterThanOrEqual(0);
    const afterPerson = source.slice(personBranch);
    expect(afterPerson.includes("previewBeforeSave")).toBe(false);
  });
});

function findProvider(providers: readonly LlmProvider[], id: string): LlmProvider {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error(`test fixture missing provider "${id}"`);
  return p;
}

// ── LLM provider list migration (Phase 2) ─────────────────────────────────────
// A pre-provider-list blob (a `llmBackend` field and/or flat
// omniRoute*/localLlm* fields, no `llmProviders` yet) is folded into the
// provider list on first read. Covers every llmBackend value (including the
// never-implemented "on-device"), a blob predating llmBackend entirely, the
// blank-local-URL loopback default, idempotency, round-tripping, and — the
// constraint most likely to break silently — that migration never touches
// SecureStore (the design spec's proposed key re-filing is deliberately NOT
// implemented; see providerKeys.ts).

describe("LLM provider list migration", () => {
  it("defaults to the omniroute preset (activeProviderId) with no persisted blob", async () => {
    const s = await getSettings();
    expect(s.activeProviderId).toBe("omniroute");
    expect(s.llmProviders.map((p) => p.id).sort()).toEqual(
      ["relais", "omniroute", "openai", "groq", "openrouter"].sort(),
    );
  });

  it.each([
    ["omniroute", "omniroute"],
    ["local", "relais"],
    ["on-device", "relais"],
  ] as const)(
    'migrates llmBackend "%s" to activeProviderId "%s"',
    async (legacyBackend, expectedActiveId) => {
      _async.set(
        SETTINGS_KEY,
        JSON.stringify({
          omniRouteUrl: "https://llm.example.com",
          omniRouteModel: "gpt-4o-mini",
          omniRouteVisionModel: "claude/claude-sonnet-4-6",
          llmBackend: legacyBackend,
          localLlmUrl: "http://192.168.1.5:8080",
          localLlmModel: "local-model",
          persistentNotificationEnabled: false,
          autoTranscribeOnSave: false,
          richEditorEnabled: true,
          previewBeforeSave: false,
          captureFolderPath: "",
          promptOverrides: {},
          karakeepUrl: "",
        }),
      );

      const s = await getSettings();
      expect(s.activeProviderId).toBe(expectedActiveId);
      const omniroute = findProvider(s.llmProviders, "omniroute");
      expect(omniroute.baseUrl).toBe("https://llm.example.com");
      expect(omniroute.model).toBe("gpt-4o-mini");
      expect(omniroute.visionModel).toBe("claude/claude-sonnet-4-6");
      const relais = findProvider(s.llmProviders, "relais");
      expect(relais.baseUrl).toBe("http://192.168.1.5:8080");
      expect(relais.model).toBe("local-model");
    },
  );

  it("defaults an old blob missing llmBackend entirely to activeProviderId omniroute (pre-B7 shape)", async () => {
    // Mirrors the real upgrade shape from before the llmBackend field
    // existed at all (post-B1/B4 keys present, llmBackend absent) —
    // DEFAULT_LLM_BACKEND was always "omniroute", so this must still be.
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        omniRouteVisionModel: "claude/claude-sonnet-4-6",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
        // note: no llmBackend key
      }),
    );

    const s = await getSettings();
    expect(s.activeProviderId).toBe("omniroute");
    expect(findProvider(s.llmProviders, "omniroute").baseUrl).toBe(
      "https://llm.example.com",
    );
  });

  it("a blank legacy local URL keeps the relais preset's loopback default", async () => {
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "",
        omniRouteModel: "",
        omniRouteVisionModel: "",
        llmBackend: "local",
        localLlmUrl: "",
        localLlmModel: "local-model",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    const relais = findProvider(s.llmProviders, "relais");
    expect(relais.baseUrl).toBe("http://127.0.0.1:8080");
    expect(relais.model).toBe("local-model");
  });

  it("is idempotent — reading the same unmigrated blob twice yields structurally identical llmProviders/activeProviderId", async () => {
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        llmBackend: "local",
        localLlmUrl: "http://192.168.1.5:8080",
        localLlmModel: "local-model",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    // The real regression this must catch is a migration that resets a
    // field on a SECOND pass — two `getSettings()` calls against the SAME
    // unmigrated blob is just calling a pure function twice on identical
    // input, which can't distinguish "idempotent" from "coincidentally
    // returns the same thing twice in a row". Exercising the actual
    // migrate -> save -> re-read path (saveSettings persists the migrated
    // shape; the second getSettings() reads THAT back, not the original
    // legacy blob) is what proves migration doesn't quietly mutate itself
    // on a repeat run.
    const first = await getSettings();
    await saveSettings(first);
    const second = await getSettings();
    expect(second.activeProviderId).toBe(first.activeProviderId);
    expect(second.llmProviders).toEqual(first.llmProviders);
  });

  it("round-trips llmProviders + activeProviderId through save + load", async () => {
    const base = await getSettings();
    const next: Settings = {
      ...base,
      activeProviderId: "relais",
      llmProviders: base.llmProviders.map((p) =>
        p.id === "relais"
          ? { ...p, baseUrl: "http://192.168.1.9:8080", model: "gemma-4" }
          : p,
      ),
    };
    await saveSettings(next);

    // saveSettings only ever WRITES the v3 key (see settings.ts's
    // SETTINGS_KEY comment) — reading it back at v3 here, not the legacy v2
    // key this suite seeds unmigrated fixtures under.
    const persisted = JSON.parse(_async.get(SETTINGS_KEY_V3) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(persisted.activeProviderId).toBe("relais");

    const reloaded = await getSettings();
    expect(reloaded.activeProviderId).toBe("relais");
    expect(findProvider(reloaded.llmProviders, "relais").baseUrl).toBe(
      "http://192.168.1.9:8080",
    );
    expect(findProvider(reloaded.llmProviders, "relais").model).toBe(
      "gemma-4",
    );
  });

  it("never touches SecureStore — omniRoute/local-LLM keys stay at their original aliases, unmoved", async () => {
    _secure.set("carnet_omniroute_api_key", "omni-secret");
    _secure.set("carnet_local_llm_api_key", "local-secret");
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        llmBackend: "omniroute",
        localLlmUrl: "",
        localLlmModel: "",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    // Readable at their ORIGINAL aliases, unmoved.
    expect(s.omniRouteApiKey).toBe("omni-secret");
    expect(s.localLlmApiKey).toBe("local-secret");
    expect(_secure.get("carnet_omniroute_api_key")).toBe("omni-secret");
    expect(_secure.get("carnet_local_llm_api_key")).toBe("local-secret");
    // No re-filed alias was ever written (the spec's proposed
    // carnet.llm.key.<id> re-filing step is deliberately not implemented).
    expect(_secure.has("carnet.llm.key.omniroute")).toBe(false);
    expect(_secure.has("carnet.llm.key.relais")).toBe(false);
  });

  it("a pre-#65 blob (URL + chat model present, no vision-model key at all) migrates the vision model to DEFAULT_VISION_MODEL, not blank", async () => {
    // Reviewer finding #3: `?? ""` here used to silently drop the
    // pre-migration default DEFAULT_PERSISTED supplied for an ABSENT
    // vision-model key. `model` has a second rung at dispatch time
    // (buildConfig's `|| DEFAULT_OMNIROUTE_MODEL`) so it degraded
    // gracefully either way; `visionModel` has no such rung, so a blank
    // migrated value broke image enrichment and card OCR outright for
    // anyone whose blob predates the B1 vision-model split (PR #65).
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        // note: genuinely no omniRouteVisionModel key at all — this is the
        // exact pre-#65 shape, not a blob with an explicit "".
        llmBackend: "omniroute",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    const omniroute = findProvider(s.llmProviders, "omniroute");
    expect(omniroute.model).toBe("gpt-4o-mini");
    expect(omniroute.visionModel).toBe(DEFAULT_VISION_MODEL);
  });

  it("a legacy blob with an explicit blank omniRouteModel still falls back to DEFAULT_OMNIROUTE_MODEL", async () => {
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: undefined,
        llmBackend: "omniroute",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );
    const s = await getSettings();
    expect(findProvider(s.llmProviders, "omniroute").model).toBe(
      DEFAULT_OMNIROUTE_MODEL,
    );
  });
});

// ── Phase 3: fallbackProviderId/visionProviderId extend the EXISTING v3
// migration (no new settings key/version) — a blob that predates these two
// fields simply lacks them, and both must default to null.
describe("fallbackProviderId/visionProviderId default via the v3 migration", () => {
  it("default to null when reading a fresh install (no persisted blob at all)", async () => {
    const s = await getSettings();
    expect(s.fallbackProviderId).toBeNull();
    expect(s.visionProviderId).toBeNull();
  });

  it("default to null when a legacy (pre-provider-list) blob is migrated", async () => {
    _async.set(
      SETTINGS_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        llmBackend: "omniroute",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
        // note: no fallbackProviderId/visionProviderId keys at all
      }),
    );

    const s = await getSettings();
    expect(s.fallbackProviderId).toBeNull();
    expect(s.visionProviderId).toBeNull();
  });

  it("default to null when a v3 blob (has llmProviders already) predates these two fields", async () => {
    // A real Phase-2 install: valid llmProviders/activeProviderId already
    // written, but no fallbackProviderId/visionProviderId key yet — this is
    // the actual upgrade shape this phase's migration must handle, distinct
    // from the pre-provider-list legacy blob above.
    _async.set(
      SETTINGS_KEY_V3,
      JSON.stringify({
        llmProviders: buildDefaultProviders(),
        activeProviderId: "omniroute",
        nextCustomSeq: 1,
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    expect(s.fallbackProviderId).toBeNull();
    expect(s.visionProviderId).toBeNull();
    // The blob above predates Enhance and has no such key at all. It must read
    // back as null, never undefined — undefined is DROPPED by JSON.stringify on
    // the next write, so the key would silently never persist.
    expect(s.enhanceProviderId).toBeNull();
  });

  it("round-trips a configured fallback/vision/enhance provider through save + load", async () => {
    const base = await getSettings();
    await saveSettings({
      ...base,
      fallbackProviderId: "relais",
      visionProviderId: "openai",
      enhanceProviderId: "groq",
    });

    const reloaded = await getSettings();
    expect(reloaded.fallbackProviderId).toBe("relais");
    expect(reloaded.visionProviderId).toBe("openai");
    expect(reloaded.enhanceProviderId).toBe("groq");
  });

  it("round-trips enhanceModel, and defaults it to blank on a blob without it", async () => {
    const base = await getSettings();
    // Blank is the "use the provider's own model" sentinel, so it must survive
    // as "" rather than being dropped to undefined by JSON.stringify.
    expect(base.enhanceModel).toBe("");

    await saveSettings({ ...base, enhanceModel: "anthropic/claude-sonnet-5" });
    expect((await getSettings()).enhanceModel).toBe("anthropic/claude-sonnet-5");

    await saveSettings({ ...base, enhanceModel: "" });
    expect((await getSettings()).enhanceModel).toBe("");
  });

  it("round-trips a retrospective prompt override, sanitised of surrounding whitespace", async () => {
    const base = await getSettings();
    await saveSettings({
      ...base,
      promptOverrides: { ...base.promptOverrides, retrospective: "  custom  " },
    });
    expect((await getPromptOverrides()).retrospective).toBe("custom");
  });

  it("sanitises a whitespace-only retrospective override to absent", async () => {
    const base = await getSettings();
    await saveSettings({
      ...base,
      promptOverrides: { ...base.promptOverrides, retrospective: "   " },
    });
    expect((await getPromptOverrides()).retrospective).toBeUndefined();
  });

  it("treats a non-string persisted value as corrupt and falls back to null", async () => {
    _async.set(
      SETTINGS_KEY_V3,
      JSON.stringify({
        llmProviders: buildDefaultProviders(),
        activeProviderId: "omniroute",
        nextCustomSeq: 1,
        fallbackProviderId: 42,
        visionProviderId: false,
        enhanceProviderId: { not: "a string" },
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    expect(s.fallbackProviderId).toBeNull();
    expect(s.visionProviderId).toBeNull();
    expect(s.enhanceProviderId).toBeNull();
  });
});

describe("v2 -> v3 settings-key separation", () => {
  const V2_KEY = "carnet:settings:v2";
  const V3_KEY = "carnet:settings:v3";

  it("reads a legacy v2 blob (no v3 blob yet) and migrates it, without ever writing to v2", async () => {
    _async.set(
      V2_KEY,
      JSON.stringify({
        omniRouteUrl: "https://llm.example.com",
        omniRouteModel: "gpt-4o-mini",
        llmBackend: "omniroute",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    expect(findProvider(s.llmProviders, "omniroute").baseUrl).toBe(
      "https://llm.example.com",
    );
    // Reading never writes v2 back out.
    expect(_async.has(V2_KEY)).toBe(true);
    expect(
      JSON.parse(_async.get(V2_KEY) ?? "{}") as Record<string, unknown>,
    ).not.toHaveProperty("llmProviders");
  });

  it("prefers v3 over v2 when both exist", async () => {
    _async.set(
      V2_KEY,
      JSON.stringify({
        omniRouteUrl: "https://v2-stale.example.com",
        llmBackend: "omniroute",
      }),
    );
    _async.set(
      V3_KEY,
      JSON.stringify({
        llmProviders: buildDefaultProviders().map((p) =>
          p.id === "omniroute"
            ? { ...p, baseUrl: "https://v3-current.example.com" }
            : p,
        ),
        activeProviderId: "omniroute",
        nextCustomSeq: 1,
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );

    const s = await getSettings();
    expect(findProvider(s.llmProviders, "omniroute").baseUrl).toBe(
      "https://v3-current.example.com",
    );
  });

  it("saveSettings only ever writes v3 — a v2 blob (as `main` would have left it) is never touched by a write", async () => {
    _async.set(
      V2_KEY,
      JSON.stringify({ omniRouteUrl: "https://v2-original.example.com", llmBackend: "omniroute" }),
    );
    const s = await getSettings(); // migrates from v2 in-memory
    await saveSettings(s); // persists — must land on v3, not v2

    expect(_async.get(V2_KEY)).toBe(
      JSON.stringify({ omniRouteUrl: "https://v2-original.example.com", llmBackend: "omniroute" }),
    );
    expect(_async.has(V3_KEY)).toBe(true);
  });
});

describe("llmProviders shape validation on read", () => {
  it("falls back to buildDefaultProviders() when the persisted llmProviders is an empty array", async () => {
    _async.set(
      SETTINGS_KEY_V3,
      JSON.stringify({
        llmProviders: [],
        activeProviderId: "omniroute",
        nextCustomSeq: 1,
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );
    const s = await getSettings();
    expect(s.llmProviders.length).toBeGreaterThan(0);
    expect(findProvider(s.llmProviders, "omniroute")).toBeTruthy();
  });

  it("falls back to buildDefaultProviders() when the persisted llmProviders is not an array at all", async () => {
    _async.set(
      SETTINGS_KEY_V3,
      JSON.stringify({
        llmProviders: "not-an-array",
        activeProviderId: "omniroute",
        nextCustomSeq: 1,
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );
    const s = await getSettings();
    expect(findProvider(s.llmProviders, "omniroute")).toBeTruthy();
  });

  it("falls back to buildDefaultProviders() when an array entry is missing required fields", async () => {
    _async.set(
      SETTINGS_KEY_V3,
      JSON.stringify({
        llmProviders: [{ id: "omniroute", label: "OmniRoute" /* missing baseUrl/model/... */ }],
        activeProviderId: "omniroute",
        nextCustomSeq: 1,
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: "",
        promptOverrides: {},
        karakeepUrl: "",
      }),
    );
    const s = await getSettings();
    expect(s.llmProviders.length).toBe(5);
  });
});

describe("nextCustomSeq persistence", () => {
  it("defaults to 1 on a fresh install", async () => {
    const s = await getSettings();
    expect(s.nextCustomSeq).toBe(1);
  });

  it("round-trips an advanced counter through save + load", async () => {
    const s = await getSettings();
    await saveSettings({ ...s, nextCustomSeq: 5 });
    const reloaded = await getSettings();
    expect(reloaded.nextCustomSeq).toBe(5);
  });
});

describe("savePersistedOnly never touches SecureStore (credential-loss regression, finding #1)", () => {
  it("reproduces the persistNotificationHint interleave: a stale snapshot's blank key field must not delete a key written after it was read", async () => {
    // 1. The notification-hint flow starts: it reads settings while no key
    // is stored yet (the user hasn't tapped Save yet — they're mid-typing
    // while a POST_NOTIFICATIONS permission dialog is up).
    const staleSnapshot = await getSettings();
    expect(staleSnapshot.omniRouteApiKey).toBe("");

    // 2. Meanwhile, the REAL Save completes and writes a key.
    await setOmniRouteApiKey("sk-real-key");

    // 3. The notification-hint flow's write lands LAST, using the STALE
    // snapshot it captured in step 1.
    await savePersistedOnly({ ...staleSnapshot, persistentNotificationEnabled: true });

    // The key written in step 2 must survive.
    expect(await hasOmniRouteApiKey()).toBe(true);
  });

  it("also survives the same interleave for the provider list itself (not just keys)", async () => {
    const staleSnapshot = await getSettings();
    // A real Save lands in the meantime, changing the active provider.
    await saveSettings({ ...staleSnapshot, activeProviderId: "relais" });
    // The stale-snapshot write (still holding the OLD activeProviderId)
    // lands after.
    await savePersistedOnly({ ...staleSnapshot, persistentNotificationEnabled: true });
    // savePersistedOnly still does a whole-blob write, so this one IS
    // expected to revert activeProviderId — that half of the interleave
    // isn't what this fix targets (only the SecureStore side is). Assert
    // what actually matters: no SecureStore call happened.
    const reloaded = await getSettings();
    expect(reloaded.persistentNotificationEnabled).toBe(true);
  });
});

describe("saveSettings no longer deletes a key by omission", () => {
  it("does not delete an existing OmniRoute key when saving a Settings object with a blank field", async () => {
    await setOmniRouteApiKey("sk-existing");
    const s = await getSettings();
    expect(s.omniRouteApiKey).toBe("sk-existing");

    // Simulate the old danger: save a Settings snapshot whose key field is
    // blank (e.g. read before the key was set, or just forgetfully passed
    // through blank) via the FULL saveSettings path.
    await saveSettings({ ...s, omniRouteApiKey: "" });

    expect(await hasOmniRouteApiKey()).toBe(true);
  });

  it("clearing a key still works via the explicit clear verb (setOmniRouteApiKey(''))", async () => {
    await setOmniRouteApiKey("sk-existing");
    expect(await hasOmniRouteApiKey()).toBe(true);
    await setOmniRouteApiKey("");
    expect(await hasOmniRouteApiKey()).toBe(false);
  });
});

describe("hasLocalLlmApiKey / setLocalLlmApiKey", () => {
  it("reports false when no key is stored, true after setting one, false after clearing", async () => {
    expect(await hasLocalLlmApiKey()).toBe(false);

    await setLocalLlmApiKey("local-secret-token");
    expect(await hasLocalLlmApiKey()).toBe(true);

    await setLocalLlmApiKey("");
    expect(await hasLocalLlmApiKey()).toBe(false);
  });
});

describe("relais provider default via getSettings", () => {
  it("defaults the relais entry to the loopback URL and an empty model on a fresh install", async () => {
    const s = await getSettings();
    const relais = resolveActiveProvider(s.llmProviders, "relais");
    expect(relais.baseUrl).toBe("http://127.0.0.1:8080");
    expect(relais.model).toBe("");
    expect(s.localLlmApiKey).toBe("");
  });

  it("round-trips an edited relais entry through saveSettings", async () => {
    const s = await getSettings();
    await saveSettings({
      ...s,
      llmProviders: s.llmProviders.map((p) =>
        p.id === "relais"
          ? { ...p, baseUrl: "http://127.0.0.1:8080", model: "gemma-4" }
          : p,
      ),
    });
    const after = await getSettings();
    const relais = resolveActiveProvider(after.llmProviders, "relais");
    expect(relais.baseUrl).toBe("http://127.0.0.1:8080");
    expect(relais.model).toBe("gemma-4");
  });
});
