import { StyleSheet, View } from "react-native";
import { Card, Checkbox, Text } from "react-native-paper";

import type { CaptureMode } from "../lib/storage";
import { useCarnetTheme } from "../lib/theme";
import { StampChip } from "./StampChip";

/** Mode → stamp label/icon. Shared by Home cards and (later) browse surfaces. */
export function modeStamp(mode: CaptureMode): { label: string; icon: string } {
  switch (mode) {
    case "idea":
      return { label: "Idea", icon: "lightbulb-on-outline" };
    case "note":
      return { label: "Note", icon: "checkbox-marked-outline" };
    case "journal":
      return { label: "Journal", icon: "book-open-variant" };
    case "person":
      return { label: "Contact", icon: "account-outline" };
    case "photo":
      return { label: "Photo", icon: "camera-outline" };
    case "audio":
      return { label: "Audio", icon: "microphone-outline" };
  }
}

/** Compact relative timestamp for card footers ("now", "5m", "3h", "2d",
 * then a locale date). Keeps the footer to one quiet line. */
export function formatRelative(unixMs: number, now = Date.now()): string {
  const mins = Math.floor((now - unixMs) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(unixMs).toLocaleDateString();
}

interface NoteCardProps {
  /** Display fields — pass from a CaptureEntry (Home) or a NoteIndexEntry
   * (Search), so browse surfaces share one card without forcing per-row
   * entry resolution. */
  title: string;
  mode: CaptureMode;
  /** Epoch ms for the relative timestamp; omit (or 0) to hide it. */
  createdAt?: number;
  /** Body excerpt from the vault note index; empty/undefined hides the line. */
  excerpt?: string;
  /** Note tags from the vault note index (already normalized). */
  tags?: string[];
  /** True when the note is still awaiting enrichment (status: pending-enrich). */
  pendingEnrich?: boolean;
  selectionMode?: boolean;
  selected?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}

/** Max tag stamps per card — the footer stays one line; the rest collapse
 * into a "+n" stamp. */
const MAX_TAGS = 3;

/**
 * Browse-mode card for one capture: title, two-line excerpt, and a footer of
 * stamps (mode, tags, pending-sync) with a quiet relative timestamp. Dark-mode
 * elevation comes from the surface tone + 1px outline border, not shadow.
 */
export function NoteCard({
  title,
  mode,
  createdAt,
  excerpt,
  tags = [],
  pendingEnrich = false,
  selectionMode = false,
  selected = false,
  onPress,
  onLongPress,
}: NoteCardProps) {
  const theme = useCarnetTheme();
  const { label, icon } = modeStamp(mode);
  const shownTags = tags.slice(0, MAX_TAGS);
  const hiddenCount = tags.length - shownTags.length;

  return (
    <Card
      mode="outlined"
      onPress={onPress}
      onLongPress={onLongPress}
      style={[
        styles.card,
        {
          borderRadius: theme.carnet.radius.card,
          borderColor: selected ? theme.colors.primary : theme.colors.outline,
          backgroundColor: selected
            ? theme.colors.primaryContainer
            : theme.colors.surface,
        },
      ]}
      accessibilityLabel={`${label}: ${title}`}
    >
      <Card.Content style={{ gap: theme.carnet.spacing.sm }}>
        <View style={styles.titleRow}>
          {selectionMode ? (
            // Decorative-only — the card's onPress owns the toggle (same
            // bubbling rule as the old List.Item checkbox).
            <Checkbox.Android status={selected ? "checked" : "unchecked"} />
          ) : null}
          <Text variant="titleMedium" numberOfLines={2} style={styles.title}>
            {title}
          </Text>
          {createdAt ? (
            <Text
              variant="labelSmall"
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              {formatRelative(createdAt)}
            </Text>
          ) : null}
        </View>

        {excerpt ? (
          <Text
            variant="bodyMedium"
            numberOfLines={2}
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            {excerpt}
          </Text>
        ) : null}

        <View style={[styles.stampRow, { gap: theme.carnet.spacing.sm }]}>
          <StampChip label={label} icon={icon} />
          {shownTags.map((tag) => (
            <StampChip key={tag} label={`#${tag}`} />
          ))}
          {hiddenCount > 0 ? <StampChip label={`+${hiddenCount}`} /> : null}
          {pendingEnrich ? (
            <StampChip label="pending" icon="sync" tone="stamp" />
          ) : null}
        </View>
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1 },
  stampRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
});
