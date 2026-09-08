/**
 * Portable, non-secret settings transfer format.
 *
 * This intentionally stays separate from settings.ts: the latter includes
 * SecureStore-backed API-key fields in its in-memory Settings type, whereas a
 * transfer file must be safe to share and therefore never serializes them.
 */
import type { Settings } from "./settings";
import type { ThemePreference } from "./themePreference";
import {
  PROVIDER_PRESETS,
  isLlmProvider,
  validateProvider,
  type LlmProvider,
} from "./llmProviders";

const FORMAT = "carnet-settings";
const VERSION = 1;

export interface SettingsTransfer {
  format: typeof FORMAT;
  version: typeof VERSION;
  settings: {
    llmProviders: LlmProvider[];
    activeProviderId: string;
    nextCustomSeq: number;
    fallbackProviderId: string | null;
    visionProviderId: string | null;
    persistentNotificationEnabled: boolean;
    autoTranscribeOnSave: boolean;
    richEditorEnabled: boolean;
    previewBeforeSave: boolean;
    captureFolderPath: string;
    promptOverrides: Settings["promptOverrides"];
    karakeepUrl: string;
    themePreference: ThemePreference;
  };
}

type ImportedSettings = SettingsTransfer["settings"];

/** Make the shareable JSON. API keys are deliberately absent. */
export function serializeSettingsTransfer(
  settings: Settings,
  themePreference: ThemePreference = "system",
): string {
  const transfer: SettingsTransfer = {
    format: FORMAT,
    version: VERSION,
    settings: {
      llmProviders: settings.llmProviders.map((provider) => ({ ...provider })),
      activeProviderId: settings.activeProviderId,
      nextCustomSeq: settings.nextCustomSeq,
      fallbackProviderId: settings.fallbackProviderId,
      visionProviderId: settings.visionProviderId,
      persistentNotificationEnabled: settings.persistentNotificationEnabled,
      autoTranscribeOnSave: settings.autoTranscribeOnSave,
      richEditorEnabled: settings.richEditorEnabled,
      previewBeforeSave: settings.previewBeforeSave,
      captureFolderPath: settings.captureFolderPath,
      promptOverrides: { ...settings.promptOverrides },
      karakeepUrl: settings.karakeepUrl,
      themePreference,
    },
  };
  return JSON.stringify(transfer, null, 2);
}

/**
 * Parse an untrusted transfer file before any settings write. The returned
 * value intentionally resets package-scoped state: a SAF URI grant and a
 * running foreground service cannot be moved to another app installation.
 */
export function parseSettingsTransfer(raw: string): ImportedSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("This is not a valid Carnet settings file.");
  }
  if (!isRecord(parsed) || parsed.format !== FORMAT) {
    throw new Error("This file is not a Carnet settings export.");
  }
  if (parsed.version !== VERSION) {
    throw new Error("This settings export uses an unsupported version.");
  }
  if (!isRecord(parsed.settings)) {
    throw new Error("This settings export is missing its settings payload.");
  }

  const settings = parsed.settings;
  if (!isValidSettingsShape(settings)) {
    throw new Error("This settings export is incomplete or malformed.");
  }
  validateProvidersAndReferences(settings);

  return {
    // Strip allowInsecureTransport (#176) on import — a receiving device
    // must re-consent explicitly rather than silently inherit another
    // device's cleartext opt-in for a provider it may resolve to a
    // different address on THIS network. Consent is a per-device trust
    // decision, not a portable setting.
    llmProviders: settings.llmProviders.map((provider) => ({
      ...provider,
      allowInsecureTransport: false,
    })),
    activeProviderId: settings.activeProviderId,
    nextCustomSeq: settings.nextCustomSeq,
    fallbackProviderId: settings.fallbackProviderId,
    visionProviderId: settings.visionProviderId,
    // The native service and its preference live under the source app id.
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    richEditorEnabled: settings.richEditorEnabled,
    previewBeforeSave: settings.previewBeforeSave,
    // SAF grants are package-scoped and therefore invalid in a new app.
    captureFolderPath: settings.captureFolderPath.startsWith("content://")
      ? ""
      : settings.captureFolderPath,
    promptOverrides: { ...settings.promptOverrides },
    karakeepUrl: settings.karakeepUrl,
    themePreference: settings.themePreference,
  };
}

/**
 * Reissue custom ids from the destination's monotonic counter. An import must
 * never let `custom-1` inherit an orphaned SecureStore key on this device.
 */
export function reissueImportedCustomProviderIds(
  imported: ImportedSettings,
  targetNextCustomSeq: number,
): ImportedSettings {
  let next = targetNextCustomSeq;
  const replacements = new Map<string, string>();
  const llmProviders = imported.llmProviders.map((provider) => {
    if (provider.preset !== null) return { ...provider };
    const id = `custom-${next++}`;
    replacements.set(provider.id, id);
    return { ...provider, id };
  });
  const resolve = (id: string | null): string | null =>
    id === null ? null : (replacements.get(id) ?? id);
  return {
    ...imported,
    llmProviders,
    activeProviderId: resolve(imported.activeProviderId) ?? imported.activeProviderId,
    fallbackProviderId: resolve(imported.fallbackProviderId),
    visionProviderId: resolve(imported.visionProviderId),
    nextCustomSeq: next,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** MUST list every key of PromptOverrides (settings.ts). This is used as a
 * VALIDATOR below, not a filter, so a key missing from here doesn't get
 * quietly dropped on import — it fails shape validation and the user's whole
 * settings file is refused. It has drifted twice already (enhanceProse, then
 * retrospective); add the key here in the same change that adds it there. */
const PROMPT_OVERRIDE_KEYS: readonly (keyof Settings["promptOverrides"])[] = [
  "idea",
  "journal",
  "person",
  "sharedImage",
  "sharedLink",
  "enhanceProse",
  "retrospective",
];

function isPromptOverrides(value: unknown): value is Settings["promptOverrides"] {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      (PROMPT_OVERRIDE_KEYS as readonly string[]).includes(key) && typeof item === "string",
  );
}

function isValidSettingsShape(value: Record<string, unknown>): value is ImportedSettings {
  return (
    Array.isArray(value.llmProviders) &&
    value.llmProviders.length > 0 &&
    value.llmProviders.every(isLlmProvider) &&
    typeof value.activeProviderId === "string" &&
    Number.isSafeInteger(value.nextCustomSeq) &&
    (value.nextCustomSeq as number) >= 1 &&
    isNullableString(value.fallbackProviderId) &&
    isNullableString(value.visionProviderId) &&
    typeof value.persistentNotificationEnabled === "boolean" &&
    typeof value.autoTranscribeOnSave === "boolean" &&
    typeof value.richEditorEnabled === "boolean" &&
    typeof value.previewBeforeSave === "boolean" &&
    typeof value.captureFolderPath === "string" &&
    isPromptOverrides(value.promptOverrides) &&
    typeof value.karakeepUrl === "string"
    &&
    (value.themePreference === "system" ||
      value.themePreference === "light" ||
      value.themePreference === "dark")
  );
}

function validateProvidersAndReferences(settings: ImportedSettings): void {
  const ids = new Set<string>();
  for (const provider of settings.llmProviders) {
    if (!provider.id || ids.has(provider.id)) {
      throw new Error("This settings export has duplicate or empty provider ids.");
    }
    ids.add(provider.id);
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === provider.id);
    if (preset) {
      if (provider.preset !== provider.id) {
        throw new Error(`Provider “${provider.id}” has an invalid preset identity.`);
      }
    } else {
      if (provider.preset !== null || !/^custom-[1-9][0-9]*$/.test(provider.id)) {
        throw new Error("This settings export has an invalid custom provider id.");
      }
      const errors = validateProvider(provider);
      if (errors.length > 0) throw new Error(`Provider “${provider.label}” is invalid.`);
    }
    if (provider.baseUrl) {
      try {
        const protocol = new URL(provider.baseUrl).protocol;
        if (protocol !== "http:" && protocol !== "https:") throw new Error();
      } catch {
        throw new Error(`Provider “${provider.label}” has an invalid URL.`);
      }
    }
  }
  for (const preset of PROVIDER_PRESETS) {
    if (!ids.has(preset.id)) {
      throw new Error(`This settings export is missing the ${preset.label} provider.`);
    }
  }
  for (const id of [
    settings.activeProviderId,
    settings.fallbackProviderId,
    settings.visionProviderId,
  ]) {
    if (id !== null && !ids.has(id)) {
      throw new Error("This settings export refers to a missing provider.");
    }
  }
}
