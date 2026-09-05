/**
 * Vault-wide todo aggregation — every `- [ ]` / `- [x]` checklist line across
 * all notes, newest-note-first. Cache-first index load + pull-to-refresh
 * mirrors SearchScreen. Toggling a checkbox writes straight through to the
 * source note (updateChecklistItem, matched by text) with an optimistic
 * local flip that reverts on failure.
 */
import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Checkbox, SegmentedButtons, Snackbar, Text } from "react-native-paper";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import {
  getAllTodos,
  getNoteIndex,
  refreshNoteIndex,
  resolveNoteEntry,
  upsertNoteInIndex,
  type AggregatedTodo,
  type NoteIndex,
} from "../lib/vault";
import { readNote, updateChecklistItem } from "../lib/writer";
import { MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";

type Props = NativeStackScreenProps<RootStackParamList, "Todos">;

type TodoFilter = "open" | "all";

/** Return a NEW NoteIndex with the note's todo at `(uri, ordinal)` flipped to
 * `!checked` (its OWN current checked, not `todo.checked`) — never mutates
 * `index` or its arrays. `onToggle` calls this twice with the same pre-flip
 * `todo` closure (apply, then revert on failure): matching against the
 * line's live checked state — rather than requiring it to still equal
 * `todo.checked` — is what makes that second call actually undo the first,
 * instead of finding nothing to flip because the first call already changed
 * it. Matching by `ordinal` (this line's position within its OWN note, not by
 * `text`) means two checklist lines with identical text in one note no
 * longer both flip when only one was tapped — `ordinal` is a UI-local
 * targeting detail of the cached index and is never sent to
 * `updateChecklistItem`, which stays text-anchored for the actual write. */
function flipInIndex(index: NoteIndex, todo: AggregatedTodo): NoteIndex {
  return {
    ...index,
    notes: index.notes.map((note) => {
      if (note.uri !== todo.uri || !note.todos) return note;
      return {
        ...note,
        todos: note.todos.map((line, ordinal) =>
          ordinal === todo.ordinal ? { ...line, checked: !line.checked } : line,
        ),
      };
    }),
  };
}

export default function TodosScreen({ navigation }: Props) {
  const theme = useCarnetTheme();
  const [index, setIndex] = useState<NoteIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TodoFilter>("open");

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoading(true);
      void getNoteIndex()
        .then((next) => (active ? setIndex(next) : undefined))
        .finally(() => {
          if (active) setLoading(false);
        });
      return () => {
        active = false;
      };
    }, []),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      setIndex(await refreshNoteIndex());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setRefreshError(`Refresh failed — showing cached results: ${msg}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const todos = useMemo<AggregatedTodo[]>(() => {
    if (!index) return [];
    const all = getAllTodos(index);
    return filter === "open" ? all.filter((t) => !t.checked) : all;
  }, [index, filter]);

  const openNote = useCallback(
    async (uri: string) => {
      const entry = await resolveNoteEntry(uri);
      if (entry) navigation.navigate("RecentDetail", { entry });
    },
    [navigation],
  );

  const onToggle = useCallback(async (todo: AggregatedTodo) => {
    // Optimistic: flip immediately, revert on failure.
    setIndex((prev) => prev && flipInIndex(prev, todo));
    try {
      const result = await updateChecklistItem(todo.uri, todo.text, todo.checked);
      if (!result.ok) {
        setIndex((prev) => prev && flipInIndex(prev, todo)); // revert
        setToggleError(
          result.reason === "ambiguous"
            ? "Can't tell which item — edit the text in the note to make it unique."
            : "That item changed — pull to refresh and try again.",
        );
        return;
      }
    } catch (e: unknown) {
      setIndex((prev) => prev && flipInIndex(prev, todo)); // revert
      setToggleError(
        `Couldn't update that item: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    // Cache sync only — the write already succeeded, so a failure here must NOT revert.
    try {
      await upsertNoteInIndex(todo.uri, await readNote(todo.uri));
    } catch {
      // Stale cache self-corrects on the next pull-to-refresh.
    }
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: AggregatedTodo }) => (
      <View style={[styles.row, { gap: theme.carnet.spacing.sm }]}>
        <Checkbox.Android
          status={item.checked ? "checked" : "unchecked"}
          onPress={() => void onToggle(item)}
          accessibilityLabel={`${item.checked ? "Mark as not done" : "Mark as done"}: ${item.text}`}
        />
        <View style={styles.rowText}>
          <Text variant="bodyMedium">{item.text}</Text>
          <Pressable
            onPress={() => void openNote(item.uri)}
            style={styles.subtitleHit}
            accessibilityRole="button"
            accessibilityLabel={`Open note ${item.noteTitle}`}
          >
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {item.noteTitle}
            </Text>
          </Pressable>
        </View>
      </View>
    ),
    [onToggle, openNote, theme],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={{ padding: theme.carnet.spacing.md }}>
        <SegmentedButtons
          value={filter}
          onValueChange={(v) => setFilter(v as TodoFilter)}
          buttons={[
            { value: "open", label: "Open" },
            { value: "all", label: "All" },
          ]}
        />
      </View>

      {loading ? (
        <View
          style={{ padding: theme.carnet.spacing.lg, gap: theme.carnet.spacing.md }}
        >
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={[
                styles.skeletonRow,
                {
                  backgroundColor: theme.colors.surfaceVariant,
                  borderRadius: theme.carnet.radius.card,
                },
              ]}
            />
          ))}
        </View>
      ) : (
        <FlatList
          data={todos}
          keyExtractor={(item) => `${item.uri}#${item.ordinal}`}
          renderItem={renderItem}
          contentContainerStyle={[
            todos.length === 0 ? styles.center : null,
            {
              paddingHorizontal: theme.carnet.spacing.md,
              paddingBottom: theme.carnet.spacing.xl,
              gap: theme.carnet.spacing.sm,
            },
          ]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {filter === "open"
                ? "No open todos — nice work."
                : "No checklist items yet — add \"- [ ]\" in a note."}
            </Text>
          }
        />
      )}

      <Snackbar
        visible={refreshError !== null}
        onDismiss={() => setRefreshError(null)}
        duration={5000}
      >
        {refreshError ?? ""}
      </Snackbar>

      <Snackbar
        visible={toggleError !== null}
        onDismiss={() => setToggleError(null)}
        duration={5000}
      >
        {toggleError ?? ""}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center" },
  rowText: { flex: 1 },
  // DESIGN.md: 48dp minimum tap target for any interactive element.
  subtitleHit: { minHeight: MIN_TAP_TARGET, justifyContent: "center" },
  skeletonRow: { height: 56 },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
});
