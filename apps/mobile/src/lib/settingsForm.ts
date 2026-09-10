/**
 * Pure helpers for the Settings form, extracted from SettingsScreen so the
 * decidable-in-isolation pieces (Settings composition + capture-folder label)
 * have direct test coverage. The screen keeps its useState wiring and the
 * awaited IO (saveSettings, SecureStore key writes); these functions only
 * shape data.
 */

import type { PromptOverrides, Settings } from "./settings";

/** Editable slice of {@link Settings} the Settings form renders. The API keys
 * are intentionally excluded — they live in SecureStore and are never read
 * into render state; only a "configured?" flag and a newly-typed replacement
 * are tracked by the screen. The LLM provider list itself (`llmProviders`,
 * `activeProviderId`, `nextCustomSeq`, `fallbackProviderId`,
 * `visionProviderId`) is NOT part of FormState as of Phase 4 —
 * `components/LlmProviderSection.tsx` owns that slice end-to-end (its own
 * reads, its own immediate writes), independent of this form's Save button.
 * See docs/superpowers/specs/2026-07-31-llm-provider-list-design.md, "UI". */
export interface FormState {
  persistentNotificationEnabled: boolean;
  autoTranscribeOnSave: boolean;
  useExistingTagsForAutoTag: boolean;
  richEditorEnabled: boolean;
  previewBeforeSave: boolean;
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
  karakeepUrl: string;
}

/** The currently-stored API keys, threaded into the saved Settings so
 * saveSettings doesn't wipe any of them when only URL/model/folder changed.
 * localLlmApiKey is threaded through the same way (rather than added to
 * FormState) because it is a secret and lives in SecureStore, never in render
 * state. localLlmUrl/localLlmModel are NOT part of this interface: they live
 * on FormState as plain-text config fields and are passed through by
 * composeSettingsForSave. */
export interface ExistingApiKeys {
  omniRouteApiKey: string;
  karakeepApiKey: string;
  localLlmApiKey: string;
}

/**
 * Compose the {@link Settings} object to persist from the form state, the
 * existing keys, and a freshly-read `currentSettings` snapshot. The LLM
 * identity fields (`llmProviders`, `activeProviderId`, `nextCustomSeq`,
 * `fallbackProviderId`, `visionProviderId`, `enhanceProviderId`) are threaded straight through
 * from `currentSettings` UNCHANGED — as of Phase 4,
 * `components/LlmProviderSection.tsx` persists that slice itself, on its own
 * immediate writes, independent of this form's Save button. This function
 * must never overwrite it with a stale value, since the section may have
 * changed it since `currentSettings` was captured only moments earlier — it
 * simply must not be DROPPED by this save. The keys are passed through
 * unchanged: when the user typed a new key the screen writes it separately
 * via setKarakeepApiKey after this save, and passing the existing (or empty)
 * key here matches the prior behavior where saveSettings preserves — or
 * clears — the stored key.
 */
export function composeSettingsForSave(
  form: FormState,
  existing: ExistingApiKeys,
  currentSettings: Settings,
): Settings {
  return {
    llmProviders: currentSettings.llmProviders,
    activeProviderId: currentSettings.activeProviderId,
    nextCustomSeq: currentSettings.nextCustomSeq,
    fallbackProviderId: currentSettings.fallbackProviderId,
    visionProviderId: currentSettings.visionProviderId,
    enhanceProviderId: currentSettings.enhanceProviderId,
    enhanceModel: currentSettings.enhanceModel,
    localLlmApiKey: existing.localLlmApiKey,
    persistentNotificationEnabled: form.persistentNotificationEnabled,
    autoTranscribeOnSave: form.autoTranscribeOnSave,
    useExistingTagsForAutoTag: form.useExistingTagsForAutoTag,
    richEditorEnabled: form.richEditorEnabled,
    previewBeforeSave: form.previewBeforeSave,
    omniRouteApiKey: existing.omniRouteApiKey,
    captureFolderPath: form.captureFolderPath,
    promptOverrides: form.promptOverrides,
    karakeepUrl: form.karakeepUrl,
    karakeepApiKey: existing.karakeepApiKey,
  };
}

/**
 * Builds the initial {@link FormState} from a loaded {@link Settings} plus
 * the (already-reconciled) notification toggle value. The inverse of
 * {@link composeSettingsForSave}'s field-by-field mapping — kept separate
 * because the notification field can't be read straight off `s` (it goes
 * through native-state reconciliation first).
 */
export function formStateFromSettings(
  s: Settings,
  persistentNotificationEnabled: boolean,
): FormState {
  return {
    persistentNotificationEnabled,
    autoTranscribeOnSave: s.autoTranscribeOnSave,
    useExistingTagsForAutoTag: s.useExistingTagsForAutoTag,
    richEditorEnabled: s.richEditorEnabled,
    previewBeforeSave: s.previewBeforeSave,
    captureFolderPath: s.captureFolderPath,
    promptOverrides: s.promptOverrides,
    karakeepUrl: s.karakeepUrl,
  };
}

/**
 * Best-effort human-readable label for a `content://` tree URI. SAF URIs look
 * like `content://com.android.externalstorage.documents/tree/primary%3AObsidian%2FCarnet`
 * — show the decoded tail after `tree/` so the user sees `primary:Obsidian/Carnet`.
 * Plain filesystem paths and non-content URIs are returned unchanged.
 */
export function captureFolderLabel(raw: string): string {
  if (!raw) return "";
  if (!raw.startsWith("content://")) return raw;
  try {
    const decoded = decodeURIComponent(raw);
    const idx = decoded.lastIndexOf("tree/");
    if (idx >= 0) return decoded.slice(idx + 5);
    return decoded;
  } catch {
    return raw;
  }
}

/**
 * Formats a caught error into a short, user-facing message: "<prefix>: <message>",
 * truncating the underlying message to 120 chars so it stays readable in a
 * Snackbar. Shared by every catch block on the Settings screen that surfaces
 * a failure this way (save, clear-key, folder picker, notification toggle).
 */
export function errorMessage(e: unknown, prefix: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `${prefix}: ${msg.slice(0, 120)}`;
}

/**
 * Extracts the currently-stored API keys from a loaded {@link Settings},
 * defaulting missing/undefined keys to "" — the {@link ExistingApiKeys} shape
 * `composeSettingsForSave` needs so a save that doesn't touch a given key
 * doesn't wipe it.
 */
export function existingApiKeysFromSettings(s: Settings): ExistingApiKeys {
  return {
    omniRouteApiKey: s.omniRouteApiKey ?? "",
    karakeepApiKey: s.karakeepApiKey ?? "",
    localLlmApiKey: s.localLlmApiKey ?? "",
  };
}

/**
 * Label for a secret-key TextInput: shows "(configured)" only when a key is
 * already stored AND the user hasn't started typing a replacement.
 */
export function apiKeyFieldLabel(
  baseLabel: string,
  configured: boolean,
  pendingLength: number,
): string {
  return configured && pendingLength === 0
    ? `${baseLabel} (configured)`
    : baseLabel;
}

/**
 * Placeholder for a secret-key TextInput: the "already configured" hint when
 * a key is stored, otherwise the caller-supplied blank-state hint.
 */
export function apiKeyFieldPlaceholder(
  configured: boolean,
  blankPlaceholder: string,
): string {
  return configured ? "•••• configured — tap to replace" : blankPlaceholder;
}
