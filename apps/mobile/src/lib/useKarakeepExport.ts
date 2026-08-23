// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Karakeep export state machine for the note detail screen: the in-flight /
 * mounted guards, the re-export confirm gate, and the snackbar/banner state
 * that an export outcome produces.
 *
 * The three layers stay separate: lib/karakeepNoteExport.ts owns the network +
 * disk orchestration, lib/karakeepExportUi.ts owns the pure outcome → UI-plan
 * decision, and this hook owns only the React wiring between them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { exportNoteToKarakeep } from "./karakeepNoteExport";
import { needsReexportConfirm, planKarakeepUiUpdate } from "./karakeepExportUi";
import { enqueuePendingExport } from "./pendingSync";

export interface UseKarakeepExportArgs {
  /** The note's full markdown, including frontmatter. */
  body: string;
  filepath: string;
  entryTitle: string;
  /** Adopt the rewritten note after a successful (or partial) export. */
  onBodyChange: (next: string) => void;
}

export interface KarakeepExportState {
  exportingKarakeep: boolean;
  karakeepError: string | null;
  /** Success snackbar. */
  karakeepDone: boolean;
  dismissKarakeepDone: () => void;
  /** True when the last success UPDATED an existing bookmark (snackbar copy). */
  karakeepUpdated: boolean;
  /** Unsupported-attachment notice appended to the success snackbar, or null. */
  karakeepSkipNote: string | null;
  /** Unreachable-host retry was queued — informational snackbar, not an error. */
  karakeepQueued: boolean;
  dismissKarakeepQueued: () => void;
  /** Button entry point: confirms first when the note was already exported. */
  handleSendToKarakeep: () => void;
}

export function useKarakeepExport({
  body,
  filepath,
  entryTitle,
  onBodyChange,
}: UseKarakeepExportArgs): KarakeepExportState {
  const [exportingKarakeep, setExportingKarakeep] = useState(false);
  const [karakeepError, setKarakeepError] = useState<string | null>(null);
  const [karakeepDone, setKarakeepDone] = useState(false);
  const [karakeepUpdated, setKarakeepUpdated] = useState(false);
  const [karakeepSkipNote, setKarakeepSkipNote] = useState<string | null>(null);
  const [karakeepQueued, setKarakeepQueued] = useState(false);
  const exportingKarakeepRef = useRef(false);
  // Mounted guard — Back-during-export can unmount before the request
  // resolves; setState after that triggers a React warning. The disk write
  // itself already landed.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // #115: the confirm dialog defers the export behind an "Update" button, so
  // by the time it fires, `body` from that render may be stale — Transcribe,
  // Re-enrich, linkRelated or a finished edit can all replace the note while
  // the Alert sits open. Exporting the closure's copy silently overwrote the
  // Karakeep bookmark with text the user had already replaced. Read through a
  // ref so the export always sends what is on screen at the moment it runs.
  const bodyRef = useRef(body);
  useEffect(() => {
    bodyRef.current = body;
  }, [body]);

  const runKarakeepExport = useCallback(async () => {
    if (exportingKarakeepRef.current) return;
    exportingKarakeepRef.current = true;
    setKarakeepError(null);
    setKarakeepSkipNote(null);
    setKarakeepQueued(false);
    setExportingKarakeep(true);
    // exportNoteToKarakeep owns the create-vs-update / 404-recovery / asset-sync
    // orchestration + the in-place note write; this hook only translates the
    // outcome into UI state.
    const plan = planKarakeepUiUpdate(
      await exportNoteToKarakeep({ body: bodyRef.current, filepath, entryTitle }),
    );
    if (plan.kind === "queue") {
      // The enqueue runs OUTSIDE the mounted guard: a Back-during-export must
      // not lose the retry, only skip the snackbar.
      try {
        await enqueuePendingExport({ filepath, entryTitle });
        if (mountedRef.current) setKarakeepQueued(true);
      } catch {
        // Queueing itself failed (storage error) — fall back to the plain
        // error banner so the failure is at least visible.
        if (mountedRef.current) setKarakeepError(plan.fallbackError);
      }
    } else if (mountedRef.current) {
      if (plan.kind === "error") {
        setKarakeepError(plan.message);
      } else if (plan.kind === "partial") {
        onBodyChange(plan.nextBody);
        setKarakeepError(plan.message);
      } else {
        onBodyChange(plan.nextBody);
        setKarakeepUpdated(plan.didUpdate);
        setKarakeepSkipNote(plan.skipNote);
        setKarakeepDone(true);
      }
    }
    exportingKarakeepRef.current = false;
    if (mountedRef.current) setExportingKarakeep(false);
  }, [filepath, entryTitle, onBodyChange]);

  // If the note was already exported (frontmatter carries a karakeepId),
  // confirm before re-sending; otherwise export directly.
  const handleSendToKarakeep = useCallback(() => {
    if (exportingKarakeepRef.current) return;
    if (needsReexportConfirm(body)) {
      Alert.alert(
        "Already exported",
        "This note is already in Karakeep. Update the existing bookmark with the current text and tags?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Update", onPress: () => void runKarakeepExport() },
        ],
      );
      return;
    }
    void runKarakeepExport();
  }, [body, runKarakeepExport]);

  const dismissKarakeepDone = useCallback(() => setKarakeepDone(false), []);
  const dismissKarakeepQueued = useCallback(() => setKarakeepQueued(false), []);

  return {
    exportingKarakeep,
    karakeepError,
    karakeepDone,
    dismissKarakeepDone,
    karakeepUpdated,
    karakeepSkipNote,
    karakeepQueued,
    dismissKarakeepQueued,
    handleSendToKarakeep,
  };
}
