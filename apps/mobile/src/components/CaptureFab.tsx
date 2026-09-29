import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { FAB, IconButton, List, Modal, Portal, Text } from "react-native-paper";
import * as Haptics from "expo-haptics";

import { MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";

export type CaptureTarget =
  | { kind: "capture"; mode: "idea" | "note" | "journal" | "person" }
  | { kind: "photo" }
  | { kind: "audio" };

interface CaptureFabProps {
  /** Fired for every capture destination; the screen owns navigation. */
  onCapture: (target: CaptureTarget) => void;
}

const SHEET_ROWS: Array<{
  key: string;
  title: string;
  description: string;
  icon: string;
  target: CaptureTarget;
}> = [
  {
    key: "note",
    title: "Note",
    description: "A task list or working notes",
    icon: "checkbox-marked-outline",
    target: { kind: "capture", mode: "note" },
  },
  {
    key: "journal-today",
    title: "Continue today's journal",
    description: "Append to today's entry",
    icon: "book-open-variant",
    target: { kind: "capture", mode: "journal" },
  },
  {
    key: "person",
    title: "Contact",
    description: "Scan a card or dictate context",
    icon: "account-outline",
    target: { kind: "capture", mode: "person" },
  },
  {
    key: "photo",
    title: "Photo",
    description: "Camera or gallery into the vault",
    icon: "camera-outline",
    target: { kind: "photo" },
  },
  {
    key: "audio",
    title: "Audio",
    description: "Record, transcribe later",
    icon: "microphone-outline",
    target: { kind: "audio" },
  },
];

/**
 * The app's single elevated capture entry (goal: fastest path wins). Tap →
 * straight into an Idea capture. The other modes sit one tap deeper, behind
 * the chevron affordance above the FAB or a long-press on it, in a bottom
 * sheet — deliberately NOT five equal-weight buttons (see AUDIT.md §3.1).
 * Deep teal in both themes via `carnet.fill` (DESIGN.md).
 */
export function CaptureFab({ onCapture }: CaptureFabProps) {
  const theme = useCarnetTheme();
  const [sheetOpen, setSheetOpen] = useState(false);

  const openSheet = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
      // Haptics are best-effort — never block the sheet on a vibration error.
    });
    setSheetOpen(true);
  };

  const pick = (target: CaptureTarget) => {
    setSheetOpen(false);
    onCapture(target);
  };

  return (
    <>
      <View style={[styles.anchor, { gap: theme.carnet.spacing.sm }]}>
        <IconButton
          icon="chevron-up"
          mode="contained-tonal"
          size={MIN_TAP_TARGET / 2}
          onPress={openSheet}
          accessibilityLabel="More capture modes"
        />
        <FAB
          icon="pencil-plus"
          label="Capture"
          color={theme.carnet.onFill}
          style={{
            backgroundColor: theme.carnet.fill,
            borderRadius: theme.carnet.radius.pill,
          }}
          onPress={() => pick({ kind: "capture", mode: "idea" })}
          onLongPress={openSheet}
          accessibilityLabel="Capture an idea (long-press for more modes)"
        />
      </View>

      <Portal>
        <Modal
          visible={sheetOpen}
          onDismiss={() => setSheetOpen(false)}
          contentContainerStyle={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.outline,
              borderTopLeftRadius: theme.carnet.radius.sheet,
              borderTopRightRadius: theme.carnet.radius.sheet,
              paddingVertical: theme.carnet.spacing.md,
            },
          ]}
        >
          <Text
            variant="titleSmall"
            style={[
              styles.sheetTitle,
              {
                color: theme.colors.onSurfaceVariant,
                paddingHorizontal: theme.carnet.spacing.lg,
                paddingBottom: theme.carnet.spacing.sm,
              },
            ]}
          >
            Capture something else
          </Text>
          {SHEET_ROWS.map((row) => (
            <List.Item
              key={row.key}
              title={row.title}
              description={row.description}
              left={(p) => <List.Icon {...p} icon={row.icon} />}
              onPress={() => pick(row.target)}
              style={{ minHeight: MIN_TAP_TARGET }}
            />
          ))}
        </Modal>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: "absolute",
    right: 16,
    bottom: 24,
    alignItems: "center",
  },
  // Bottom-anchored sheet: Paper's Modal centers by default, so pin it to the
  // bottom edge and round only the top corners.
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
  },
  sheetTitle: { textTransform: "uppercase", letterSpacing: 1 },
});
