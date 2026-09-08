/**
 * Detail / preview / edit / delete screen for one entry in the recents list.
 *
 * The screen itself is a composition layer: it owns the note's `body` (the
 * single source of truth every action reads and rewrites), the load/missing
 * state, and the navigation wiring. Everything decidable in isolation lives in
 * lib/ (recentDetailView, noteAttachments, noteRelated, karakeepExportUi,
 * markdownStyle, plus the useNoteDetailSettings / useNoteEditSession /
 * useKarakeepExport / useNoteAudioPlayer hooks), and each self-contained UI
 * block lives in components/.
 *
 * Frontmatter never round-trips through the editor: it is split off on enter
 * and reattached byte-exact on save — see lib/useNoteEditSession.ts.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Banner,
  FAB,
  IconButton,
  Portal,
  Text,
} from "react-native-paper";
import Markdown from "react-native-markdown-display";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { deriveTitle } from "@carnet/shared";

import type { RootStackParamList } from "../../App";
import {
  extractFrontmatterField,
  moveToArchive,
  readNote,
  stripFrontmatter,
  stripPairedBinaryLinks,
  updateNote,
} from "../lib/writer";
import { ArchiveNoteDialog } from "../components/ArchiveNoteDialog";
import { DiscardEditsDialog } from "../components/DiscardEditsDialog";
import { makeImageRule } from "../components/markdownImageRule";
import { NoteActionsSheet } from "../components/NoteActionsSheet";
import { PhotoAttachModal } from "../components/PhotoAttachModal";
import {
  NoteAttachmentsCard,
  type ResolvedAttachment,
} from "../components/NoteAttachmentsCard";
import { NoteAudioPlayerCard } from "../components/NoteAudioPlayerCard";
import { NoteDetailSkeleton } from "../components/NoteDetailSkeleton";
import { NoteFileInfoDialog } from "../components/NoteFileInfoDialog";
import { NoteMarkdownEditCard } from "../components/NoteMarkdownEditCard";
import { NoteMetaRow } from "../components/NoteMetaRow";
import { NoteMissingState } from "../components/NoteMissingState";
import { RelatedNotesCard } from "../components/RelatedNotesCard";
import { RecentDetailSnackbars } from "../components/RecentDetailSnackbars";
import { RichNoteEditor } from "../components/RichNoteEditor";
import { markdownStyle } from "../lib/markdownStyle";
import {
  imageUrisByRel,
  openAttachment,
  resolveNoteAttachments,
} from "../lib/noteAttachments";
import { computeRelatedNotes } from "../lib/noteRelated";
import {
  activeIssueMessage,
  busyLabel,
  formatDate,
  formatMode,
  isActionsBusy,
  noteCapabilities,
} from "../lib/recentDetailView";
import { insertRelatedLink } from "../lib/relatedNotes";
import { reEnrichNote, transcribeNote } from "../lib/noteReprocess";
import {
  finishPendingEnrichment,
  isPendingEnrich,
  isReEnrichableMode,
  reEnrichNoteInPlace,
} from "../lib/finishEnrichment";
import { enhanceNoteProse } from "../lib/enhanceProse";
import { attachPhotoToNote } from "../lib/attachPhotoToNote";
import { FALLBACK_PROVIDER_FIELD } from "../lib/dispatcher";
import { useCarnetTheme } from "../lib/theme";
import { useKarakeepExport } from "../lib/useKarakeepExport";
import { useNoteAudioPlayer } from "../lib/useNoteAudioPlayer";
import { useNoteEditSession } from "../lib/useNoteEditSession";
import {
  loadCachedNoteIndex,
  resolveNoteEntry,
  subdirForUri,
  tagsForNote,
  upsertNoteInIndex,
  type NoteIndexEntry,
} from "../lib/vault";
import {
  removeFromHistory,
  removeFromHistoryByFilepath,
  updateCaptureTitleByFilepath,
} from "../lib/storage";
import { useNoteDetailSettings } from "../lib/useNoteDetailSettings";

type Props = NativeStackScreenProps<RootStackParamList, "RecentDetail">;

export default function RecentDetailScreen({ route, navigation }: Props) {
  const theme = useCarnetTheme();
  const { entry } = route.params;

  const [body, setBody] = useState<string>("");
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmVisible, setConfirmVisible] = useState(false);
  // Secondary actions live in a bottom sheet behind the header overflow;
  // the raw file path lives in a "File info" dialog off that sheet. Edit is
  // the screen's single primary action (the FAB).
  const [actionsOpen, setActionsOpen] = useState(false);
  const [fileInfoOpen, setFileInfoOpen] = useState(false);
  const [reEnriching, setReEnriching] = useState(false);
  const [reEnrichError, setReEnrichError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const [enhancedWith, setEnhancedWith] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachingPhoto, setAttachingPhoto] = useState(false);
  const [attachPhotoError, setAttachPhotoError] = useState<string | null>(null);
  const [photoAttached, setPhotoAttached] = useState(false);
  const { karakeepConfigured, richEditorEnabled } = useNoteDetailSettings();
  // Guard against fast double-taps on Delete — the in-flight archive can
  // race with a second handler call and produce a confusing UI state.
  const deletingRef = useRef(false);
  // Same guard for the Re-enrich button — re-running the LLM call twice
  // would write the .md twice, with whichever finishes second winning.
  const reEnrichingRef = useRef(false);
  const transcribingRef = useRef(false);
  const enhancingRef = useRef(false);
  const attachingPhotoRef = useRef(false);
  // Mounted guard — Back-during-write can unmount before the in-flight
  // updateNote resolves; setState after that triggers a React warning. The
  // write itself still lands on disk.
  //
  // There are FOUR of these in play: this one plus one each inside
  // useNoteEditSession, useKarakeepExport and useNoteAudioPlayer. They are
  // interchangeable — all four flip false at the same instant — ONLY because
  // all four hooks are mounted by this component and each sets its ref from a
  // `[]`-dep effect, so they share one lifecycle. If any of these hooks is ever
  // mounted by a separately-lifecycled component (a modal, a lazily-mounted
  // panel, a list row), that assumption breaks and every cross-hook guard has
  // to be re-verified; do not collapse them into a single shared ref on the
  // strength of them agreeing today.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const edit = useNoteEditSession({
    body,
    filepath: entry.filepath,
    entryId: entry.id,
    entryTitle: entry.title,
    richEditorEnabled,
    onBodyChange: setBody,
  });
  const karakeep = useKarakeepExport({
    body,
    filepath: entry.filepath,
    entryTitle: entry.title,
    onBodyChange: setBody,
  });
  const audio = useNoteAudioPlayer(body);

  // Header overflow (⋮) — the entry to the secondary-actions sheet. Hidden
  // while editing (the edit surface has its own Save/Cancel chrome).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: edit.editMode
        ? undefined
        : () => (
            <IconButton
              icon="dots-vertical"
              onPress={() => setActionsOpen(true)}
              accessibilityLabel="More actions"
            />
          ),
    });
  }, [navigation, edit.editMode]);

  useEffect(() => {
    let mounted = true;
    // Marked void: every outcome (incl. the missing-file case) is handled
    // by the try/catch/finally inside — nothing can escape this IIFE.
    void (async () => {
      try {
        const content = await readNote(entry.filepath);
        if (!mounted) return;
        setBody(content);
      } catch {
        // Most common cause: user renamed or deleted the note in Obsidian
        // since carnet captured it. Show the missing-file banner instead
        // of an opaque error.
        if (!mounted) return;
        setMissing(true);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [entry.filepath]);

  // Unsaved-changes guard. preventDefault + show the discard dialog when the
  // user tries to navigate away with dirty edits, replaying the blocked action
  // only if they confirm. Re-subscribes whenever isDirty changes so the closure
  // always reads the current value.
  const { isDirty, showDiscardPrompt } = edit;
  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", (e) => {
      if (!isDirty) return;
      e.preventDefault();
      const blocked = e.data.action;
      showDiscardPrompt(() => navigation.dispatch(blocked));
    });
    return unsub;
  }, [navigation, isDirty, showDiscardPrompt]);

  const handleDelete = useCallback(async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setConfirmVisible(false);
    try {
      await moveToArchive(entry.filepath);
    } catch (e: unknown) {
      // Best-effort archive: even on failure, drop the entry from history
      // so the user isn't stuck staring at a ghost row.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] archive failed:", msg);
    }
    try {
      // Remove by id (recents-opened) AND by filepath (tag-browser-opened notes
      // carry a synthesized id that won't match) so no ghost row survives.
      await removeFromHistory(entry.id);
      await removeFromHistoryByFilepath(entry.filepath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] removeFromHistory failed:", msg);
    } finally {
      // Same release as handleRemoveFromHistory (#114). This path only avoided
      // the latch by accident — every await above is already caught, so it
      // always reached goBack(). Releasing explicitly means that stays true if
      // a future edit adds an uncaught await.
      deletingRef.current = false;
    }
    navigation.goBack();
  }, [entry.filepath, entry.id, navigation]);

  const handleRemoveFromHistory = useCallback(async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    try {
      // Mirrors handleDelete's best-effort shape: warn and still navigate away,
      // rather than leaving the user on a screen whose note is already gone.
      await removeFromHistory(entry.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] removeFromHistory failed:", msg);
    } finally {
      // Releasing the guard is the point (#114). This handler previously had
      // no try/catch at all, so a rejection skipped goBack() AND left the ref
      // latched — and because the ref is SHARED with handleDelete, both
      // destructive actions stayed dead for the rest of the screen's life,
      // with no feedback. The guard exists to stop a double-tap while a
      // removal is in flight, not to be a one-shot fuse.
      deletingRef.current = false;
    }
    navigation.goBack();
  }, [entry.id, navigation]);

  const handleReEnrich = useCallback(async () => {
    if (reEnrichingRef.current) return;
    reEnrichingRef.current = true;
    setReEnrichError(null);
    setReEnriching(true);
    try {
      const outcome = await reEnrichNote({ body, filepath: entry.filepath });
      if (outcome.kind === "updated") setBody(outcome.nextBody);
      else setReEnrichError(outcome.reason);
    } finally {
      // Explicit release (#114 pattern, see handleDelete): reEnrichNote catches
      // internally today, so this can't currently latch — but a future uncaught
      // await must not pin actionsBusy with no feedback.
      reEnrichingRef.current = false;
      setReEnriching(false);
    }
  }, [body, entry.filepath]);

  // Reuses the re-enrich in-flight ref and error slot: both are "re-run the
  // enrichment call on this note", they are mutually exclusive (a note is
  // either image-backed or a pending text capture, never both), and sharing
  // keeps the busy-state wiring in `actionsBusy` unchanged.
  const handleFinishEnrichment = useCallback(async () => {
    if (reEnrichingRef.current) return;
    reEnrichingRef.current = true;
    setReEnrichError(null);
    setReEnriching(true);
    try {
      const outcome = await finishPendingEnrichment({ body, filepath: entry.filepath });
      if (outcome.kind === "updated") setBody(outcome.markdown);
      else setReEnrichError(outcome.reason);
    } finally {
      // Explicit release (#114 pattern, see handleDelete) — see handleReEnrich.
      reEnrichingRef.current = false;
      setReEnriching(false);
    }
  }, [body, entry.filepath]);

  // The third member of the re-enrich family, and the only one not gated on the
  // note being stuck: "I edited this note, run enrichment on my edit". Shares
  // the same ref/error slot as the two above for the same reason — only one of
  // the three may ever be in flight.
  const handleGeneralReEnrich = useCallback(async () => {
    if (reEnrichingRef.current) return;
    reEnrichingRef.current = true;
    setReEnrichError(null);
    setReEnriching(true);
    try {
      const outcome = await reEnrichNoteInPlace({
        body,
        filepath: entry.filepath,
        mode: entry.mode,
      });
      if (outcome.kind === "updated") {
        setBody(outcome.markdown);
        // Enrichment rewrites the title and tags, and every OTHER surface (Home
        // cards, tag browser, search) reads those from the cached note index and
        // the recents history — not from this screen's state. Without these two
        // the note stays stale everywhere but here until the next full vault scan.
        // Best-effort: a failure must not undo a write that already landed.
        void upsertNoteInIndex(entry.filepath, outcome.markdown).catch(() => undefined);
        void updateCaptureTitleByFilepath(
          entry.filepath,
          deriveTitle(outcome.markdown) || entry.title,
        ).catch(() => undefined);
      } else setReEnrichError(outcome.reason);
    } finally {
      // Explicit release (#114 pattern, see handleDelete) — see handleReEnrich.
      reEnrichingRef.current = false;
      setReEnriching(false);
    }
  }, [body, entry.filepath, entry.mode, entry.title]);

  const handleTranscribe = useCallback(async () => {
    if (transcribingRef.current) return;
    transcribingRef.current = true;
    setTranscribeError(null);
    setTranscribing(true);
    try {
      const outcome = await transcribeNote({ body, filepath: entry.filepath });
      if (outcome.kind === "updated") setBody(outcome.nextBody);
      else setTranscribeError(outcome.reason);
    } finally {
      // Explicit release (#114 pattern, see handleDelete) — see handleReEnrich.
      transcribingRef.current = false;
      setTranscribing(false);
    }
  }, [body, entry.filepath]);

  const handleEnhance = useCallback(async () => {
    if (enhancingRef.current) return;
    enhancingRef.current = true;
    setEnhanceError(null);
    setEnhancedWith(null);
    setEnhancing(true);
    try {
      const outcome = await enhanceNoteProse({ body, filepath: entry.filepath });
      if (outcome.kind === "updated") {
        setBody(outcome.nextBody);
        setEnhancedWith(outcome.providerLabel);
      } else setEnhanceError(outcome.reason);
    } finally {
      // Explicit release (#114 pattern, see handleDelete) — see handleReEnrich.
      enhancingRef.current = false;
      setEnhancing(false);
    }
  }, [body, entry.filepath]);

  const handleAttachPhoto = useCallback(
    async (base64: string, mime: string, basename?: string) => {
      if (attachingPhotoRef.current) return;
      attachingPhotoRef.current = true;
      setAttachPhotoError(null);
      setAttachingPhoto(true);
      try {
        const outcome = await attachPhotoToNote({
          filepath: entry.filepath,
          base64,
          mime,
          basename,
        });
        if (outcome.kind === "attached") {
          setBody(outcome.nextBody);
          setPhotoAttached(true);
        } else setAttachPhotoError(outcome.reason);
      } finally {
        // Explicit release (#114 pattern, see handleDelete) — see handleReEnrich.
        attachingPhotoRef.current = false;
        setAttachingPhoto(false);
      }
    },
    [entry.filepath],
  );

  // ── Attachments (images inline + tappable file rows) ──────────────────────
  // Audio is rendered by the dedicated player, so it's excluded here. The
  // markdown renderer can't resolve relative/SAF URIs, so we resolve each link
  // to a storage URI in an effect and render from state.
  const [attachments, setAttachments] = useState<ResolvedAttachment[]>([]);
  useEffect(() => {
    let active = true;
    // Best-effort: a resolution failure (SAF permission hiccup) degrades to
    // "no attachment rows" — the note body still renders. Previously a
    // reject here escaped as an unhandled rejection (lint find, 2026-07-18).
    resolveNoteAttachments(body)
      .then((resolved) => {
        if (active) setAttachments(resolved);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[RecentDetail] attachment resolution failed:", msg);
      });
    return () => {
      active = false;
    };
  }, [body]);

  // ── Related notes (lexical, over the cached index) ─────────────────────────
  // Cache-first and best-effort: a missing/stale index just means an empty
  // Related card, never a block on rendering the note. Recomputed when the
  // body changes (an edit can change tags/title).
  const [related, setRelated] = useState<NoteIndexEntry[]>([]);
  useEffect(() => {
    let active = true;
    if (missing || !body) {
      setRelated([]);
      return;
    }
    loadCachedNoteIndex()
      .then((index) => {
        if (!active || !index) return;
        setRelated(
          computeRelatedNotes(
            body,
            { filepath: entry.filepath, title: entry.title, mode: entry.mode },
            index,
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [body, missing, entry.filepath, entry.title, entry.mode]);

  // Link a related note INTO this one as a persisted [[wikilink]] under a
  // "## Related" section. The insert is pure + deduped (insertRelatedLink); the
  // screen owns the disk write. A failed write surfaces through the existing
  // Save-failed banner.
  const [relatedLinked, setRelatedLinked] = useState<string | null>(null);
  const linkingRelatedRef = useRef(false);
  const { setEditError } = edit;
  const linkRelated = useCallback(
    async (title: string) => {
      if (linkingRelatedRef.current) return;
      linkingRelatedRef.current = true;
      try {
        const { next, changed } = insertRelatedLink(body, title);
        if (changed) {
          await updateNote(entry.filepath, next);
          if (mountedRef.current) setBody(next);
        }
        if (mountedRef.current) {
          setRelatedLinked(
            changed ? `Linked [[${title}]] under Related` : "Already linked",
          );
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (mountedRef.current) setEditError(msg);
      } finally {
        linkingRelatedRef.current = false;
      }
    },
    [body, entry.filepath, setEditError],
  );

  // Push (not navigate) so the related note stacks on top and Back returns
  // here — hopping through a chain of related notes stays reversible. Ref
  // guard matches the screen's other async actions: a double-tap must not
  // stack the target twice.
  const openingRelatedRef = useRef(false);
  const openRelated = useCallback(
    async (uri: string) => {
      if (openingRelatedRef.current) return;
      openingRelatedRef.current = true;
      try {
        const target = await resolveNoteEntry(uri);
        if (target) navigation.push("RecentDetail", { entry: target });
      } finally {
        openingRelatedRef.current = false;
      }
    },
    [navigation],
  );

  const markdownRules = useMemo(
    () => ({
      image: makeImageRule(imageUrisByRel(attachments), [
        styles.inlineImage,
        { backgroundColor: theme.colors.surfaceVariant },
      ]),
    }),
    [attachments, theme.colors.surfaceVariant],
  );

  const { canReEnrich, canTranscribe, canEnhance, showAudioPlayer } = noteCapabilities(
    extractFrontmatterField(body, "kind") ?? "",
    missing,
  );

  if (loading) return <NoteDetailSkeleton theme={theme} />;

  // Strip YAML frontmatter so the renderer doesn't show the `---` raw block,
  // then strip only Audio + non-image File links (rendered by the player /
  // files card). Image embeds STAY so they render inline in the prose via the
  // custom markdown image rule (markdownRules).
  const renderBody = stripPairedBinaryLinks(stripFrontmatter(body), {
    keepImages: true,
  });
  const fileAttachments = attachments.filter((a) => !a.mime.startsWith("image/"));
  const noteTags = tagsForNote(body);
  // One banner slot: the most actionable issue wins instead of five banners
  // stacking above the note. (The missing-file case takes over the whole screen.)
  const busy = {
    reEnriching,
    transcribing,
    exportingKarakeep: karakeep.exportingKarakeep,
    enhancing,
    attachingPhoto,
  };
  const activeIssue = activeIssueMessage({
    editError: edit.editError,
    karakeepError: karakeep.karakeepError,
    transcribeError,
    reEnrichError,
    enhanceError,
    attachPhotoError,
  });
  const inlineBusyLabel = busyLabel(busy);
  const actionsBusy = isActionsBusy(busy);
  // Every secondary action dismisses the sheet first, then dispatches — the
  // sheet is a menu, not a surface any of these report progress back into.
  const fromSheet = (action: () => void) => () => {
    setActionsOpen(false);
    action();
  };

  // Rich (WYSIWYG) editing takes the whole screen so TenTap's formatting toolbar
  // can dock above the keyboard.
  if (edit.editMode && richEditorEnabled) {
    return (
      <RichNoteEditor
        theme={theme}
        editorRef={edit.wysiwygRef}
        seed={edit.wysiwygSeed}
        editError={edit.editError}
        saving={edit.saving}
        tags={edit.editTags}
        onTagsChange={edit.setEditTags}
        knownTags={edit.knownTags}
        onInsertImage={() => void edit.insertWysiwygImage()}
        onCancel={edit.cancelEdit}
        onSave={() => void edit.handleSaveWysiwyg()}
        discardVisible={edit.discardVisible}
        onKeepEditing={edit.keepEditing}
        onDiscard={edit.confirmDiscard}
      />
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.content}>
        {missing ? (
          <NoteMissingState
            theme={theme}
            onRemoveFromList={() => void handleRemoveFromHistory()}
          />
        ) : null}

        {!missing && activeIssue ? (
          <Banner visible icon="alert" actions={[]}>
            {activeIssue}
          </Banner>
        ) : null}

        {!missing && inlineBusyLabel ? (
          <View style={styles.inlineLoading}>
            <ActivityIndicator />
            <Text variant="bodySmall" style={styles.dim}>
              {inlineBusyLabel}
            </Text>
          </View>
        ) : null}

        {!missing && !edit.editMode ? (
          <NoteMetaRow
            theme={theme}
            mode={entry.mode}
            tags={noteTags}
            location={extractFrontmatterField(body, "location")}
            pendingEnrich={
              extractFrontmatterField(body, "status") === "pending-enrich"
            }
            fallbackProviderId={extractFrontmatterField(body, FALLBACK_PROVIDER_FIELD)}
            capturedAt={formatDate(entry.createdAt)}
            onTagPress={(tag) => navigation.navigate("Search", { tag })}
            onLocationPress={(loc) =>
              void Linking.openURL(`geo:${loc}?q=${loc}`).catch(() => undefined)
            }
          />
        ) : null}

        {!missing && edit.editMode ? (
          <NoteMarkdownEditCard
            theme={theme}
            draft={edit.draft}
            onDraftChange={edit.setDraft}
            forceSelection={edit.forceSelection}
            onSelectionChange={edit.setSelection}
            onCaretReleased={edit.clearForceSelection}
            preview={edit.preview}
            onTogglePreview={edit.togglePreview}
            showPreviewToggle={!richEditorEnabled}
            saving={edit.saving}
            saveDisabled={!edit.isDirty}
            onFormat={edit.applyFmt}
            onInsertImage={() => void edit.insertImage()}
            onCancel={edit.cancelEdit}
            onSave={() =>
              void (richEditorEnabled
                ? edit.handleSaveWysiwyg()
                : edit.handleSaveEdit())
            }
          />
        ) : !missing ? (
          <>
            {showAudioPlayer ? (
              <NoteAudioPlayerCard
                theme={theme}
                isPlaying={audio.isPlaying}
                loading={audio.playerLoading}
                positionMs={audio.positionMs}
                durationMs={audio.durationMs}
                error={audio.playerError}
                disabled={audio.playerLoading || reEnriching || transcribing}
                onTogglePlay={() => void audio.togglePlay()}
              />
            ) : null}

            {fileAttachments.length > 0 ? (
              <NoteAttachmentsCard
                files={fileAttachments}
                onOpen={(uri) => void openAttachment(uri)}
              />
            ) : null}

            {/* The note itself — full-width on the reading surface, no card
                box. This is what the user came for; it starts here. */}
            <View style={styles.bodyWrap}>
              <Markdown style={markdownStyle(theme)} rules={markdownRules}>
                {renderBody}
              </Markdown>
            </View>

            {related.length > 0 ? (
              <RelatedNotesCard
                related={related}
                onOpen={(uri) => void openRelated(uri)}
                onLink={(title) => void linkRelated(title)}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {/* Single primary action: edit. Everything else is behind the header
          overflow sheet. */}
      {!missing && !edit.editMode ? (
        <FAB
          icon="pencil"
          label="Edit"
          color={theme.carnet.onFill}
          style={[
            styles.fab,
            {
              backgroundColor: theme.carnet.fill,
              borderRadius: theme.carnet.radius.pill,
            },
          ]}
          onPress={edit.enterEdit}
          disabled={actionsBusy}
          accessibilityLabel="Edit note"
        />
      ) : null}

      <RecentDetailSnackbars
        karakeepDone={karakeep.karakeepDone}
        karakeepUpdated={karakeep.karakeepUpdated}
        karakeepSkipNote={karakeep.karakeepSkipNote}
        onDismissKarakeepDone={karakeep.dismissKarakeepDone}
        karakeepQueued={karakeep.karakeepQueued}
        onDismissKarakeepQueued={karakeep.dismissKarakeepQueued}
        relatedLinked={relatedLinked}
        onDismissRelatedLinked={() => setRelatedLinked(null)}
        photoAttached={photoAttached}
        onDismissPhotoAttached={() => setPhotoAttached(false)}
        enhancedWith={enhancedWith}
        onDismissEnhancedWith={() => setEnhancedWith(null)}
      />

      <Portal>
        <NoteActionsSheet
          theme={theme}
          visible={actionsOpen}
          onDismiss={() => setActionsOpen(false)}
          canReEnrich={canReEnrich}
          canFinishEnrichment={!missing && isPendingEnrich(body)}
          onFinishEnrichment={fromSheet(() => void handleFinishEnrichment())}
          canReEnrichGeneral={
            !missing &&
            isReEnrichableMode(entry.mode) &&
            subdirForUri(entry.filepath) !== "Notes"
          }
          onGeneralReEnrich={fromSheet(() => void handleGeneralReEnrich())}
          canTranscribe={canTranscribe}
          canEnhance={canEnhance}
          karakeepConfigured={karakeepConfigured}
          actionsBusy={actionsBusy}
          missing={missing}
          onEnhance={fromSheet(() => void handleEnhance())}
          onAttachPhoto={fromSheet(() => setAttachOpen(true))}
          onReEnrich={fromSheet(() => void handleReEnrich())}
          onTranscribe={fromSheet(() => void handleTranscribe())}
          onSendToKarakeep={fromSheet(() => karakeep.handleSendToKarakeep())}
          onFileInfo={fromSheet(() => setFileInfoOpen(true))}
          onDelete={fromSheet(() => setConfirmVisible(true))}
        />

        <PhotoAttachModal
          visible={attachOpen}
          onDismiss={() => setAttachOpen(false)}
          onCaptured={(base64, mime, basename) =>
            void handleAttachPhoto(base64, mime, basename)
          }
        />

        <NoteFileInfoDialog
          theme={theme}
          visible={fileInfoOpen}
          onDismiss={() => setFileInfoOpen(false)}
          filepath={entry.filepath}
          summary={`${formatMode(entry.mode)} · captured ${formatDate(entry.createdAt)}`}
        />

        <ArchiveNoteDialog
          theme={theme}
          visible={confirmVisible}
          onCancel={() => setConfirmVisible(false)}
          onConfirm={() => void handleDelete()}
        />

        <DiscardEditsDialog
          theme={theme}
          visible={edit.discardVisible}
          onKeepEditing={edit.keepEditing}
          onDiscard={edit.confirmDiscard}
        />
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 96 },
  bodyWrap: { paddingTop: 4 },
  fab: { position: "absolute", right: 16, bottom: 24 },
  dim: { opacity: 0.6 },
  inlineLoading: {
    paddingVertical: 16,
    alignItems: "center",
    gap: 6,
  },
  // Inline image rendered in the note prose via makeImageRule; background
  // tint comes from the theme at the usage site (surfaceVariant).
  inlineImage: {
    width: "100%",
    height: 240,
    borderRadius: 12,
    marginVertical: 8,
  },
});
