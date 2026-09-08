import { useState } from "react";
import { Button, Checkbox, Dialog, Text } from "react-native-paper";

import type { CarnetTheme } from "../lib/theme";

interface AskExplainerDialogProps {
  theme: CarnetTheme;
  visible: boolean;
  onCancel: () => void;
  /** `dontShowAgain` reflects the checkbox at the moment Continue was
   * pressed — the caller persists it (askExplainer.ts's
   * markAskExplainerSeen), this component only reads the box. */
  onContinue: (dontShowAgain: boolean) => void;
}

/**
 * One-time disclosure shown before the first Ask call reaches a remote
 * provider: unlike every other LLM call in this app (one note the user just
 * chose to send), Ask sends a bundle of past notes — some never chosen for
 * enrichment. See lib/askExplainer.ts for the gating rule.
 *
 * Callers wrap this in their own <Portal>, matching ArchiveNoteDialog.
 */
export function AskExplainerDialog({
  theme,
  visible,
  onCancel,
  onContinue,
}: AskExplainerDialogProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  return (
    <Dialog visible={visible} onDismiss={onCancel}>
      <Dialog.Title>Sending notes to your provider</Dialog.Title>
      <Dialog.Content style={{ gap: theme.carnet.spacing.md }}>
        <Text variant="bodyMedium">
          Answering this question sends the text of the selected notes to your
          configured provider — including notes you never chose to enrich or
          share before now.
        </Text>
        <Checkbox.Item
          label="Don't show again"
          status={dontShowAgain ? "checked" : "unchecked"}
          onPress={() => setDontShowAgain((v) => !v)}
          style={{ paddingHorizontal: 0 }}
        />
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={onCancel}>Cancel</Button>
        <Button onPress={() => onContinue(dontShowAgain)}>Continue</Button>
      </Dialog.Actions>
    </Dialog>
  );
}
