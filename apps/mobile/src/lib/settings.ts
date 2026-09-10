import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import {
  buildDefaultProviders,
  isValidProviderList,
  type LlmProvider,
} from "./llmProviders";

/**
 * v3 — bumped from v2 by the LLM provider list (Phase 2). `main` and this
 * branch's `writePersisted` each enumerate their OWN fields explicitly and
 * write the whole blob, so as long as both branches wrote the same
 * `carnet:settings:v2` key, alternating between a main build and a
 * provider-list build (this repo ships sideloaded APKs, so a downgrade is
 * one install away) made each save silently drop the other branch's fields
 * — up to and including losing the OmniRoute URL permanently. Moving to a
 * DISTINCT key means the two shapes never alias: this code only ever WRITES
 * v3; v2 is read-only here, exactly like the v1 fallback below, so an
 * upgrading install's existing config still migrates in, but a subsequent
 * downgrade to a v2-writing build finds its own v2 blob untouched.
 */
const SETTINGS_KEY = "carnet:settings:v3";
/** Pre-provider-list key (main, and this branch before this fix) — read
 * once for migration when no v3 blob exists yet, then never written. */
const SETTINGS_KEY_V2 = "carnet:settings:v2";
/** Legacy key — read once for migration, then ignored. */
const SETTINGS_KEY_V1 = "carnet:settings:v1";
/** Legacy SecureStore key from v0.1's navetted HMAC token. Purged on first
 * v0.2 settings load — see purgeLegacySecretsOnce(). */
const LEGACY_NAVETTED_TOKEN_KEY = "carnet_navetted_token";
const OMNIROUTE_API_KEY = "carnet_omniroute_api_key";
const KARAKEEP_API_KEY = "carnet_karakeep_api_key";
const LOCAL_LLM_API_KEY = "carnet_local_llm_api_key";
/** Flag: user dismissed the navetted→OmniRoute migration banner. */
const MIGRATION_BANNER_KEY = "carnet:migration_banner_dismissed:v1";
/** Flag: legacy SecureStore secrets purged. Set to "1" after the one-time
 * unconditional sweep so we don't hit SecureStore on every getSettings(). */
const LEGACY_PURGE_KEY = "carnet:legacy_purge:v1";

export const DEFAULT_OMNIROUTE_MODEL = "openrouter/openai/gpt-4o-mini";
/** Default vision model — used for image-bearing enrichment (share-target
 * photos). Held separately from omniRouteModel (the chat/text model) so a
 * text-only chat model can never silently eat image parts and return a
 * confidently-wrong "enrichment". Defaults to a known vision-capable model. */
export const DEFAULT_VISION_MODEL = "openrouter/openai/gpt-4o-mini";

/**
 * Legacy enrichment-backend selector — REMOVED from {@link Settings} as of
 * the LLM provider list (Phase 2, see
 * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md). Kept here,
 * type-only, purely to give the one-time migration in this file a name for
 * the shape it reads off an old persisted blob. Do not use for anything new
 * — `Settings.activeProviderId` replaces it.
 */
type LegacyLlmBackend = "omniroute" | "on-device" | "local";

/**
 * Per-capture-mode system prompt overrides. Empty/missing fields fall back
 * to the defaults in `prompts.ts`. Whitespace-only values are sanitised to
 * empty on write so a stray accidental edit doesn't strand a noise override.
 */
export interface PromptOverrides {
  idea?: string;
  journal?: string;
  person?: string;
  sharedImage?: string;
  sharedLink?: string;
  /** Override for the Enhance action's prose-rewrite prompt. Unlike the five
   * capture modes above, this one's default output is bare prose — see
   * prompts.ts's buildEnhanceProsePrompt. */
  enhanceProse?: string;
  /** Override for the retrospective query's synthesis prompt. Like
   * enhanceProse, not a capture mode — its default output is bare prose.
   * See prompts.ts's buildRetrospectivePrompt. */
  retrospective?: string;
}

export interface Settings {
  /** Every configured LLM endpoint — shipped presets (possibly edited) plus
   * any user-created custom entries. Never empty: migration and
   * DEFAULT_PERSISTED both seed it with {@link buildDefaultProviders}. */
  llmProviders: LlmProvider[];
  /** Which entry in {@link llmProviders} serves captures. Read fresh on
   * every dispatcher call (not cached), so switching providers mid-session
   * takes effect on the very next capture. */
  activeProviderId: string;
  /** Monotonically-increasing counter for the NEXT custom provider's id
   * (`custom-<nextCustomSeq>`). Never decreases, even when a custom entry
   * is removed — see llmProviders.ts's addCustomProvider docstring for why
   * reusing a freed id is a credential-leak risk, not just a UX quirk. */
  nextCustomSeq: number;
  /** Offline-fallback provider (Phase 3 — see
   * docs/superpowers/specs/2026-07-31-llm-provider-list-design.md, "Offline
   * fallback"). `null` = no fallback configured, i.e. today's behavior:
   * an unreachable primary goes straight to the offline queue. When set,
   * dispatcher.ts retries EXACTLY ONCE against this entry, and ONLY on an
   * unreachable-class primary failure — never on a permanent 4xx (a bad key
   * or model id must surface, not be silently masked by a smaller local
   * model succeeding). */
  fallbackProviderId: string | null;
  /** Dedicated vision-routing provider (Phase 3). `null` = no dedicated
   * vision provider, i.e. today's behavior: a vision call only works when
   * the ACTIVE entry itself has a vision model. When set, it is consulted
   * only as a second rung — the active entry's own vision model still wins
   * when present. See llmProviders.ts's resolveVisionProvider. */
  visionProviderId: string | null;
  /** Dedicated provider for the Enhance action (rewriting a saved note's
   * prose with a stronger model). `null` = use the active entry, i.e. Enhance
   * runs on whatever serves captures. Mirrors visionProviderId's storage
   * shape, but NOT its precedence: when set, this entry WINS over the active
   * one — see llmProviders.ts's resolveEnhanceProvider for why. */
  enhanceProviderId: string | null;
  /** Model id the Enhance action sends, overriding the resolved provider's own
   * `model`. Blank = use whatever that provider is configured with.
   *
   * Separate from {@link enhanceProviderId} because the interesting case is a
   * DIFFERENT MODEL ON THE SAME ENDPOINT — e.g. captures on
   * `gemini/gemini-2.5-flash` for speed, Enhance on a stronger model through
   * the same OmniRoute entry. Without this, that would mean duplicating the
   * whole provider (base URL, key and all) just to vary one string.
   *
   * Must be cleared whenever `enhanceProviderId` changes: a model id is only
   * meaningful against the endpoint that lists it. */
  enhanceModel: string;
  /** OmniRoute API key (Bearer). Held in SecureStore, never persisted to the
   * AsyncStorage settings blob. Kept as a dedicated field (rather than
   * folded into a generic per-provider key lookup here) because it predates
   * the provider list and existing UI code reads it directly; new provider
   * ids fetch their key via providerKeys.ts instead. */
  omniRouteApiKey: string;
  /** Local-LLM (Relais) API key (Bearer). Held in SecureStore, never
   * persisted to the AsyncStorage settings blob — mirrors omniRouteApiKey.
   * Optional in practice: Relais's loopback port is unauthenticated, but the
   * field stays available for a LAN-facing/authenticated deployment. */
  localLlmApiKey: string;
  /** JS-side hint for the Settings UI's initial render — avoids a Switch
   * flicker before the async native read resolves. Source of truth lives
   * in native SharedPreferences (BootReceiver reads it directly). Whenever
   * these two diverge, native wins; SettingsScreen reconciles on mount. */
  persistentNotificationEnabled: boolean;
  /** When true, audio captures auto-run on-device transcription after save.
   * Default false — doubles OmniRoute API spend per capture, so opt-in. */
  autoTranscribeOnSave: boolean;
  /** When true, capture prompts are given the vault's existing tag vocabulary
   * so auto-tagging reuses curated tags instead of minting near-duplicates
   * (`dev` vs `development` vs `engineering`). Default true — the hint is
   * best-effort and costs nothing when no note index is cached yet. Turn off
   * to get the pre-v0.12 behavior of tagging purely from content. */
  useExistingTagsForAutoTag: boolean;
  /** When true, RecentDetail note editing uses the experimental WYSIWYG (TenTap)
   * editor instead of the markdown TextInput + toolbar. Default false — off
   * until on-device round-trip fidelity is signed off. */
  richEditorEnabled: boolean;
  /**
   * When true, Idea captures restore the old blocking flow: enrich → preview →
   * Save tap → write. Default false, i.e. save-first is the default — the raw
   * note is written immediately and enrichment updates it in place afterwards.
   * Person always previews and ignores this flag; Journal is unaffected (it
   * stays on the deferred-write model this branch does not change).
   */
  previewBeforeSave: boolean;
  /**
   * Root folder for captured notes. Defaults to the app sandbox carnet/ dir.
   * Set to a Syncthing-watched folder for automatic sync to workstation.
   */
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
  /** Self-hosted Karakeep instance URL (e.g. https://karakeep.example.com).
   * The `/api/v1` suffix is appended by the client. Blank = export disabled. */
  karakeepUrl: string;
  /** Karakeep API key (Bearer). Held in SecureStore, never persisted to the
   * AsyncStorage settings blob — mirrors omniRouteApiKey. */
  karakeepApiKey: string;
}

interface PersistedSettings {
  llmProviders: LlmProvider[];
  activeProviderId: string;
  nextCustomSeq: number;
  fallbackProviderId: string | null;
  visionProviderId: string | null;
  enhanceProviderId: string | null;
  enhanceModel: string;
  persistentNotificationEnabled: boolean;
  autoTranscribeOnSave: boolean;
  useExistingTagsForAutoTag: boolean;
  richEditorEnabled: boolean;
  previewBeforeSave: boolean;
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
  karakeepUrl: string;
}

/** Shape of a v1 settings blob — used for one-time migration read. */
interface LegacyPersistedSettings {
  navettedUrl?: string;
  omniRouteUrl?: string;
  captureFolderPath?: string;
}

/** Shape of a pre-provider-list (Phase 1 and earlier) v2 settings blob —
 * used for the one-time llmProviders migration in readPersisted(). */
interface LegacyLlmPersistedSettings {
  omniRouteUrl?: string;
  omniRouteModel?: string;
  omniRouteVisionModel?: string;
  localLlmUrl?: string;
  localLlmModel?: string;
  llmBackend?: LegacyLlmBackend;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  llmProviders: buildDefaultProviders(),
  activeProviderId: "omniroute",
  nextCustomSeq: 1,
  fallbackProviderId: null,
  visionProviderId: null,
  enhanceProviderId: null,
  enhanceModel: "",
  persistentNotificationEnabled: false,
  autoTranscribeOnSave: false,
  useExistingTagsForAutoTag: true,
  richEditorEnabled: true,
  previewBeforeSave: false,
  captureFolderPath: "",
  promptOverrides: {},
  karakeepUrl: "",
};

/**
 * One-time migration from the pre-provider-list settings shape (a
 * `llmBackend` field, `omniRoute*`/`localLlm*` flat fields, no
 * `llmProviders`) to the provider list. Pure function of the parsed blob —
 * calling it twice on the same input yields structurally identical output,
 * which is what makes it safe to run on every read of an unmigrated blob
 * (this module never writes the migrated shape back to AsyncStorage itself;
 * the next explicit saveSettings() call persists it).
 *
 * Deliberately does NOT touch SecureStore — the design spec's proposed step
 * of re-filing API keys under new aliases is overridden; see providerKeys.ts
 * for why (a key that never moves cannot be lost).
 */
function migrateLegacyLlmSettings(
  legacy: LegacyLlmPersistedSettings,
): Pick<PersistedSettings, "llmProviders" | "activeProviderId"> {
  const providers = buildDefaultProviders();
  const omniroute = providers.find((p) => p.id === "omniroute");
  if (omniroute) {
    omniroute.baseUrl = legacy.omniRouteUrl ?? "";
    // `?? DEFAULT_...` (not `?? ""`) — matches the pre-migration behavior
    // these fields actually had: DEFAULT_PERSISTED filled an ABSENT model/
    // vision-model key with these same defaults via the old
    // `{...DEFAULT_PERSISTED, ...parsed}` merge. A blob from before the B1
    // vision-model split (PR #65) — URL + chat model present, no vision key
    // at all — has `omniRouteVisionModel` genuinely `undefined`, not "".
    // Model has a second rung at dispatch time (buildConfig's
    // `|| DEFAULT_OMNIROUTE_MODEL`), but visionModel does NOT — a blank
    // vision model goes straight to assertVisionModelConfigured and throws,
    // silently breaking image enrichment and card OCR for exactly that
    // upgrade path.
    omniroute.model = legacy.omniRouteModel ?? DEFAULT_OMNIROUTE_MODEL;
    omniroute.visionModel = legacy.omniRouteVisionModel ?? DEFAULT_VISION_MODEL;
  }
  const relais = providers.find((p) => p.id === "relais");
  if (relais) {
    // Blank local URL keeps the loopback default (matches today's
    // behavior — localLlm.ts always fell back to 127.0.0.1:8080 rather
    // than treating a blank URL as not-configured).
    const trimmedLocalUrl = (legacy.localLlmUrl ?? "").trim();
    if (trimmedLocalUrl) relais.baseUrl = trimmedLocalUrl;
    relais.model = legacy.localLlmModel ?? "";
  }
  // "on-device" never had an implementation, so anyone holding that value
  // was already falling through — it maps to relais, same as "local". A
  // MISSING llmBackend (a blob older than the field itself) defaults to
  // "omniroute", matching the old `{...DEFAULT_PERSISTED, ...parsed}`
  // merge's behavior (DEFAULT_LLM_BACKEND was "omniroute").
  const activeProviderId =
    legacy.llmBackend === "local" || legacy.llmBackend === "on-device"
      ? "relais"
      : "omniroute";
  return { llmProviders: providers, activeProviderId };
}

/** Strip whitespace-only entries so a `{idea: "   "}` save doesn't strand
 * noise in storage that downstream code would treat as a real override. */
function sanitisePromptOverrides(raw: PromptOverrides | undefined): PromptOverrides {
  if (!raw) return {};
  const out: PromptOverrides = {};
  (Object.keys(raw) as Array<keyof PromptOverrides>).forEach((k) => {
    const v = raw[k]?.trim();
    if (v) out[k] = v;
  });
  return out;
}

/**
 * Parse a v3-or-v2-shaped blob (both are read through this — v2's shape is
 * a strict subset, since v3 only ADDED fields) into a full
 * {@link PersistedSettings}, running the legacy-LLM migration when needed.
 * Returns null on a JSON parse failure OR a validation failure the caller
 * should treat as "nothing useful here" (fall through to the next source).
 *
 * Shape-validates `llmProviders` before trusting it — `parsed.llmProviders`
 * comes straight off `JSON.parse`, so nothing guarantees it is even an
 * array (a hand-edited or corrupted blob could hold a string, an object, or
 * `[]`). Downstream code calls `.find`/`.map` on it with no defensive
 * checks (by design — the Settings type promises a real array), and
 * SettingsScreen's mount effect calls `formStateFromSettings` outside any
 * try/catch, so an invalid shape reaching that far renders "Loading…"
 * forever with no other way to open Settings. Falling back to
 * buildDefaultProviders() here means that failure mode is structurally
 * impossible downstream.
 */
function parseModernBlob(raw: string): PersistedSettings | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSettings> &
      LegacyLlmPersistedSettings;
    const validLlmProviders = isValidProviderList(parsed.llmProviders)
      ? parsed.llmProviders
      : null;
    // Migration trigger: a blob carrying ANY pre-provider-list LLM field
    // (llmBackend, or one of the flat omniRoute*/localLlm* fields — an even
    // older blob predating llmBackend itself can still have these without
    // it) and no VALID `llmProviders` yet is pre-provider-list. Idempotent
    // — once a migrated (or fresh) blob is saved, it carries a valid
    // `llmProviders` and this branch is never taken again for it.
    const hasLegacyLlmFields =
      parsed.llmBackend !== undefined ||
      parsed.omniRouteUrl !== undefined ||
      parsed.omniRouteModel !== undefined ||
      parsed.omniRouteVisionModel !== undefined ||
      parsed.localLlmUrl !== undefined ||
      parsed.localLlmModel !== undefined;
    const llmFields =
      !validLlmProviders && hasLegacyLlmFields
        ? migrateLegacyLlmSettings(parsed)
        : {
            llmProviders: validLlmProviders ?? buildDefaultProviders(),
            activeProviderId:
              parsed.activeProviderId ?? DEFAULT_PERSISTED.activeProviderId,
          };
    return {
      ...DEFAULT_PERSISTED,
      ...parsed,
      ...llmFields,
      nextCustomSeq:
        typeof parsed.nextCustomSeq === "number"
          ? parsed.nextCustomSeq
          : DEFAULT_PERSISTED.nextCustomSeq,
      // Extends the v3 migration (no new settings key/version — a blob that
      // predates these two fields simply lacks them, so they default to
      // `null` here exactly like every other pre-v3 field defaults via the
      // `{...DEFAULT_PERSISTED, ...parsed}` merge above). Explicit
      // type-checked here (not left to the merge) because unlike a boolean/
      // string field, `null` is a meaningful third state distinct from a
      // missing key, and a corrupted/hand-edited blob could hold a
      // non-string, non-null value that would otherwise propagate straight
      // into a `.find(p => p.id === fallbackProviderId)` call downstream.
      fallbackProviderId:
        typeof parsed.fallbackProviderId === "string"
          ? parsed.fallbackProviderId
          : null,
      visionProviderId:
        typeof parsed.visionProviderId === "string" ? parsed.visionProviderId : null,
      // Additive optional field — a blob written before Enhance shipped has no
      // such key. The `: null` arm is mandatory, not defensive: leaving it
      // `undefined` would let JSON.stringify DROP the key on the next write, so
      // it would silently never persist.
      enhanceProviderId:
        typeof parsed.enhanceProviderId === "string" ? parsed.enhanceProviderId : null,
      // Blank (not undefined) is the "use the provider's own model" sentinel —
      // same JSON.stringify-drops-undefined trap as the ids above.
      enhanceModel: typeof parsed.enhanceModel === "string" ? parsed.enhanceModel : "",
      promptOverrides: sanitisePromptOverrides(parsed.promptOverrides),
    };
  } catch {
    return null;
  }
}

async function readPersisted(): Promise<PersistedSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (raw) {
    const parsed = parseModernBlob(raw);
    if (parsed) return parsed;
    return { ...DEFAULT_PERSISTED, llmProviders: buildDefaultProviders() };
  }

  // Fall back to the pre-v3 blob (written by `main`, or by this branch
  // before the v3 bump) — read once for migration, exactly like the v1
  // fallback below. Never written here; see the SETTINGS_KEY comment.
  const rawV2 = await AsyncStorage.getItem(SETTINGS_KEY_V2);
  if (rawV2) {
    const parsed = parseModernBlob(rawV2);
    if (parsed) return parsed;
  }

  // Try migrating from v1 blob
  const rawV1 = await AsyncStorage.getItem(SETTINGS_KEY_V1);
  if (rawV1) {
    try {
      const legacy = JSON.parse(rawV1) as LegacyPersistedSettings;
      return {
        llmProviders: buildDefaultProviders(),
        activeProviderId: DEFAULT_PERSISTED.activeProviderId,
        nextCustomSeq: DEFAULT_PERSISTED.nextCustomSeq,
        fallbackProviderId: null,
        visionProviderId: null,
        enhanceProviderId: null,
        enhanceModel: "",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        useExistingTagsForAutoTag: true,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: legacy.captureFolderPath ?? "",
        promptOverrides: {},
        karakeepUrl: "",
      };
    } catch {
      return { ...DEFAULT_PERSISTED, llmProviders: buildDefaultProviders() };
    }
  }

  return { ...DEFAULT_PERSISTED, llmProviders: buildDefaultProviders() };
}

async function writePersisted(settings: PersistedSettings): Promise<void> {
  const sanitised: PersistedSettings = {
    llmProviders: settings.llmProviders,
    activeProviderId: settings.activeProviderId,
    nextCustomSeq: settings.nextCustomSeq,
    fallbackProviderId: settings.fallbackProviderId,
    visionProviderId: settings.visionProviderId,
    enhanceProviderId: settings.enhanceProviderId,
    enhanceModel: settings.enhanceModel,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    useExistingTagsForAutoTag: settings.useExistingTagsForAutoTag,
    richEditorEnabled: settings.richEditorEnabled,
    previewBeforeSave: settings.previewBeforeSave,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: sanitisePromptOverrides(settings.promptOverrides),
    karakeepUrl: settings.karakeepUrl,
  };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitised));
}

/**
 * One-time unconditional sweep of legacy SecureStore secrets. Runs the first
 * time v0.2 boots after an upgrade. Catches the case where a user upgraded
 * past the migration banner without dismissing it (e.g. fresh install with
 * leftover keychain entries from a prior install).
 */
async function purgeLegacySecretsOnce(): Promise<void> {
  const done = await AsyncStorage.getItem(LEGACY_PURGE_KEY);
  if (done) return;
  try {
    await SecureStore.deleteItemAsync(LEGACY_NAVETTED_TOKEN_KEY);
  } catch {
    // SecureStore can throw on platforms without keychain access — best-effort
  }
  await AsyncStorage.setItem(LEGACY_PURGE_KEY, "1");
}

export async function getSettings(): Promise<Settings> {
  await purgeLegacySecretsOnce();
  const persisted = await readPersisted();
  const omniRouteApiKey =
    (await SecureStore.getItemAsync(OMNIROUTE_API_KEY)) ?? "";
  const karakeepApiKey =
    (await SecureStore.getItemAsync(KARAKEEP_API_KEY)) ?? "";
  const localLlmApiKey =
    (await SecureStore.getItemAsync(LOCAL_LLM_API_KEY)) ?? "";

  return {
    llmProviders: persisted.llmProviders,
    activeProviderId: persisted.activeProviderId,
    nextCustomSeq: persisted.nextCustomSeq,
    fallbackProviderId: persisted.fallbackProviderId,
    visionProviderId: persisted.visionProviderId,
    enhanceProviderId: persisted.enhanceProviderId,
    enhanceModel: persisted.enhanceModel,
    omniRouteApiKey,
    localLlmApiKey,
    persistentNotificationEnabled: persisted.persistentNotificationEnabled,
    autoTranscribeOnSave: persisted.autoTranscribeOnSave,
    useExistingTagsForAutoTag: persisted.useExistingTagsForAutoTag,
    richEditorEnabled: persisted.richEditorEnabled,
    previewBeforeSave: persisted.previewBeforeSave,
    captureFolderPath: persisted.captureFolderPath,
    promptOverrides: persisted.promptOverrides,
    karakeepUrl: persisted.karakeepUrl,
    karakeepApiKey,
  };
}

/**
 * Persist ONLY the non-secret blob — never touches SecureStore. This is the
 * safe primitive for any caller that does a read-modify-write of a Settings
 * SNAPSHOT it may have captured a while ago (e.g. persistNotificationHint,
 * which re-saves a `getSettings()` result it read before an async native
 * permission dialog).
 *
 * `saveSettings` (below) is NOT that primitive — it is the full "user tapped
 * Save" path, and it used to ALSO delete every API key whose field on the
 * passed-in `Settings` was blank. That is exactly the bug this function
 * exists to make impossible for a stale-snapshot caller to trigger: if
 * `persistNotificationHint` reads settings while a key is mid-flight (typed
 * but not yet saved), its snapshot has `omniRouteApiKey: ""`; without this
 * split, its later best-effort save would delete the key the real Save had
 * *already* written in the meantime — the toggle would go through, and a
 * live credential would silently vanish with no error shown anywhere.
 * Confirmed via a regression test in settings.test.ts.
 */
export async function savePersistedOnly(settings: Settings): Promise<void> {
  await writePersisted({
    llmProviders: settings.llmProviders,
    activeProviderId: settings.activeProviderId,
    nextCustomSeq: settings.nextCustomSeq,
    fallbackProviderId: settings.fallbackProviderId,
    visionProviderId: settings.visionProviderId,
    enhanceProviderId: settings.enhanceProviderId,
    enhanceModel: settings.enhanceModel,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    useExistingTagsForAutoTag: settings.useExistingTagsForAutoTag,
    richEditorEnabled: settings.richEditorEnabled,
    previewBeforeSave: settings.previewBeforeSave,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: settings.promptOverrides,
    karakeepUrl: settings.karakeepUrl,
  });
}

/**
 * Persist the full Settings object: the non-secret blob, PLUS whichever of
 * the three dedicated API keys carries a non-blank value. This is the
 * "user tapped Save" path — it deliberately does NOT delete a key when its
 * field is blank (there used to be an `else { deleteItemAsync(...) }`
 * branch per key; it is gone on purpose). Clearing a key already has an
 * explicit, intentional verb — clearApiKey / setOmniRouteApiKey("") /
 * setKarakeepApiKey("") / setLocalLlmApiKey("") — called directly from the
 * screen's "Clear key" buttons. Deleting-by-omission here was a second,
 * accidental path to the same effect, and the dangerous one: ANY caller
 * that persists a Settings snapshot with a blank key field — including one
 * that's blank only because it was read before a concurrent write landed —
 * would silently wipe a real, already-stored credential. See
 * savePersistedOnly's docstring for the concrete interleave this caused.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  await savePersistedOnly(settings);
  if (settings.omniRouteApiKey) {
    await SecureStore.setItemAsync(OMNIROUTE_API_KEY, settings.omniRouteApiKey);
  }
  if (settings.karakeepApiKey) {
    await SecureStore.setItemAsync(KARAKEEP_API_KEY, settings.karakeepApiKey);
  }
  if (settings.localLlmApiKey) {
    await SecureStore.setItemAsync(LOCAL_LLM_API_KEY, settings.localLlmApiKey);
  }
}

/** Convenience read for the enrich entry points — skips SecureStore so an
 * enrich call doesn't pay the keychain cost just to read the prompt
 * overrides (the API key lives elsewhere in this module). */
export async function getPromptOverrides(): Promise<PromptOverrides> {
  const persisted = await readPersisted();
  return persisted.promptOverrides;
}

/**
 * True if there is an API key stored in SecureStore. Used by the settings
 * UI to render a "•••• configured" placeholder rather than reading the key
 * into React state for display.
 */
export async function hasOmniRouteApiKey(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(OMNIROUTE_API_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** Write-only setter for the API key. Used by the settings UI. */
export async function setOmniRouteApiKey(value: string): Promise<void> {
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(OMNIROUTE_API_KEY, value.trim());
  } else {
    await SecureStore.deleteItemAsync(OMNIROUTE_API_KEY);
  }
}

/**
 * True if there is a Karakeep API key stored in SecureStore. Used by the
 * settings UI to render a "•••• configured" placeholder rather than reading
 * the key into React state for display.
 */
export async function hasKarakeepApiKey(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(KARAKEEP_API_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** Write-only setter for the Karakeep API key. Used by the settings UI. */
export async function setKarakeepApiKey(value: string): Promise<void> {
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(KARAKEEP_API_KEY, value.trim());
  } else {
    await SecureStore.deleteItemAsync(KARAKEEP_API_KEY);
  }
}

/**
 * True if there is a local-LLM API key stored in SecureStore. Used by the
 * settings UI to render a "•••• configured" placeholder rather than reading
 * the key into React state for display.
 */
export async function hasLocalLlmApiKey(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(LOCAL_LLM_API_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** Write-only setter for the local-LLM API key. Used by the settings UI. */
export async function setLocalLlmApiKey(value: string): Promise<void> {
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(LOCAL_LLM_API_KEY, value.trim());
  } else {
    await SecureStore.deleteItemAsync(LOCAL_LLM_API_KEY);
  }
}

/**
 * Returns true if the user should see the navetted→OmniRoute migration banner.
 * Triggers when: v1 settings blob exists (user was on v0.1) AND banner not yet dismissed.
 */
export async function shouldShowMigrationBanner(): Promise<boolean> {
  const dismissed = await AsyncStorage.getItem(MIGRATION_BANNER_KEY);
  if (dismissed) return false;
  const rawV1 = await AsyncStorage.getItem(SETTINGS_KEY_V1);
  return rawV1 !== null;
}

/**
 * Dismiss the migration banner. Clears the v1 settings blob and the legacy
 * navetted token from SecureStore.
 */
export async function dismissMigrationBanner(): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(MIGRATION_BANNER_KEY, "1"),
    AsyncStorage.removeItem(SETTINGS_KEY_V1),
    SecureStore.deleteItemAsync(LEGACY_NAVETTED_TOKEN_KEY),
  ]);
}
