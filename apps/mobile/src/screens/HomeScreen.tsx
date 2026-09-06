import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  Dialog,
  IconButton,
  Portal,
  Text,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import {
  getRecentCaptures,
  removeManyFromHistory,
  type CaptureEntry,
} from "../lib/storage";
import {
  listNoteFiles,
  listSyncConflictFiles,
  moveToArchive,
  type NoteFileRef,
} from "../lib/writer";
import { pairConflicts, type ConflictPair } from "../lib/syncConflicts";
import { reportColdStart } from "../lib/startupTiming";
import {
  loadCachedNoteIndex,
  refreshNoteIndex,
  resolveNoteEntry,
  type NoteIndex,
  type NoteIndexEntry,
} from "../lib/vault";
import { getSyncStatus, type SyncStatus } from "../lib/syncStatus";
import {
  drainQueue,
  listQueueRows,
  MAX_AUTO_RETRY_ATTEMPTS,
  type QueueRow,
} from "../lib/queue";
import {
  getPendingExportCount,
  subscribePendingSyncChanges,
} from "../lib/pendingSync";
import { drainPendingKarakeepExports } from "../lib/pendingSyncRunner";
import { formatRelative, modeStamp } from "../components/NoteCard";
import { useCarnetTheme } from "../lib/theme";
import { VoiceReadinessBanner } from "../voice/VoiceReadinessBanner";
import { CaptureFab, type CaptureTarget } from "../components/CaptureFab";
import { NoteCard } from "../components/NoteCard";
import { SyncStatusDot } from "../components/SyncStatusDot";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

/** Per-note metadata joined from the vault note index, keyed by note URI. */
type NoteMeta = Pick<NoteIndexEntry, "excerpt" | "tags" | "status">;

export default function HomeScreen({ navigation }: Props) {
  const theme = useCarnetTheme();
  // null = first load in flight → skeleton cards, not a spinner.
  const [recent, setRecent] = useState<CaptureEntry[] | null>(null);
  const [noteMeta, setNoteMeta] = useState<Map<string, NoteMeta>>(new Map());
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncDialogVisible, setSyncDialogVisible] = useState(false);
  const [syncRows, setSyncRows] = useState<QueueRow[]>([]);
  const [retrying, setRetrying] = useState(false);
  // Karakeep exports waiting on host reachability (lib/pendingSync.ts) —
  // drives the "waiting for Karakeep" banner and its Retry action.
  const [karakeepPending, setKarakeepPending] = useState(0);
  const [karakeepRetrying, setKarakeepRetrying] = useState(false);
  // Syncthing conflict copies found in the vault (lib/syncConflicts.ts) —
  // drives the "N sync conflicts — Review" banner + its review dialog. The
  // refs are cheap (directory listing only); pairing to originals happens
  // when the dialog opens.
  const [conflictFiles, setConflictFiles] = useState<NoteFileRef[]>([]);
  const [conflictDialogVisible, setConflictDialogVisible] = useState(false);
  const [conflictPairs, setConflictPairs] = useState<ConflictPair[]>([]);
  // Selection mode: enter via long-press, toggle rows via tap, auto-exit
  // when selection empties or the screen blurs.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmVisible, setConfirmVisible] = useState(false);
  // Guards against fast double-tap on the bulk-delete confirm so the
  // archive loop doesn't run twice.
  const bulkDeletingRef = useRef(false);
  // Single-flight guard for the background index rebuild below.
  const rebuildingIndexRef = useRef(false);

  const applyNoteIndex = useCallback((index: NoteIndex) => {
    const map = new Map<string, NoteMeta>();
    for (const note of index.notes) {
      map.set(note.uri, {
        excerpt: note.excerpt,
        tags: note.tags,
        status: note.status,
      });
    }
    setNoteMeta(map);
  }, []);

  const refresh = useCallback(async () => {
    const items = await getRecentCaptures();
    setRecent(items);
    // Join excerpts/tags/pending-status from the cached vault index. On a
    // cache miss (e.g. an offline drain invalidated it), render plain cards
    // now and rebuild the index in the background — never block Home on a
    // full vault scan.
    try {
      const index = await loadCachedNoteIndex();
      if (index) {
        applyNoteIndex(index);
      } else if (!rebuildingIndexRef.current) {
        rebuildingIndexRef.current = true;
        refreshNoteIndex()
          .then(applyNoteIndex)
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn("[Home] note index rebuild failed:", msg);
          })
          .finally(() => {
            rebuildingIndexRef.current = false;
          });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[Home] note index read failed:", msg);
    }
    try {
      setSyncStatus(await getSyncStatus());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[Home] sync status read failed:", msg);
    }
    try {
      setKarakeepPending(await getPendingExportCount());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[Home] pending-sync count read failed:", msg);
    }
    try {
      setConflictFiles(await listSyncConflictFiles());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[Home] sync-conflict scan failed:", msg);
    }
  }, [applyNoteIndex]);

  // Review dialog: pair each conflict copy to its canonical note on open (the
  // extra listNoteFiles enumeration is deferred to here — the banner itself
  // only needs the count).
  const openConflictReview = useCallback(async () => {
    setConflictDialogVisible(true);
    try {
      setConflictPairs(pairConflicts(conflictFiles, await listNoteFiles()));
    } catch {
      setConflictPairs(pairConflicts(conflictFiles, []));
    }
  }, [conflictFiles]);

  // Open a conflict copy or its original in RecentDetail — the user compares
  // there and archive-deletes the loser via the existing Delete flow. Resolve
  // FIRST and close the dialog only on success: if the note vanished between
  // scan and tap, the dialog stays up so the user can pick another row
  // instead of being dumped back to Home with nothing.
  const openConflictNote = useCallback(
    async (uri: string) => {
      const entry = await resolveNoteEntry(uri);
      if (!entry) return;
      setConflictDialogVisible(false);
      navigation.navigate("RecentDetail", { entry });
    },
    [navigation],
  );

  // Banner Retry: run a pending-export drain pass now (reachability probe
  // included — a tap while the VPN is still down is a fast no-op), then
  // re-derive the count.
  const retryKarakeepQueue = useCallback(async () => {
    if (karakeepRetrying) return;
    setKarakeepRetrying(true);
    try {
      await drainPendingKarakeepExports();
    } finally {
      setKarakeepRetrying(false);
      try {
        setKarakeepPending(await getPendingExportCount());
      } catch {
        // The banner keeps its previous count on a re-read failure.
      }
    }
  }, [karakeepRetrying]);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const enterSelection = useCallback((id: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Declared ABOVE the useLayoutEffect that closes over it — it's in that
  // effect's dependency array, and a below-declaration reference would be a
  // TDZ crash at render (the reason the dep was historically omitted).
  const openSyncDetail = useCallback(async () => {
    setSyncDialogVisible(true);
    try {
      setSyncRows(await listQueueRows());
    } catch {
      setSyncRows([]);
    }
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          {syncStatus ? (
            <SyncStatusDot
              status={syncStatus}
              onPress={() => void openSyncDetail()}
            />
          ) : null}
          <IconButton
            icon="magnify"
            onPress={() => navigation.navigate("Search")}
            accessibilityLabel="Search notes"
          />
          <IconButton
            icon="cog"
            onPress={() => navigation.navigate("Settings")}
            accessibilityLabel="Settings"
          />
        </View>
      ),
    });
  }, [navigation, syncStatus, openSyncDetail]);

  // Cold-start metric: Home's first mount is "the user can capture now".
  // reportColdStart latches once per process, so re-mounts are no-ops.
  useEffect(() => {
    reportColdStart();
  }, []);

  // Live pending-Karakeep count: the App.tsx foreground drain mutates the
  // queue while this screen is already focused, so focus-time reads alone
  // left the banner stale until the next refocus (known on-device gap).
  // Queue mutations ping this subscription; re-read the count in response.
  useEffect(() => {
    return subscribePendingSyncChanges(() => {
      getPendingExportCount()
        .then(setKarakeepPending)
        .catch(() => undefined);
    });
  }, []);

  // Auto-exit selection mode when the user deselects the last row.
  // Kept as an effect (rather than inside the updater above) so the side
  // effect doesn't fire twice in React 18+ StrictMode's double-invoke.
  useEffect(() => {
    if (selectionMode && selectedIds.size === 0) {
      setSelectionMode(false);
    }
  }, [selectionMode, selectedIds]);

  const handleBulkDelete = useCallback(async () => {
    if (bulkDeletingRef.current) return;
    bulkDeletingRef.current = true;
    setConfirmVisible(false);
    const ids = Array.from(selectedIds);
    const entries = (recent ?? []).filter((e) => selectedIds.has(e.id));
    try {
      // Best-effort per item — one SAF revocation shouldn't abort the rest.
      // The intent of bulk delete is "clean up as much as you can."
      const results = await Promise.allSettled(
        entries.map((e) => moveToArchive(e.filepath)),
      );
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.warn(`[Home] archive failed for ${entries[i].filepath}: ${reason}`);
        }
      });
      await removeManyFromHistory(ids);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[Home] bulk delete failed:", msg);
    } finally {
      bulkDeletingRef.current = false;
      exitSelection();
      refresh().catch((re: unknown) => {
        const reason = re instanceof Error ? re.message : String(re);
        console.warn("[Home] refresh after bulk delete failed:", reason);
      });
    }
  }, [selectedIds, recent, refresh, exitSelection]);

  useEffect(() => {
    const unsubFocus = navigation.addListener("focus", () => {
      void refresh();
    });
    // Clear any in-flight selection on screen blur so coming back doesn't
    // strand the user in an ambiguous mid-selection state.
    const unsubBlur = navigation.addListener("blur", () => {
      exitSelection();
    });
    void refresh();
    return () => {
      unsubFocus();
      unsubBlur();
    };
  }, [navigation, refresh, exitSelection]);

  // "Retry now" — run a drain pass immediately instead of waiting for the
  // next capture-screen open, then re-derive the indicator + row list.
  const retryQueue = useCallback(async () => {
    setRetrying(true);
    try {
      await drainQueue();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[Home] queue drain failed:", msg);
    } finally {
      setRetrying(false);
      try {
        setSyncRows(await listQueueRows());
        setSyncStatus(await getSyncStatus());
      } catch {
        // The dialog keeps its previous contents on a re-read failure.
      }
    }
  }, []);

  const onCapture = useCallback(
    (target: CaptureTarget) => {
      if (target.kind === "photo") navigation.navigate("PhotoCapture");
      else if (target.kind === "audio") navigation.navigate("AudioCapture");
      else navigation.navigate("Capture", { mode: target.mode });
    },
    [navigation],
  );

  const skeleton = recent === null;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <FlatList
        data={skeleton ? [] : recent}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.content,
          {
            padding: theme.carnet.spacing.lg,
            gap: theme.carnet.spacing.md,
            // Keep the last card clear of the FAB stack.
            paddingBottom: theme.carnet.spacing.xxxl * 2,
          },
        ]}
        ListHeaderComponent={
          <View style={{ gap: theme.carnet.spacing.md }}>
            <VoiceReadinessBanner />
            {karakeepPending > 0 ? (
              <Banner
                visible
                icon="cloud-upload-outline"
                style={{ borderRadius: theme.carnet.radius.md }}
                actions={[
                  {
                    label: karakeepRetrying ? "Retrying…" : "Retry",
                    onPress: () => void retryKarakeepQueue(),
                  },
                ]}
              >
                {`${karakeepPending} export${
                  karakeepPending === 1 ? "" : "s"
                } waiting for Karakeep — will send when the server is reachable`}
              </Banner>
            ) : null}
            {conflictFiles.length > 0 ? (
              <Banner
                visible
                icon="file-compare"
                style={{ borderRadius: theme.carnet.radius.md }}
                actions={[
                  {
                    label: "Review",
                    onPress: () => void openConflictReview(),
                  },
                ]}
              >
                {`${conflictFiles.length} sync conflict${
                  conflictFiles.length === 1 ? "" : "s"
                } in the vault — two versions of the same note exist`}
              </Banner>
            ) : null}
            {selectionMode ? (
              <View
                style={[
                  styles.selectionHeader,
                  {
                    backgroundColor: theme.colors.secondaryContainer,
                    borderRadius: theme.carnet.radius.md,
                  },
                ]}
              >
                <IconButton
                  icon="close"
                  onPress={exitSelection}
                  accessibilityLabel="Cancel selection"
                />
                <Text variant="titleMedium" style={styles.selectionTitle}>
                  {`${selectedIds.size} selected`}
                </Text>
                <IconButton
                  icon="delete"
                  iconColor={theme.colors.error}
                  onPress={() => setConfirmVisible(true)}
                  accessibilityLabel="Delete selected"
                />
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const meta = noteMeta.get(item.filepath);
          return (
            <NoteCard
              title={item.title}
              mode={item.mode}
              createdAt={item.createdAt}
              excerpt={meta?.excerpt}
              tags={meta?.tags}
              pendingEnrich={meta?.status === "pending-enrich"}
              selectionMode={selectionMode}
              selected={selectedIds.has(item.id)}
              onPress={() => {
                if (selectionMode) toggleSelection(item.id);
                else navigation.navigate("RecentDetail", { entry: item });
              }}
              onLongPress={() => enterSelection(item.id)}
            />
          );
        }}
        ListEmptyComponent={
          skeleton ? (
            <View style={{ gap: theme.carnet.spacing.md }}>
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
            <View style={[styles.empty, { gap: theme.carnet.spacing.sm }]}>
              <Text variant="titleMedium">Nothing captured yet</Text>
              <Text
                variant="bodyMedium"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                Tap Capture below to write your first note.
              </Text>
            </View>
          )
        }
      />

      <CaptureFab onCapture={onCapture} />

      <Portal>
        <Dialog
          visible={syncDialogVisible}
          onDismiss={() => setSyncDialogVisible(false)}
          style={{ borderRadius: theme.carnet.radius.sheet }}
        >
          <Dialog.Title>Sync</Dialog.Title>
          <Dialog.Content style={{ gap: theme.carnet.spacing.sm }}>
            <Text variant="bodyMedium">
              {syncStatus?.detail ?? ""}
            </Text>
            {syncRows.map((row) => (
              <View key={row.id} style={styles.syncRow}>
                <Text variant="bodySmall">
                  {`${modeStamp(row.mode).label} · ${formatRelative(row.created_at)}`}
                </Text>
                <Text
                  variant="labelSmall"
                  style={{
                    color:
                      row.attempts >= MAX_AUTO_RETRY_ATTEMPTS
                        ? theme.colors.error
                        : theme.colors.onSurfaceVariant,
                  }}
                >
                  {row.attempts >= MAX_AUTO_RETRY_ATTEMPTS
                    ? "needs attention"
                    : row.attempts > 0
                      ? `retried ${row.attempts}×`
                      : "waiting"}
                </Text>
              </View>
            ))}
          </Dialog.Content>
          <Dialog.Actions>
            {syncStatus && syncStatus.pending > 0 ? (
              <Button onPress={() => void retryQueue()} loading={retrying}>
                Retry now
              </Button>
            ) : null}
            {syncStatus?.state === "error" ? (
              <Button
                onPress={() => {
                  setSyncDialogVisible(false);
                  navigation.navigate("Settings");
                }}
              >
                Open Settings
              </Button>
            ) : null}
            <Button onPress={() => setSyncDialogVisible(false)}>Close</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog
          visible={conflictDialogVisible}
          onDismiss={() => setConflictDialogVisible(false)}
          style={{ borderRadius: theme.carnet.radius.sheet }}
        >
          <Dialog.Title>Sync conflicts</Dialog.Title>
          <Dialog.Content style={{ gap: theme.carnet.spacing.md }}>
            <Text variant="bodyMedium">
              Syncthing kept both versions of these notes after concurrent
              edits. Open each pair, keep the right one, and delete the other
              (Delete moves it to Archive).
            </Text>
            {conflictPairs.map((pair) => (
              <View key={pair.conflict.uri} style={{ gap: theme.carnet.spacing.xs }}>
                <Text variant="bodySmall" numberOfLines={1}>
                  {`${pair.conflict.subdir}/${pair.originalName}`}
                </Text>
                <View style={styles.conflictActions}>
                  <Button
                    compact
                    onPress={() => void openConflictNote(pair.conflict.uri)}
                  >
                    Open copy
                  </Button>
                  {pair.original ? (
                    <Button
                      compact
                      onPress={() => void openConflictNote(pair.original!.uri)}
                    >
                      Open original
                    </Button>
                  ) : (
                    <Text
                      variant="labelSmall"
                      style={{ color: theme.colors.onSurfaceVariant }}
                    >
                      original missing — the copy is the only version
                    </Text>
                  )}
                </View>
              </View>
            ))}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConflictDialogVisible(false)}>
              Close
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog
          visible={confirmVisible}
          onDismiss={() => setConfirmVisible(false)}
          style={{ borderRadius: theme.carnet.radius.sheet }}
        >
          <Dialog.Title>{`Move ${selectedIds.size} to Archive?`}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              The selected notes and any paired files will be moved to
              Archive/. You can recover them by browsing the vault in Obsidian.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmVisible(false)}>Cancel</Button>
            <Button onPress={handleBulkDelete} textColor={theme.colors.error}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1 },
  headerActions: { flexDirection: "row", alignItems: "center" },
  selectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 4,
    paddingRight: 8,
  },
  selectionTitle: { flex: 1, marginLeft: 4 },
  skeletonCard: { height: 96 },
  empty: { alignItems: "center", paddingVertical: 48 },
  syncRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  conflictActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
  },
});
