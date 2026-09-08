/**
 * Vault search — the browse-mode omnibox. One pill searchbar over the note
 * index (title → tags → excerpt, prefix ahead of substring, newest-first on
 * ties). Filters (mode + top tags) live behind the bar's filter icon and
 * collapse after use — never permanently docked; active filters render as
 * dismissible stamps under the bar. An empty query browses the whole vault
 * newest-first. Results are NoteCards — the same visual grammar as Home.
 * The index is read cache-first (instant); pull-to-refresh forces a rebuild.
 * Tapping a result resolves the note into a CaptureEntry and opens
 * RecentDetail.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Button, Portal, Searchbar, Snackbar, Text } from "react-native-paper";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import type { CaptureMode } from "../lib/storage";
import {
  getNoteIndex,
  refreshNoteIndex,
  resolveNoteEntry,
  searchNoteBodies,
  searchNotes,
  type BodyMatch,
  type NoteIndex,
  type NoteIndexEntry,
} from "../lib/vault";
import { MAX_NOTES, type RetrievalCandidate } from "../lib/retrospective";
import { markAskExplainerSeen, shouldShowAskExplainer } from "../lib/askExplainer";
import { MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";
import { NoteCard, modeStamp } from "../components/NoteCard";
import { StampChip } from "../components/StampChip";
import { AskExplainerDialog } from "../components/AskExplainerDialog";

type Props = NativeStackScreenProps<RootStackParamList, "Search">;

/** Modes that can appear in the note index (one per note subdir). */
const MODE_FILTERS: readonly CaptureMode[] = ["idea", "journal", "person"];

/** Max tag pills offered in the expanded filter row — the most-used tags
 * carry most taps; everything else is reachable by typing. */
const MAX_TAG_PILLS = 6;

/** Max body-search matches rendered as NoteCards in the footer — a common
 * term across a vault of hundreds/thousands of notes could otherwise stream
 * hundreds of non-virtualized cards into a plain View, which is a real jank
 * risk on Android hardware. The "Scanning… N of M" / "Scanned M notes"
 * progress lines still reflect the true total; only the rendered list caps. */
const MAX_RENDERED_MATCHES = 50;

export default function SearchScreen({ route, navigation }: Props) {
  const theme = useCarnetTheme();
  const [index, setIndex] = useState<NoteIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<CaptureMode | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>(
    route.params?.tag ? [route.params.tag] : [],
  );
  // Filter pills are hidden until the user asks for them (goal 4: filters
  // collapse into pills only when tapped, never permanently docked).
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Phase 2: on-demand full-text body search, explicit-trigger only. Reset
  // (and cancel any in-flight scan) whenever the query changes — a query
  // edit implicitly invalidates whatever was being scanned for the old one.
  const [bodyMatches, setBodyMatches] = useState<BodyMatch[]>([]);
  const [bodyScan, setBodyScan] = useState<
    "idle" | "scanning" | "done" | "cancelled" | "error"
  >("idle");
  const [bodyScanProgress, setBodyScanProgress] = useState<{ scanned: number; total: number }>({
    scanned: 0,
    total: 0,
  });
  const bodyScanController = useRef<AbortController | null>(null);

  useEffect(() => {
    setBodyMatches([]);
    setBodyScan("idle");
    setBodyScanProgress({ scanned: 0, total: 0 });
    return () => {
      // Implicit cancel (query changed out from under a running scan): abort
      // AND null the ref. Aborting alone doesn't stop already-issued reads —
      // when they finish, their callbacks compare `bodyScanController.current
      // !== controller` to decide whether to act. If we left the ref pointing
      // at this same controller, that comparison would stay false forever
      // (controller !== controller is false) and stale results would still
      // land on the freshly-reset "idle" state for the new query. Nulling it
      // makes the guard fire for every subsequent callback from this scan,
      // even though no new scan has started yet.
      //
      // The explicit Cancel button (cancelBodySearch) deliberately does NOT
      // do this — it leaves the ref pointing at the same controller so its
      // own eventual `.then()` guard still passes and correctly transitions
      // to "cancelled" (so the user sees "Cancelled — N of M" after tapping
      // Cancel).
      bodyScanController.current?.abort();
      bodyScanController.current = null;
    };
  }, [query]);

  const startBodySearch = useCallback(() => {
    const controller = new AbortController();
    bodyScanController.current = controller;
    setBodyMatches([]);
    setBodyScan("scanning");
    setBodyScanProgress({ scanned: 0, total: 0 });
    void searchNoteBodies(
      query,
      (match) => {
        if (bodyScanController.current !== controller) return;
        setBodyMatches((prev) => [...prev, match]);
      },
      (progress) => {
        if (bodyScanController.current !== controller) return;
        setBodyScanProgress(progress);
      },
      controller.signal,
    )
      .then((finalProgress) => {
        if (bodyScanController.current !== controller) return;
        setBodyScanProgress(finalProgress);
        setBodyScan(controller.signal.aborted ? "cancelled" : "done");
      })
      .catch(() => {
        // listNoteFiles() (called at the top of searchNoteBodies, before its
        // internal per-note try/catch kicks in) can reject outright — e.g. a
        // SAF permission error. Without this, that's an unhandled rejection
        // AND bodyScan gets stuck on "scanning" forever with no way out
        // except editing the query. Same staleness guard as the other three
        // callback sites: a rejected OLD scan must not clobber a newer scan.
        if (bodyScanController.current !== controller) return;
        setBodyScan("error");
      });
  }, [query]);

  const cancelBodySearch = useCallback(() => {
    bodyScanController.current?.abort();
  }, []);

  // A tag tapped elsewhere (TagBrowser, note detail) navigates here with a
  // param — fold it into the active filters when it changes.
  useEffect(() => {
    const tag = route.params?.tag;
    if (!tag) return;
    setTagFilters((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
  }, [route.params?.tag]);

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
      // A failed rebuild previously just stopped the spinner and showed
      // stale results with no signal (and escaped as an unhandled rejection).
      const msg = e instanceof Error ? e.message : String(e);
      setRefreshError(`Refresh failed — showing cached results: ${msg}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Most-used tags for the expanded filter row, derived from the index.
  const topTags = useMemo<string[]>(() => {
    if (!index) return [];
    const counts = new Map<string, number>();
    for (const note of index.notes) {
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TAG_PILLS)
      .map(([tag]) => tag);
  }, [index]);

  const results = useMemo<NoteIndexEntry[]>(() => {
    if (!index) return [];
    const base = searchNotes(index, query, modeFilter ? { mode: modeFilter } : {});
    if (tagFilters.length === 0) return base;
    return base.filter((n) => tagFilters.every((t) => n.tags.includes(t)));
  }, [index, query, modeFilter, tagFilters]);

  const toggleTag = useCallback((tag: string) => {
    setTagFilters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }, []);

  const openNote = useCallback(
    async (uri: string) => {
      const entry = await resolveNoteEntry(uri);
      if (entry) navigation.navigate("RecentDetail", { entry });
    },
    [navigation],
  );

  const hasActiveFilters = modeFilter !== null || tagFilters.length > 0;

  const noteForUri = useCallback(
    (uri: string) => index?.notes.find((n) => n.uri === uri),
    [index],
  );

  // Retrospective query entry point (Task 8). Body matches outrank indexed
  // results here too — orderCandidates (lib/retrospective.ts) is what
  // actually enforces that plus dedup once AskScreen receives this list;
  // this union invents no ranking of its own. `noteForUri` covers the case
  // a body match's own metadata carries no title (BodyMatch is uri+snippet
  // only).
  const candidates = useMemo<RetrievalCandidate[]>(() => {
    const fromBody = bodyMatches.map((m) => ({
      uri: m.uri,
      title: noteForUri(m.uri)?.title ?? m.uri,
      fromBodyMatch: true,
    }));
    const fromIndex = results.map((r) => ({
      uri: r.uri,
      title: r.title,
      fromBodyMatch: false,
    }));
    return [...fromBody, ...fromIndex];
  }, [bodyMatches, results, noteForUri]);

  // The label's number is what AskScreen will actually READ (capped at
  // MAX_NOTES), not how many are on screen — see this task's brief for why
  // those two counts are deliberately different and both required.
  const askCount = Math.min(candidates.length, MAX_NOTES);
  const showAskButton = query.trim().length > 0 && candidates.length > 0;

  // Holds the question/candidates chosen at press time, across the async
  // explainer check and (if shown) the dialog round-trip. A ref, not state:
  // nothing here needs to trigger a re-render while it's pending.
  const pendingAskRef = useRef<{ question: string; candidates: RetrievalCandidate[] } | null>(
    null,
  );
  const [explainerVisible, setExplainerVisible] = useState(false);
  // Mirrors refreshError below (Snackbar). A rejection here must not read as
  // "nothing happened" — see handleAskPress.
  const [askError, setAskError] = useState<string | null>(null);

  const handleAskPress = useCallback(async () => {
    const params = { question: query, candidates };
    let showExplainer: boolean;
    try {
      showExplainer = await shouldShowAskExplainer();
    } catch (e: unknown) {
      // AsyncStorage/settings read failed — we genuinely don't know whether
      // the user has already dismissed the explainer. FAIL TOWARD SHOWING
      // IT: a repeated disclosure is a minor annoyance; silently skipping a
      // privacy notice because a read failed is not an acceptable trade.
      // Same discipline as startBodySearch's .catch() above — surface the
      // failure rather than let `void handleAskPress()` at the call site
      // swallow it into "tapped Ask, nothing happened".
      const msg = e instanceof Error ? e.message : String(e);
      setAskError(`Couldn't check your Ask settings — showing the notice to be safe: ${msg}`);
      showExplainer = true;
    }
    if (showExplainer) {
      pendingAskRef.current = params;
      setExplainerVisible(true);
      return;
    }
    navigation.navigate("Ask", params);
  }, [query, candidates, navigation]);

  const handleExplainerCancel = useCallback(() => {
    pendingAskRef.current = null;
    setExplainerVisible(false);
  }, []);

  const handleExplainerContinue = useCallback(
    (dontShowAgain: boolean) => {
      setExplainerVisible(false);
      const params = pendingAskRef.current;
      pendingAskRef.current = null;
      if (dontShowAgain) {
        void markAskExplainerSeen();
      }
      if (params) navigation.navigate("Ask", params);
    },
    [navigation],
  );

  const bodySearchFooter = query.trim() ? (
    <View
      style={{
        gap: theme.carnet.spacing.md,
        paddingTop: theme.carnet.spacing.md,
        paddingHorizontal: theme.carnet.spacing.md,
        paddingBottom: theme.carnet.spacing.xl,
      }}
    >
      {bodyScan === "idle" && (
        <Pressable
          onPress={startBodySearch}
          style={styles.pillHit}
          accessibilityRole="button"
          accessibilityLabel="Search note contents"
        >
          <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
            Search note contents
          </Text>
        </Pressable>
      )}
      {bodyScan === "scanning" && (
        <View style={{ gap: theme.carnet.spacing.sm }}>
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {`Scanning… ${bodyScanProgress.scanned} of ${bodyScanProgress.total} notes`}
          </Text>
          <Pressable
            onPress={cancelBodySearch}
            style={styles.pillHit}
            accessibilityRole="button"
            accessibilityLabel="Cancel note content search"
          >
            <Text variant="labelLarge" style={{ color: theme.colors.error }}>
              Cancel
            </Text>
          </Pressable>
        </View>
      )}
      {(bodyScan === "done" || bodyScan === "cancelled") && (
        <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {bodyScan === "cancelled"
            ? `Cancelled — ${bodyScanProgress.scanned} of ${bodyScanProgress.total} notes scanned`
            : `Scanned ${bodyScanProgress.total} notes`}
        </Text>
      )}
      {bodyScan === "error" && (
        <View style={{ gap: theme.carnet.spacing.sm }}>
          <Text variant="labelMedium" style={{ color: theme.colors.error }}>
            Search failed — could not scan note contents.
          </Text>
          <Pressable
            onPress={startBodySearch}
            style={styles.pillHit}
            accessibilityRole="button"
            accessibilityLabel="Retry note content search"
          >
            <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
              Retry
            </Text>
          </Pressable>
        </View>
      )}
      {bodyMatches.slice(0, MAX_RENDERED_MATCHES).map((match) => {
        const meta = noteForUri(match.uri);
        return (
          <NoteCard
            key={match.uri}
            title={meta?.title ?? match.uri}
            mode={meta?.mode ?? "idea"}
            excerpt={match.snippet}
            tags={meta?.tags}
            onPress={() => void openNote(match.uri)}
          />
        );
      })}
      {bodyMatches.length > MAX_RENDERED_MATCHES && (
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {`+${bodyMatches.length - MAX_RENDERED_MATCHES} more matches — try a more specific search`}
        </Text>
      )}
    </View>
  ) : null;

  const renderItem = useCallback(
    ({ item }: { item: NoteIndexEntry }) => (
      <NoteCard
        title={item.title}
        mode={item.mode}
        createdAt={item.createdOrDate || undefined}
        excerpt={item.excerpt}
        tags={item.tags}
        pendingEnrich={item.status === "pending-enrich"}
        onPress={() => void openNote(item.uri)}
      />
    ),
    [openNote],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View
        style={[
          styles.header,
          { padding: theme.carnet.spacing.md, gap: theme.carnet.spacing.sm },
        ]}
      >
        <Searchbar
          placeholder="Search notes"
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          traileringIcon={filtersOpen ? "filter-variant-remove" : "filter-variant"}
          traileringIconAccessibilityLabel={
            filtersOpen ? "Hide filters" : "Show filters"
          }
          onTraileringIconPress={() => setFiltersOpen((v) => !v)}
          style={{ borderRadius: theme.carnet.radius.pill }}
        />

        {/* Expanded filter pills — visible only while the user is picking. */}
        {filtersOpen && (
          <View style={[styles.pillRow, { gap: theme.carnet.spacing.sm }]}>
            {MODE_FILTERS.map((mode) => {
              const { label, icon } = modeStamp(mode);
              const active = modeFilter === mode;
              return (
                <Pressable
                  key={mode}
                  style={styles.pillHit}
                  onPress={() => {
                    setModeFilter((prev) => (prev === mode ? null : mode));
                    setFiltersOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter by ${label}`}
                >
                  <StampChip label={label} icon={icon} tone={active ? "accent" : "neutral"} />
                </Pressable>
              );
            })}
            {topTags.map((tag) => {
              const active = tagFilters.includes(tag);
              return (
                <Pressable
                  key={tag}
                  style={styles.pillHit}
                  onPress={() => {
                    toggleTag(tag);
                    setFiltersOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter by tag ${tag}`}
                >
                  <StampChip label={`#${tag}`} tone={active ? "accent" : "neutral"} />
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Active filters — dismissible stamps, shown whenever set. */}
        {!filtersOpen && hasActiveFilters && (
          <View style={[styles.pillRow, { gap: theme.carnet.spacing.sm }]}>
            {modeFilter && (
              <Pressable
                style={styles.pillHit}
                onPress={() => setModeFilter(null)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${modeStamp(modeFilter).label} filter`}
              >
                <StampChip label={modeStamp(modeFilter).label} icon="close" />
              </Pressable>
            )}
            {tagFilters.map((tag) => (
              <Pressable
                key={tag}
                style={styles.pillHit}
                onPress={() => toggleTag(tag)}
                accessibilityRole="button"
                accessibilityLabel={`Remove tag filter ${tag}`}
              >
                <StampChip label={`#${tag}`} icon="close" />
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {loading ? (
        <View
          style={{ padding: theme.carnet.spacing.lg, gap: theme.carnet.spacing.md }}
        >
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={[
                styles.skeletonCard,
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
          data={results}
          keyExtractor={(item) => item.uri}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            results.length === 0 ? styles.center : null,
            {
              paddingHorizontal: theme.carnet.spacing.md,
              paddingBottom: theme.carnet.spacing.xl,
              gap: theme.carnet.spacing.md,
            },
          ]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListFooterComponent={bodySearchFooter}
          ListEmptyComponent={
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {query.trim() || hasActiveFilters
                ? "Nothing matches — try fewer filters or different words."
                : "No notes yet — capture something first."}
            </Text>
          }
        />
      )}

      {showAskButton && (
        <View
          style={[
            styles.askBar,
            { padding: theme.carnet.spacing.md, backgroundColor: theme.colors.background },
          ]}
        >
          <Button mode="contained-tonal" onPress={() => void handleAskPress()}>
            {`Ask about these ${askCount} notes`}
          </Button>
        </View>
      )}

      <Snackbar
        visible={refreshError !== null}
        onDismiss={() => setRefreshError(null)}
        duration={5000}
      >
        {refreshError ?? ""}
      </Snackbar>

      <Snackbar visible={askError !== null} onDismiss={() => setAskError(null)} duration={7000}>
        {askError ?? ""}
      </Snackbar>

      <Portal>
        <AskExplainerDialog
          theme={theme}
          visible={explainerVisible}
          onCancel={handleExplainerCancel}
          onContinue={handleExplainerContinue}
        />
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {},
  pillRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  // The stamp glyph is small by design; the touch target must not be
  // (DESIGN.md: 48dp minimum) — pad the Pressable, not the stamp.
  pillHit: { minHeight: MIN_TAP_TARGET, justifyContent: "center" },
  askBar: { minHeight: MIN_TAP_TARGET },
  skeletonCard: { height: 96 },
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
});
