/**
 * Tag browser. Two modes driven by the optional `tag` route param:
 *   - no tag  → the vault's tags with note counts; tapping one opens Search
 *               pre-filtered to that tag (the single browse surface)
 *   - a tag   → the notes carrying it; tap opens RecentDetail. Kept for
 *               existing deep links (e.g. from note detail), not reachable
 *               from the top-level tag list anymore.
 *
 * The index is read cache-first (instant); pull-to-refresh forces a rebuild so
 * tags added since the last scan show up.
 */
import { useCallback, useLayoutEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { ActivityIndicator, Divider, List, Snackbar, Text, useTheme } from "react-native-paper";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import type { CaptureEntry, CaptureMode } from "../lib/storage";
import { getTagIndex, notesForTag, refreshTagIndex, type TagIndexEntry } from "../lib/vault";
import { refreshActiveVault } from "../lib/vaultRefreshService";

type Props = NativeStackScreenProps<RootStackParamList, "TagBrowser">;

function modeLabel(mode: CaptureMode): string {
  if (mode === "journal") return "Journal";
  if (mode === "person") return "Contact";
  return "Idea";
}

function modeIcon(mode: CaptureMode): string {
  if (mode === "journal") return "notebook-outline";
  if (mode === "person") return "account-outline";
  return "lightbulb-outline";
}

export default function TagBrowserScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const tag = route.params?.tag;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [tagEntries, setTagEntries] = useState<TagIndexEntry[]>([]);
  const [notes, setNotes] = useState<CaptureEntry[]>([]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: tag ? `#${tag}` : "Tags" });
  }, [navigation, tag]);

  const apply = useCallback(
    async (index: Awaited<ReturnType<typeof getTagIndex>>) => {
      if (tag) setNotes(await notesForTag(index, tag));
      else setTagEntries(index.tags);
    },
    [tag],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoading(true);
      void getTagIndex()
        .then((index) => (active ? apply(index) : undefined))
        .finally(() => {
          if (active) setLoading(false);
        });
      void refreshActiveVault().catch(() => undefined);
      return () => {
        active = false;
      };
    }, [apply]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await apply(await refreshTagIndex());
    } catch (e: unknown) {
      // A failed rebuild previously just stopped the spinner and showed
      // stale tags with no signal (and escaped as an unhandled rejection).
      const msg = e instanceof Error ? e.message : String(e);
      setRefreshError(`Refresh failed — showing cached tags: ${msg}`);
    } finally {
      setRefreshing(false);
    }
  }, [apply]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const isEmpty = tag ? notes.length === 0 : tagEntries.length === 0;

  return (
    <ScrollView
      contentContainerStyle={isEmpty ? styles.center : styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {isEmpty && (
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {tag ? "No notes carry this tag." : "No tags yet — add tags when you capture."}
        </Text>
      )}

      {!tag &&
        tagEntries.map((entry, index) => (
          <View key={entry.tag}>
            {index > 0 && <Divider />}
            <List.Item
              title={`#${entry.tag}`}
              // Land in Search pre-filtered — one browse surface for
              // "notes carrying this tag" instead of a parallel list here.
              onPress={() => navigation.navigate("Search", { tag: entry.tag })}
              left={(props) => <List.Icon {...props} icon="tag-outline" />}
              right={() => (
                <Text variant="labelLarge" style={[styles.count, { color: theme.colors.primary }]}>
                  {entry.count}
                </Text>
              )}
            />
          </View>
        ))}

      {tag &&
        notes.map((entry, index) => (
          <View key={entry.id}>
            {index > 0 && <Divider />}
            <List.Item
              title={entry.title}
              description={modeLabel(entry.mode)}
              onPress={() => navigation.navigate("RecentDetail", { entry })}
              left={(props) => <List.Icon {...props} icon={modeIcon(entry.mode)} />}
            />
          </View>
        ))}

      <Snackbar
        visible={refreshError !== null}
        onDismiss={() => setRefreshError(null)}
        duration={5000}
      >
        {refreshError ?? ""}
      </Snackbar>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { paddingVertical: 8 },
  count: { alignSelf: "center", fontVariant: ["tabular-nums"] },
});
