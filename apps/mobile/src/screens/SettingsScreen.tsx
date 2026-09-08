import { useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { StorageAccessFramework } from "expo-file-system/legacy";
import {
  Banner,
  Button,
  HelperText,
  List,
  SegmentedButtons,
  Snackbar,
  Switch,
  Text,
  TextInput,
} from "react-native-paper";

import {
  dismissMigrationBanner,
  getSettings,
  hasKarakeepApiKey,
  saveSettings,
  savePersistedOnly,
  setKarakeepApiKey,
  shouldShowMigrationBanner,
} from "../lib/settings";
import {
  apiKeyFieldLabel,
  apiKeyFieldPlaceholder,
  captureFolderLabel,
  errorMessage,
  formStateFromSettings,
  type FormState,
} from "../lib/settingsForm";
import {
  clearApiKey,
  persistNotificationHint,
  reconcileInitialNotificationState,
  saveSettingsWithKeys,
  toggleNotification,
} from "../lib/settingsPersistence";
import { migratePreVaultNotes } from "../lib/vaultMigration";
import { PromptOverridesSection } from "../components/PromptOverridesSection";
import { DiagnosticsSection } from "../components/DiagnosticsSection";
import { SettingsTransferSection } from "../components/SettingsTransferSection";
import { LlmProviderSection } from "../components/LlmProviderSection";
import { caretProps, spacing, useCarnetTheme } from "../lib/theme";
import {
  useThemePreference,
  type ThemePreference,
} from "../lib/themePreference";
import * as captureNotification from "../lib/captureNotification";
import { VoiceSetupCheck } from "../voice/VoiceSetupCheck";

export default function SettingsScreen() {
  const theme = useCarnetTheme();
  const themePreference = useThemePreference();
  const [form, setForm] = useState<FormState | null>(null);
  /** Karakeep key state — the key is never read into render state; we only
   * track whether one is configured and any newly-typed replacement. LLM
   * provider keys are NOT tracked here — LlmProviderSection owns its own key
   * state end-to-end via providerKeys.ts. */
  const [karakeepKeyConfigured, setKarakeepKeyConfigured] =
    useState<boolean>(false);
  const [pendingKarakeepKey, setPendingKarakeepKey] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [showBanner, setShowBanner] = useState(false);
  /** Surfaced via Snackbar when the SAF folder picker fails, or when
   * LlmProviderSection reports a failed IO operation. Previous behavior
   * wrote "error: ..." into the path field, which then got persisted on
   * Save as a broken capture folder. */
  const [pickerError, setPickerError] = useState<string | null>(null);
  /** Snackbar text for the pre-vault migration sweep (see vaultMigration.ts) —
   * separate from `pickerError` so a migration outcome (success or partial
   * failure) never gets mistaken for a picker error, and separate from
   * `saved` so it can outlive that Snackbar's shorter duration. */
  const [migrationMessage, setMigrationMessage] = useState<string | null>(
    null,
  );

  useEffect(() => {
    void (async () => {
      const [s, hasKkKey, banner] = await Promise.all([
        getSettings(),
        hasKarakeepApiKey(),
        shouldShowMigrationBanner(),
      ]);
      // Source-of-truth for the notification toggle is native
      // SharedPreferences (BootReceiver reads it) — reconcileInitialNotificationState
      // decides the value; force-stop happens here if it says the invisible-
      // notification case (native ON, permission revoked) applies.
      let initialNotificationEnabled = s.persistentNotificationEnabled;
      const nativeAvailable = captureNotification.isAvailable();
      if (nativeAvailable) {
        try {
          const enabledNative = await captureNotification.isEnabled();
          const permissionGranted = enabledNative
            ? await captureNotification.permissionIsGranted()
            : false;
          const reconciled = reconcileInitialNotificationState({
            jsHint: initialNotificationEnabled,
            nativeAvailable,
            enabledNative,
            permissionGranted,
          });
          // Ordering is load-bearing: stop() first, THEN assign the
          // reconciled value. If stop() rejects, the catch below must keep
          // the JS-side hint (not silently adopt `reconciled.value`) —
          // otherwise the toggle would render OFF while the native service
          // is still running, with no UI path left to turn it off (ON would
          // just hit the same denied permission again).
          if (reconciled.shouldStopNative) {
            await captureNotification.stop();
          }
          initialNotificationEnabled = reconciled.value;
        } catch {
          // Native module read failed — keep the JS-side value as the hint.
        }
      }
      setForm(formStateFromSettings(s, initialNotificationEnabled));
      setKarakeepKeyConfigured(hasKkKey);
      setShowBanner(banner);
    })();
  }, []);

  if (!form) {
    return (
      <View style={styles.loading}>
        <Text>Loading…</Text>
      </View>
    );
  }

  const update = (patch: Partial<FormState>) => {
    setForm({ ...form, ...patch });
  };

  // API keys are intentionally NOT in form state — saveSettingsWithKeys
  // threads the currently-stored keys through so saveSettings doesn't wipe
  // them, then writes any newly-typed key. See settingsPersistence.ts for
  // the guarded-end-to-end rationale (this is the ONLY way to enter config
  // in a no-.env app).
  const save = async () => {
    const result = await saveSettingsWithKeys(
      form,
      { karakeep: pendingKarakeepKey },
      { getSettings, saveSettings, setKarakeepApiKey },
    );
    // Apply keysWritten BEFORE checking `ok` — key writes are sequential, so
    // a later one can reject after earlier ones already succeeded. Skipping
    // this on failure would leave an actually-stored key showing as
    // unconfigured with its typed value stuck in the field.
    if (result.keysWritten.karakeep) {
      setPendingKarakeepKey("");
      setKarakeepKeyConfigured(true);
    }
    if (!result.ok) {
      setPickerError(result.error);
      return;
    }
    setSaved(true);

    // Pre-vault migration (#172): sweeps on EVERY save that leaves a real
    // vault folder configured, not just the first — migratePreVaultNotes is
    // cheap and self-guarding when there's nothing to do (empty internal
    // root, or source === target when no folder is configured), so this is
    // also the retry path for a note a PRIOR sweep failed to move (a
    // transient read error, a revoked SAF grant that's since been re-granted,
    // etc.) — those notes must not stay invisible forever just because the
    // first attempt already ran once.
    const nextPath = form.captureFolderPath.trim();
    if (nextPath) {
      void (async () => {
        try {
          const migration = await migratePreVaultNotes();
          if (migration.migrated > 0 || migration.failed > 0) {
            const parts: string[] = [];
            if (migration.migrated > 0) {
              parts.push(
                `Moved ${migration.migrated} earlier capture${migration.migrated === 1 ? "" : "s"} into your vault`,
              );
            }
            if (migration.failed > 0) {
              parts.push(
                `${migration.failed} couldn't be moved and stayed on-device`,
              );
            }
            setMigrationMessage(parts.join(" — "));
          }
        } catch (e: unknown) {
          setMigrationMessage(
            errorMessage(e, "Couldn't check for earlier captures to migrate"),
          );
        }
      })();
    }
  };

  // Clear flips UI state only AFTER the keychain write confirms — a reject
  // must not show "cleared" while the key is still stored.
  const clearKarakeepKey = async () => {
    const result = await clearApiKey(setKarakeepApiKey);
    if (result.ok) {
      setKarakeepKeyConfigured(false);
      setPendingKarakeepKey("");
    } else {
      setPickerError(result.error);
    }
  };

  /** Reload the visible form after a confirmed settings-file import. Keys stay
   * outside this form and are intentionally preserved by the import path. */
  const reloadImportedSettings = async () => {
    const settings = await getSettings();
    setForm(formStateFromSettings(settings, settings.persistentNotificationEnabled));
  };

  /**
   * Atomic toggle for the persistent capture notification. Turning ON
   * requires POST_NOTIFICATIONS grant — if denied, the toggle stays off
   * and the user sees a snackbar. Turning OFF stops the service
   * immediately. Form state is updated only after the native call
   * succeeds so the UI never lies about what's actually running.
   */
  const handleToggleNotification = async (next: boolean) => {
    if (!form) return;
    const result = await toggleNotification(next, captureNotification);
    if (!result.ok) {
      setPickerError(result.error);
      return;
    }
    setForm({ ...form, persistentNotificationEnabled: next });
    await persistNotificationHint(next, { getSettings, savePersistedOnly });
  };

  const handleDismissBanner = async () => {
    await dismissMigrationBanner();
    setShowBanner(false);
  };

  /**
   * Open Android's Storage Access Framework folder picker. Returns a
   * `content://...tree/...` URI the OS has granted persistent permission
   * to. Typically the user picks their Syncthing-watched folder so
   * captures land where the workstation can see them.
   *
   * iOS has no SAF equivalent; the text field is the only path there.
   * Carnet is Android-first per the README.
   */
  const pickCaptureFolder = async () => {
    if (!form) return;
    if (Platform.OS !== "android") return;
    try {
      const res = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (res.granted && res.directoryUri) {
        setForm({ ...form, captureFolderPath: res.directoryUri });
      }
    } catch (e: unknown) {
      // Surface via Snackbar — do NOT write the error into the path field
      // (that would persist a broken capture folder on the next Save).
      setPickerError(errorMessage(e, "Folder picker failed"));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Banner
        visible={showBanner}
        actions={[
          {
            label: "OK, got it",
            onPress: handleDismissBanner,
          },
        ]}
        icon="information"
      >
        navetted has been replaced by OmniRoute. Configure your OmniRoute key
        below to continue capturing.
      </Banner>

      {/* Appearance — light/dark follows the OS unless pinned here. Applies
          instantly (no Save tap); persisted via themePreference, not the
          settings blob, so App.tsx can read it at cold start. */}
      <Text variant="titleMedium">Appearance</Text>
      <SegmentedButtons
        value={themePreference.preference}
        onValueChange={(v) =>
          themePreference.setPreference(v as ThemePreference)
        }
        buttons={[
          { value: "system", label: "System", icon: "theme-light-dark" },
          { value: "light", label: "Light", icon: "white-balance-sunny" },
          { value: "dark", label: "Dark", icon: "weather-night" },
        ]}
        style={{ marginBottom: spacing.sm }}
      />

      <LlmProviderSection theme={theme} onError={setPickerError} />

      <Text variant="titleMedium" style={styles.sectionTitle}>
        Storage
      </Text>
      <HelperText type="info" visible>
        Where notes are saved — point this at your Syncthing-watched vault
        folder so captures sync to your workstation.
      </HelperText>
      <TextInput
        {...caretProps(theme)}
        label="Capture folder"
        mode="outlined"
        autoCapitalize="none"
        autoCorrect={false}
        value={captureFolderLabel(form.captureFolderPath)}
        onChangeText={(v) => update({ captureFolderPath: v })}
        placeholder="(app sandbox folder by default)"
      />
      <HelperText type="info" visible>
        Tap Pick folder to choose through the Android system picker — that
        grants Carnet access to the folder, and is the reliable way to use
        shared storage (e.g. a Syncthing folder). A typed path only works
        where the app can already read, which on current Android it usually
        can&apos;t. Carnet creates Ideas/, Journal/, Notes/, People/, Photos/
        directly inside the chosen folder — pick the folder you want those to
        live in, not the parent.
      </HelperText>
      <View style={styles.folderRow}>
        <Button
          mode="text"
          icon="folder-open"
          compact
          onPress={pickCaptureFolder}
          style={styles.folderBtn}
        >
          Pick folder
        </Button>
        {form.captureFolderPath.length > 0 && (
          <Button
            mode="text"
            compact
            onPress={() => update({ captureFolderPath: "" })}
            style={styles.folderBtn}
          >
            Reset to default
          </Button>
        )}
      </View>

      <View style={styles.notificationSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          Karakeep
        </Text>
        <HelperText type="info" visible>
          Export notes to a self-hosted Karakeep instance. Leave the URL blank
          to hide the "Send to Karakeep" action.
        </HelperText>
        <TextInput
          {...caretProps(theme)}
          label="Karakeep URL"
          mode="outlined"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={form.karakeepUrl}
          onChangeText={(v) => update({ karakeepUrl: v })}
        />
        <HelperText type="info" visible>
          Karakeep base URL — must start with https:// (e.g.
          https://karakeep.example.com). The /api/v1 path is added automatically.
        </HelperText>

        <TextInput
          {...caretProps(theme)}
          label={apiKeyFieldLabel(
            "Karakeep API key",
            karakeepKeyConfigured,
            pendingKarakeepKey.length,
          )}
          mode="outlined"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={apiKeyFieldPlaceholder(
            karakeepKeyConfigured,
            "Generate in Karakeep → User Settings → API Keys",
          )}
          value={pendingKarakeepKey}
          onChangeText={setPendingKarakeepKey}
        />
        <HelperText type="info" visible>
          Stored in the secure keychain. The existing key is never shown again.
        </HelperText>
        {karakeepKeyConfigured && (
          <Button
            mode="text"
            compact
            onPress={clearKarakeepKey}
            style={styles.clearKey}
          >
            Clear key
          </Button>
        )}
      </View>

      <View style={styles.notificationSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          AI behavior
        </Text>
        <List.Item
          title="Auto-transcribe audio on save"
          description={
            form.autoTranscribeOnSave
              ? "Every audio capture is transcribed on-device automatically"
              : "Off — tap Transcribe per note instead"
          }
          left={(p) => <List.Icon {...p} icon="text-recognition" />}
          right={() => (
            <Switch
              value={form.autoTranscribeOnSave}
              onValueChange={(next) =>
                update({ autoTranscribeOnSave: next })
              }
            />
          )}
          style={styles.notificationRow}
        />
        <HelperText type="info" visible>
          Doubles your active provider's API spend per audio capture. Skip if you only
          transcribe occasionally.
        </HelperText>
        <List.Item
          title="Preview ideas before saving"
          description={
            form.previewBeforeSave
              ? "Idea captures wait for enrichment, then you review + Save"
              : "Off — ideas save instantly and enrich in the background"
          }
          left={(p) => <List.Icon {...p} icon="eye-check" />}
          right={() => (
            <Switch
              value={form.previewBeforeSave}
              onValueChange={(next) => update({ previewBeforeSave: next })}
            />
          )}
          style={styles.notificationRow}
        />
        <HelperText type="info" visible>
          Default off: an idea is written to your vault the moment you tap Save,
          and the AI structures it afterwards. Turn on to vet the AI's version
          before it lands. Contacts always preview regardless of this setting.
        </HelperText>
      </View>

      <View style={styles.notificationSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          Voice input
        </Text>
        <HelperText type="info" visible>
          On-device dictation needs Google's English voice model. Check whether
          it's installed and pull it from inside the app — no Play Store trip.
        </HelperText>
        <VoiceSetupCheck />
      </View>

      <View style={styles.notificationSection}>
        <Text variant="titleMedium" style={styles.promptSectionTitle}>
          Capture surfaces
        </Text>
        <List.Item
          title="Persistent capture notification"
          description={
            form.persistentNotificationEnabled
              ? "Always-on quick-capture row in the notification shade"
              : "Off — turn on for one-tap capture from anywhere"
          }
          left={(p) => <List.Icon {...p} icon="bell-ring-outline" />}
          right={() => (
            <Switch
              value={form.persistentNotificationEnabled}
              onValueChange={handleToggleNotification}
              disabled={!captureNotification.isAvailable()}
            />
          )}
          style={styles.notificationRow}
        />
        {!captureNotification.isAvailable() ? (
          <HelperText type="info" visible>
            Requires a native build — rebuild via `npm run android` to enable.
          </HelperText>
        ) : null}
      </View>

      <PromptOverridesSection
        overrides={form.promptOverrides}
        onChange={(next) => update({ promptOverrides: next })}
      />

      <SettingsTransferSection
        onImported={reloadImportedSettings}
        onError={setPickerError}
      />

      <DiagnosticsSection />

      <Button mode="contained" onPress={save} style={styles.save}>
        Save
      </Button>

      <Snackbar
        visible={saved}
        onDismiss={() => setSaved(false)}
        duration={2500}
      >
        Settings saved
      </Snackbar>

      <Snackbar
        visible={pickerError !== null}
        onDismiss={() => setPickerError(null)}
        duration={5000}
      >
        {pickerError ?? ""}
      </Snackbar>

      <Snackbar
        visible={migrationMessage !== null}
        onDismiss={() => setMigrationMessage(null)}
        duration={6000}
      >
        {migrationMessage ?? ""}
      </Snackbar>

    </ScrollView>
  );
}


const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 4 },
  save: { marginTop: 12 },
  clearKey: { alignSelf: "flex-start", marginTop: 4 },
  folderRow: { flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" },
  folderBtn: { alignSelf: "flex-start" },
  notificationSection: { marginTop: 16 },
  notificationRow: { paddingHorizontal: 0 },
  sectionTitle: { paddingHorizontal: 0, paddingTop: 16 },
  promptSectionTitle: { paddingHorizontal: 0, paddingTop: 8 },
});
