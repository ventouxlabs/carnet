// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two persisted settings the note detail screen reads once on mount: is
 * the Karakeep action available (gated on a non-blank instance URL), and is
 * the rich editor the edit surface (kept behind a flag so a future gate can
 * flip it off without re-plumbing the screen).
 *
 * Best-effort by design — the defaults returned before (and after a failed)
 * load already give a usable screen, so a settings read that rejects is
 * swallowed rather than surfaced.
 */

import { useEffect, useState } from "react";

import { getSettings } from "./settings";

export interface NoteDetailSettings {
  karakeepConfigured: boolean;
  richEditorEnabled: boolean;
}

export function useNoteDetailSettings(): NoteDetailSettings {
  const [karakeepConfigured, setKarakeepConfigured] = useState(false);
  const [richEditorEnabled, setRichEditorEnabled] = useState(true);

  useEffect(() => {
    let active = true;
    getSettings()
      .then((s) => {
        if (!active) return;
        setRichEditorEnabled(s.richEditorEnabled);
        setKarakeepConfigured(s.karakeepUrl.trim().length > 0);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Fresh object every render — callers must destructure (as RecentDetailScreen
  // does) rather than put the returned object itself in a dep array.
  return { karakeepConfigured, richEditorEnabled };
}
