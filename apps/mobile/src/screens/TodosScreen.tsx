/**
 * Vault-wide todo aggregation — every `- [ ]` / `- [x]` checklist line across
 * all notes, newest-note-first. Cache-first index load + pull-to-refresh
 * mirrors SearchScreen. Toggling a checkbox writes straight through to the
 * source note (updateChecklistItem, matched by text) with an optimistic
 * local flip that reverts on failure.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, SectionList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Button, Checkbox, Snackbar, Text } from "react-native-paper";
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
import { refreshActiveVault } from "../lib/vaultRefreshService";
import { readNote, updateChecklistItem } from "../lib/writer";
import { MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";
import { getSettings } from "../lib/settings";
import { captureVaultContext } from "../lib/vaultContext";
import { resolveContextRoot } from "../lib/vaultRoot";

type Props = NativeStackScreenProps<RootStackParamList, "Todos">;

import { TodoViewControls } from "../components/TodoViewControls";
import { defaultTodoViewPreferences, normalizeTodoViewPreferences, selectTodos, getTodoFilterOptions, groupTodosBySource, type TodoViewPreferences } from "../lib/todoView";
import { getTodoViewPreferences, setTodoViewPreferences } from "../lib/todoViewPreferences";

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
 * `updateChecklistItem`, which stays text-anchored for the actual write.
 *
 * GUARD: before trusting `ordinal`, confirm the note's line AT that ordinal
 * still has `todo.text` — a pull-to-refresh landing between the apply and
 * revert calls (a real, if narrow, race: `onToggle` awaits the write, and a
 * concurrent `onRefresh` can swap in a freshly-rebuilt `index` mid-flight)
 * can re-extract the note with its checklist lines reordered, making the old
 * ordinal point at a DIFFERENT line. If the text no longer matches, leave
 * this note's todos untouched rather than flipping whatever is there now —
 * same anchor-by-content, refuse-on-mismatch stance `toggleChecklistLine`
 * takes for the actual disk write, just applied to the local cache. Nothing
 * here ever reaches disk either way; `getAllTodos` will show the true state
 * on the next index read. */
export function flipInIndex(index: NoteIndex, todo: AggregatedTodo): NoteIndex {
  return {
    ...index,
    notes: index.notes.map((note) => {
      if (note.uri !== todo.uri || !note.todos) return note;
      const target = note.todos[todo.ordinal];
      if (!target || target.text !== todo.text) return note;
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
  // Keep the exact index instance paired with its frozen vault context. A
  // stale row handler must never mutate an index replaced by another vault.
  const indexRef = useRef<NoteIndex | null>(null);
  const vaultContextRef = useRef<ReturnType<typeof captureVaultContext> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [view, setView] = useState(defaultTodoViewPreferences);
  const [hydrated, setHydrated] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const generationRef = useRef(0);
  const [renderedContext, setRenderedContext] = useState<ReturnType<typeof captureVaultContext> | null>(null);
  const viewRef = useRef(view);
  const saveRevisionRef = useRef(0);

  useFocusEffect(
    useCallback(() => {
      // A retry starts a new guarded load generation for the focused screen.
      void loadAttempt;
      const generation = ++generationRef.current;
      const current = () => generationRef.current === generation;
      vaultContextRef.current = null;
      indexRef.current = null;
      setRenderedContext(null);
      setIndex(null);
      const defaults = defaultTodoViewPreferences();
      setView(defaults);
      viewRef.current = defaults;
      setHydrated(false);
      setLoading(true);
      setRefreshing(false);
      setLoadError(null);
      setPreferenceError(null);
      setRefreshError(null);
      setToggleError(null);
      void (async () => {
        try {
          const context = captureVaultContext(await getSettings());
          if (!current()) return;
          vaultContextRef.current = context;
          setRenderedContext(context);
          const matches = () => current() && vaultContextRef.current === context;
          // Index and preferences are independent: a preference failure must
          // not hide the cache, and neither result may cross a focus boundary.
          await Promise.all([
            (async () => {
              try {
                const preferences = await getTodoViewPreferences(context);
                if (matches()) {
                  viewRef.current = preferences;
                  setView(preferences);
                  setHydrated(true);
                }
              } catch (error) {
                if (matches()) setPreferenceError(`Couldn't load view preferences: ${error instanceof Error ? error.message : String(error)}`);
              }
            })(),
            (async () => {
              try {
                const cached = await getNoteIndex(context.profileId, resolveContextRoot(context));
                if (!matches()) return;
                indexRef.current = cached;
                setIndex(cached);
                setLoading(false);
                const next = await refreshActiveVault(context);
                if (matches() && next) {
                  indexRef.current = next;
                  setIndex(next);
                }
              } catch (error) {
                if (matches()) setLoadError(`Couldn't load todos: ${error instanceof Error ? error.message : String(error)}`);
              } finally {
                if (matches()) setLoading(false);
              }
            })(),
          ]);
        } catch (error) {
          if (current()) {
            setLoadError(`Couldn't load todos: ${error instanceof Error ? error.message : String(error)}`);
            setLoading(false);
          }
        }
      })();
      return () => {
        ++generationRef.current;
        vaultContextRef.current = null;
        indexRef.current = null;
      };
    }, [loadAttempt]),
  );

  const saveView = useCallback((next: TodoViewPreferences) => {
    const context = renderedContext;
    if (!hydrated || !context || vaultContextRef.current !== context) return;
    next = normalizeTodoViewPreferences(next);
    const generation = generationRef.current;
    const revision = ++saveRevisionRef.current;
    setView(next);
    viewRef.current = next;
    setPreferenceError(null);
    void setTodoViewPreferences(context, next).catch((error: unknown) => {
      if (generationRef.current === generation && vaultContextRef.current === context && revision === saveRevisionRef.current) {
        setPreferenceError(`Couldn't save view preferences: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }, [hydrated, renderedContext]);

  const onRefresh = useCallback(async () => {
    const context = vaultContextRef.current;
    if (!context) return;
    const generation = generationRef.current;
    const matches = () => generationRef.current === generation && vaultContextRef.current === context;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const next = await refreshNoteIndex(context.profileId, resolveContextRoot(context));
      if (matches()) {
        indexRef.current = next;
        setIndex(next);
      }
    } catch (e: unknown) {
      if (matches()) setRefreshError(`Refresh failed — showing cached results: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (matches()) setRefreshing(false);
    }
  }, []);

  const todos = useMemo(() => index ? selectTodos(index, view) : [], [index, view]);
  const options = useMemo(() => index ? getTodoFilterOptions(index) : { modes: [], tags: [] }, [index]);
  const sections = useMemo(() => groupTodosBySource(todos), [todos]);
  const allTodos = useMemo(() => index ? getAllTodos(index) : [], [index]);
  const emptyMessage = allTodos.length === 0
    ? 'No checklist items yet — add "- [ ]" in a note.'
    : view.query.trim() ? "No todos match your search."
    : view.modes.length || view.tags.length ? "No todos match these filters."
    : view.status === "completed" ? "No completed todos yet."
    : "No open todos — nice work.";

  const openNote = useCallback(
    async (uri: string) => {
      // Pin navigation to the vault that supplied the tapped todo. Resolving
      // the entry can yield to SAF; a profile switch in that gap must not open
      // the old URI under the new vault's detail context.
      const context = vaultContextRef.current;
      if (!context) return;
      const entry = await resolveNoteEntry(uri);
      if (entry && vaultContextRef.current === context) navigation.navigate("RecentDetail", {
        entry,
        vaultContext: context,
      });
    },
    [navigation],
  );

  const onToggle = useCallback(async (todo: AggregatedTodo) => {
    // The note write and its cache repair are one logical operation. Capture
    // the profile before the first await so a profile switch cannot put this
    // note's fresh metadata into the newly active vault's cache.
    const context = vaultContextRef.current;
    const capturedIndex = indexRef.current;
    if (!context || !capturedIndex || capturedIndex !== index) {
      setToggleError("Tasks changed vaults — wait for the current vault to finish loading.");
      return;
    }
    const profileId = context.profileId;
    // Optimistic: flip immediately, revert on failure.
    setIndex((prev) => {
      if (prev !== capturedIndex || vaultContextRef.current !== context) return prev;
      const next = flipInIndex(prev, todo);
      indexRef.current = next;
      return next;
    });
    try {
      const result = await updateChecklistItem(todo.uri, todo.text, todo.checked);
      if (!result.ok) {
        setIndex((prev) => {
          if (!prev || vaultContextRef.current !== context) return prev;
          const next = flipInIndex(prev, todo);
          indexRef.current = next;
          return next;
        }); // revert
        setToggleError(
          result.reason === "ambiguous"
            ? "Can't tell which item — edit the text in the note to make it unique."
            : "That item changed — pull to refresh and try again.",
        );
        return;
      }
    } catch (e: unknown) {
      setIndex((prev) => {
        if (!prev || vaultContextRef.current !== context) return prev;
        const next = flipInIndex(prev, todo);
        indexRef.current = next;
        return next;
      }); // revert
      setToggleError(
        `Couldn't update that item: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    // Cache sync only — the write already succeeded, so a failure here must NOT revert.
    try {
      await upsertNoteInIndex(
        todo.uri,
        await readNote(todo.uri),
        profileId,
      );
    } catch (e: unknown) {
      // Stale cache self-corrects on the next pull-to-refresh. Warn (don't
      // revert, don't alert) — matches buildNoteIndex's own skip-and-warn
      // precedent (vault.ts) for a benign, expected-to-sometimes-fail path.
      console.warn("[TodosScreen] cache sync failed after a successful toggle:", e);
    }
  }, [index]);

  const renderItem = useCallback(
    ({ item }: { item: AggregatedTodo }) => (
      <View style={[styles.row, { gap: theme.carnet.spacing.sm }]}>
        <Pressable onPress={() => void onToggle(item)} accessibilityRole="checkbox"
          accessibilityState={{ checked: item.checked }}
          accessibilityLabel={`${item.checked ? "Mark as not done" : "Mark as done"}: ${item.text}`}
          style={{ minHeight: MIN_TAP_TARGET, minWidth: MIN_TAP_TARGET, justifyContent: "center", alignItems: "center" }}>
        <Checkbox.Android
          pointerEvents="none" accessible={false}
          status={item.checked ? "checked" : "unchecked"}
        />
        </Pressable>
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
      <TodoViewControls view={view} options={options} disabled={!hydrated} onChange={saveView} />
      {loadError && <View style={{ padding: theme.carnet.spacing.md }}>
        <Text style={{ color: theme.colors.error }}>{loadError}</Text>
        <Button onPress={() => setLoadAttempt((attempt) => attempt + 1)} contentStyle={{ minHeight: MIN_TAP_TARGET }}>Retry loading todos</Button>
      </View>}
      {preferenceError && <View style={{ padding: theme.carnet.spacing.md }}>
        <Text style={{ color: theme.colors.error }}>{preferenceError}</Text>
        <Button onPress={() => hydrated ? saveView(viewRef.current) : setLoadAttempt((attempt) => attempt + 1)}
          contentStyle={{ minHeight: MIN_TAP_TARGET }}>Retry view preferences</Button>
      </View>}

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
        view.groupBySource ? <SectionList
          sections={sections} keyExtractor={(item) => `${item.uri}#${item.ordinal}`}
          renderItem={renderItem} stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => <Pressable
            onPress={() => void openNote(section.uri)} accessibilityRole="button"
            accessibilityLabel={`Open source note ${section.title}, ${section.data.length} todos`}
            style={{ minHeight: MIN_TAP_TARGET, justifyContent: "center", backgroundColor: theme.colors.background }}>
            <Text variant="titleSmall">{section.title} ({section.data.length})</Text>
          </Pressable>}
          contentContainerStyle={{ paddingHorizontal: theme.carnet.spacing.md, paddingBottom: theme.carnet.spacing.xl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={<View><Text>{emptyMessage}</Text><Button disabled={!hydrated} onPress={() => saveView(defaultTodoViewPreferences())} contentStyle={{ minHeight: MIN_TAP_TARGET }}>Reset view</Button></View>}
        /> : <FlatList
          data={todos} keyExtractor={(item) => `${item.uri}#${item.ordinal}`}
          renderItem={renderItem}
          contentContainerStyle={[todos.length === 0 ? styles.center : null, {
            paddingHorizontal: theme.carnet.spacing.md, paddingBottom: theme.carnet.spacing.xl,
            gap: theme.carnet.spacing.sm,
          }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={<View>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>{emptyMessage}</Text>
            {allTodos.length > 0 && <Button disabled={!hydrated} onPress={() => saveView(defaultTodoViewPreferences())}
              contentStyle={{ minHeight: MIN_TAP_TARGET }}>Reset view</Button>}
          </View>}
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
