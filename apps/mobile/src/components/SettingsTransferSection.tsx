import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Dialog, HelperText, Portal, Text } from "react-native-paper";

import { getSettings, setKarakeepApiKey, type Settings } from "../lib/settings";
import {
  parseSettingsTransfer,
  reissueImportedCustomProviderIds,
} from "../lib/settingsTransfer";
import { deleteKey } from "../lib/providerKeys";
import { useThemePreference } from "../lib/themePreference";
import {
  pickSettingsTransfer,
  shareSettingsTransfer,
} from "../lib/settingsTransferFile";
import { spacing } from "../lib/theme";

interface SettingsTransferSectionProps {
  /** Owns the durable import transaction. SettingsScreen uses this boundary
   * to invalidate native Drive Inbox routing before a changed vault root can
   * become durable, then reloads/publishes the imported route on success. */
  onImportSettings: (current: Settings, imported: Settings) => Promise<void>;
  onError: (message: string) => void;
}

/** Import/export for portable, explicitly non-secret settings. */
export function SettingsTransferSection({
  onImportSettings,
  onError,
}: SettingsTransferSectionProps) {
  const [pendingImport, setPendingImport] = useState<ReturnType<
    typeof parseSettingsTransfer
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const themePreference = useThemePreference();

  const exportSettings = async () => {
    setBusy(true);
    try {
      await shareSettingsTransfer(await getSettings(), themePreference.preference);
    } catch (error: unknown) {
      onError(errorMessage(error, "Settings export failed."));
    } finally {
      setBusy(false);
    }
  };

  const chooseImport = async () => {
    setBusy(true);
    try {
      const raw = await pickSettingsTransfer();
      if (raw !== null) setPendingImport(parseSettingsTransfer(raw));
    } catch (error: unknown) {
      onError(errorMessage(error, "Settings import failed."));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!pendingImport) return;
    setBusy(true);
    try {
      const current = await getSettings();
      // Delete before saving imported endpoints. The inverse ordering could
      // briefly route an existing credential to an imported, untrusted URL.
      await Promise.all([
        ...current.llmProviders.map((provider) => deleteKey(provider.id)),
        setKarakeepApiKey(""),
      ]);
      await onImportSettings(current, {
        ...current,
        ...reissueImportedCustomProviderIds(pendingImport, current.nextCustomSeq),
      });
      themePreference.setPreference(pendingImport.themePreference);
      setPendingImport(null);
    } catch (error: unknown) {
      onError(errorMessage(error, "Settings import failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={styles.title}>
        Transfer settings
      </Text>
      <HelperText type="info" visible>
        Export appearance, providers, prompts, storage path, and capture preferences to a
        JSON file. API keys are never included. Import replaces these
        non-secret settings and clears this device’s API keys.
      </HelperText>
      <View style={styles.actions}>
        <Button mode="text" compact icon="export-variant" onPress={exportSettings} disabled={busy}>
          Export settings
        </Button>
        <Button mode="text" compact icon="import" onPress={chooseImport} disabled={busy}>
          Import settings
        </Button>
      </View>
      <Portal>
        <Dialog visible={pendingImport !== null} onDismiss={() => !busy && setPendingImport(null)}>
          <Dialog.Title>Replace settings?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              This replaces appearance, providers, prompts, storage path, and capture preferences. API keys on this device are cleared, so enter them again after import. You may need to pick the capture folder again if the export used Android’s folder picker.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPendingImport(null)} disabled={busy}>Cancel</Button>
            <Button onPress={confirmImport} loading={busy} disabled={busy}>Import</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.lg },
  title: { paddingHorizontal: 0, paddingTop: spacing.sm },
  actions: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
});
