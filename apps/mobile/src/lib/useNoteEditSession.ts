// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The note detail screen's edit session: entering/leaving edit mode, the
 * markdown-textarea draft with its toolbar caret handling, the WYSIWYG seed +
 * tag chips, both save paths, and the unsaved-changes discard prompt.
 *
 * Lifted out of RecentDetailScreen so the save flows — which are the only place
 * in the app that rewrites an existing note's bytes — are testable without a
 * renderer. The pure pieces stay in their own modules (lib/markdownEdit.ts for
 * the caret transforms, lib/wysiwygSave.ts for the header reattach + skip
 * decision, lib/vaultImageInsert.ts for the pick→write→relative-link step);
 * this hook owns only the React state and the in-flight/mounted guards.
 *
 * Frontmatter safety: the rich editor never sees the `---` block. It is split
 * off on enter (splitFrontmatter), stashed in a ref, and reattached byte-exact
 * on save by planWysiwygSave — which also skips the write entirely when nothing
 * changed, so opening and closing a note never churns its bytes or mtime.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { deriveTitle } from "@carnet/shared";
import {
  applyFormat,
  insertAtCursor,
  type FormatKind,
  type Sel,
} from "./markdownEdit";
import { updateCaptureTitle } from "./storage";
import { getTagIndex, invalidateNoteIndex, tagsForNote } from "./vault";
import { pickAndWriteVaultImage } from "./vaultImageInsert";
import type { WysiwygEditorRef } from "../components/WysiwygEditor";
import { planWysiwygSave } from "./wysiwygSave";
import { splitFrontmatter, updateNote } from "./writer";

export interface UseNoteEditSessionArgs {
  /** The note's full on-disk markdown, including frontmatter. */
  body: string;
  filepath: string;
  entryId: string;
  entryTitle: string;
  /** Rich (WYSIWYG) editor vs the raw markdown textarea. */
  richEditorEnabled: boolean;
  /** Adopt the newly-written markdown after a successful save. */
  onBodyChange: (next: string) => void;
}

export interface NoteEditSession {
  editMode: boolean;
  /** True iff the user is editing AND has something worth discarding. */
  isDirty: boolean;
  editError: string | null;
  setEditError: (next: string | null) => void;
  saving: boolean;
  // Markdown-textarea path.
  draft: string;
  setDraft: (next: string) => void;
  selection: Sel;
  setSelection: (next: Sel) => void;
  forceSelection: Sel | null;
  clearForceSelection: () => void;
  preview: boolean;
  togglePreview: () => void;
  applyFmt: (kind: FormatKind) => void;
  insertImage: () => Promise<void>;
  handleSaveEdit: () => Promise<void>;
  // Rich (WYSIWYG) path.
  wysiwygRef: React.RefObject<WysiwygEditorRef | null>;
  wysiwygSeed: string;
  editTags: string[];
  setEditTags: (next: string[]) => void;
  knownTags: string[];
  insertWysiwygImage: () => Promise<void>;
  handleSaveWysiwyg: () => Promise<void>;
  // Enter / leave.
  enterEdit: () => void;
  cancelEdit: () => void;
  discardVisible: boolean;
  keepEditing: () => void;
  confirmDiscard: () => void;
  /**
   * Open the discard prompt on behalf of an outside actor (the navigation
   * beforeRemove guard). `replay` re-fires whatever the user originally asked
   * for once they confirm; null when there is nothing to replay.
   */
  showDiscardPrompt: (replay: (() => void) | null) => void;
}

export function useNoteEditSession({
  body,
  filepath,
  entryId,
  entryTitle,
  richEditorEnabled,
  onBodyChange,
}: UseNoteEditSessionArgs): NoteEditSession {
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [editError, setEditError] = useState<string | null>(null);
  const [discardVisible, setDiscardVisible] = useState(false);
  // `selection` tracks the live caret/range (via onSelectionChange) so
  // transforms know what to act on; `forceSelection` is a transient override
  // applied ONLY right after a toolbar action to place the caret, then cleared
  // so the IME owns the caret again (avoids cursor jitter).
  const [selection, setSelection] = useState<Sel>({ start: 0, end: 0 });
  const [forceSelection, setForceSelection] = useState<Sel | null>(null);
  const [preview, setPreview] = useState(false);
  // True only while a save is committing — disables the toolbar so a format/
  // image tap can't mutate `draft` after a save captured it (which would be
  // discarded when the save exits edit mode).
  const [saving, setSaving] = useState(false);
  const [wysiwygSeed, setWysiwygSeed] = useState<string>("");
  const wysiwygRef = useRef<WysiwygEditorRef>(null);
  const editHeaderRef = useRef<string>("");
  // `editTags` is the live chip set; the ref holds the tags as they were on
  // entering edit so save can keep the frontmatter byte-exact when the set is
  // unchanged. `knownTags` backs autocomplete.
  const [editTags, setEditTags] = useState<string[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const editOriginalTagsRef = useRef<string[]>([]);
  const insertingImageRef = useRef(false);
  const savingEditRef = useRef(false);
  // Holds the navigation replay that triggered the prompt so the
  // discard-confirm dialog can re-fire it after the user confirms.
  const pendingReplayRef = useRef<(() => void) | null>(null);
  // Mounted guard — Back-during-save can unmount before the in-flight
  // updateNote resolves; setState on an unmounted component triggers a React
  // warning. The in-flight write itself still lands on disk.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load the vault tag index for edit-mode autocomplete (cache-first;
  // best-effort — a failure just means no suggestions).
  useEffect(() => {
    let active = true;
    getTagIndex()
      .then((index) => {
        if (active) setKnownTags(index.tags.map((e) => e.tag));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // The WYSIWYG editor holds its content inside the WebView; diffing it per
  // keystroke would cost a bridge round-trip each time, so we conservatively
  // treat any rich-editor session as dirty — the discard prompt may appear with
  // no real change, but edits are never silently lost.
  const isDirty = editMode && (richEditorEnabled ? true : draft !== body);

  const enterEdit = useCallback(() => {
    setEditError(null);
    if (richEditorEnabled) {
      // Split frontmatter off and stash it; the editor only ever sees the body,
      // and the header is reattached byte-exact on save (splitFrontmatter docs).
      const { header, body: noteBody } = splitFrontmatter(body);
      editHeaderRef.current = header;
      setWysiwygSeed(noteBody);
      // Seed the tag chips from the note's frontmatter (distinct + normalized).
      const noteTags = tagsForNote(body);
      editOriginalTagsRef.current = noteTags;
      setEditTags(noteTags);
    } else {
      setDraft(body);
      setSelection({ start: 0, end: 0 });
      setForceSelection(null);
      setPreview(false);
    }
    setEditMode(true);
  }, [body, richEditorEnabled]);

  const exitEdit = useCallback(() => {
    setEditMode(false);
    setDraft("");
    setEditError(null);
    setForceSelection(null);
    setPreview(false);
    setEditTags([]);
  }, []);

  /** Apply a toolbar formatting intent to the draft + reposition the caret. */
  const applyFmt = useCallback(
    (kind: FormatKind) => {
      if (savingEditRef.current) return;
      const r = applyFormat(draft, selection, kind);
      setDraft(r.text);
      setSelection(r.selection);
      setForceSelection(r.selection);
    },
    [draft, selection],
  );

  /** Toolbar image button: pick → write to the vault → insert the embed at the
   * caret. Reuses the attachments plumbing; the note is already on disk so the
   * binary is committed immediately. Cancelling the picker writes nothing; but
   * discarding the edit AFTER inserting leaves the written file orphaned in
   * Photos/ (acceptable — it's recoverable in the vault, same as a stub photo). */
  const insertImage = useCallback(async () => {
    if (insertingImageRef.current || savingEditRef.current) return;
    insertingImageRef.current = true;
    setEditError(null);
    try {
      const written = await pickAndWriteVaultImage();
      if (!written) return;
      const r = insertAtCursor(draft, selection, `![](${written.rel})`);
      setDraft(r.text);
      setSelection(r.selection);
      setForceSelection(r.selection);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      insertingImageRef.current = false;
    }
  }, [draft, selection]);

  /** Rich-editor image button: pick → write to the vault → insert the embed at
   * the cursor inside the WYSIWYG editor. The picked bytes are reused to build
   * the in-editor data-URI preview (no disk re-read); an image over the inline
   * cap still inserts + saves, just without an in-editor preview. Cancelling
   * writes nothing; discarding the edit after inserting leaves the file orphaned
   * in Photos/ (recoverable in the vault, same as a stub photo). */
  const insertWysiwygImage = useCallback(async () => {
    if (insertingImageRef.current || savingEditRef.current) return;
    insertingImageRef.current = true;
    setEditError(null);
    try {
      const written = await pickAndWriteVaultImage();
      if (!written) return;
      wysiwygRef.current?.insertImage(written.rel, written.dataUri);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      insertingImageRef.current = false;
    }
  }, []);

  const showDiscardPrompt = useCallback((replay: (() => void) | null) => {
    pendingReplayRef.current = replay;
    setDiscardVisible(true);
  }, []);

  const cancelEdit = useCallback(() => {
    if (isDirty) {
      showDiscardPrompt(null);
      return;
    }
    exitEdit();
  }, [isDirty, exitEdit, showDiscardPrompt]);

  const keepEditing = useCallback(() => {
    pendingReplayRef.current = null;
    setDiscardVisible(false);
  }, []);

  const confirmDiscard = useCallback(() => {
    setDiscardVisible(false);
    const pending = pendingReplayRef.current;
    pendingReplayRef.current = null;
    exitEdit();
    // Replay the navigation action the user originally requested. The
    // re-fired beforeRemove will see !isDirty and pass through.
    if (pending) pending();
  }, [exitEdit]);

  /** Best-effort recents-title refresh — never blocks or reverts the disk write. */
  const refreshRecentsTitle = useCallback(
    async (savedMarkdown: string) => {
      const newTitle = deriveTitle(savedMarkdown) || entryTitle;
      if (newTitle === entryTitle) return;
      try {
        await updateCaptureTitle(entryId, newTitle);
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn("[RecentDetail] title update failed:", reason);
      }
    },
    [entryId, entryTitle],
  );

  const handleSaveEdit = useCallback(async () => {
    if (savingEditRef.current) return;
    savingEditRef.current = true;
    setSaving(true);
    setEditError(null);
    // Disk write owns its own try so a writeAsString failure surfaces as
    // "Save failed" while the recents-title update below stays best-effort.
    // Otherwise an AsyncStorage failure after a successful disk write would
    // mislead the user into thinking nothing was saved.
    try {
      await updateNote(filepath, draft);
      if (!mountedRef.current) {
        savingEditRef.current = false;
        return;
      }
      onBodyChange(draft);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] save edit failed:", reason);
      if (mountedRef.current) {
        setEditError(reason);
        setSaving(false);
      }
      savingEditRef.current = false;
      return;
    }

    await refreshRecentsTitle(draft);

    if (mountedRef.current) {
      setEditMode(false);
      setDraft("");
      setSaving(false);
    }
    savingEditRef.current = false;
  }, [draft, filepath, onBodyChange, refreshRecentsTitle]);

  // WYSIWYG save: pull the edited body back out of the WebView as markdown, then
  // reattach the stashed frontmatter header byte-exact. Mirrors handleSaveEdit's
  // disk-then-title flow and its guards (in-flight ref, mounted ref, banner).
  const handleSaveWysiwyg = useCallback(async () => {
    if (savingEditRef.current) return;
    savingEditRef.current = true;
    setSaving(true);
    setEditError(null);
    let next: string;
    try {
      // getMarkdown() rejects on its own 5s timeout (awaitMarkdownResponse), so a
      // never-resolving bridge — Save tapped before the editor mounted — surfaces
      // as an error instead of a stuck, disabled UI, and never leaks the resolver.
      const editedBody = await (wysiwygRef.current?.getMarkdown() ??
        Promise.reject(new Error("Editor not mounted")));
      // Reattach the stashed frontmatter (applying tag edits) and decide whether
      // a write is even needed — planWysiwygSave keeps the header byte-exact when
      // tags are unchanged and skips the write when the content is identical.
      const plan = planWysiwygSave({
        header: editHeaderRef.current,
        editedBody,
        editTags,
        originalTags: editOriginalTagsRef.current,
        currentBody: body,
      });
      const tagsChanged = plan.tagsChanged;
      next = plan.next;
      if (!plan.shouldWrite) {
        // Editor returned the exact on-disk content — nothing changed. Skip the
        // write so opening + saving a note never churns its content/mtime. (Real
        // edits, and any whitespace/underscore-escape normalization, still differ
        // and do write.)
        if (mountedRef.current) {
          setEditMode(false);
          setSaving(false);
        }
        savingEditRef.current = false;
        return;
      }
      await updateNote(filepath, next);
      if (!mountedRef.current) {
        savingEditRef.current = false;
        return;
      }
      onBodyChange(next);
      // A tag change makes the vault index stale — drop the cache so the
      // browser counts + capture autocomplete rebuild on next read.
      if (tagsChanged) void invalidateNoteIndex().catch(() => undefined);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] save (rich) failed:", reason);
      if (mountedRef.current) {
        setEditError(reason);
        setSaving(false);
      }
      savingEditRef.current = false;
      return;
    }

    await refreshRecentsTitle(next);

    if (mountedRef.current) {
      setEditMode(false);
      setSaving(false);
    }
    savingEditRef.current = false;
  }, [body, editTags, filepath, onBodyChange, refreshRecentsTitle]);

  const clearForceSelection = useCallback(() => setForceSelection(null), []);
  const togglePreview = useCallback(() => setPreview((v) => !v), []);

  return {
    editMode,
    isDirty,
    editError,
    setEditError,
    saving,
    draft,
    setDraft,
    selection,
    setSelection,
    forceSelection,
    clearForceSelection,
    preview,
    togglePreview,
    applyFmt,
    insertImage,
    handleSaveEdit,
    wysiwygRef,
    wysiwygSeed,
    editTags,
    setEditTags,
    knownTags,
    insertWysiwygImage,
    handleSaveWysiwyg,
    enterEdit,
    cancelEdit,
    discardVisible,
    keepEditing,
    confirmDiscard,
    showDiscardPrompt,
  };
}
