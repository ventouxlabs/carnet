// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the related-notes query for the note currently open in the detail
 * screen and scores it against the cached vault index.
 *
 * Split out of RecentDetailScreen because the interesting part is the QUERY —
 * which title wins when enrichment has rewritten the body, which subdir the
 * capture mode maps to, which tags come off the live body rather than the
 * stale history entry. The scoring itself lives in ./relatedNotes.
 */

import { deriveTitle } from "@carnet/shared";

import { relatedSubdirForMode } from "./recentDetailView";
import { findRelatedNotes } from "./relatedNotes";
import type { CaptureEntry } from "./storage";
import { tagsForNote, type NoteIndex, type NoteIndexEntry } from "./vault";

/**
 * Related notes for `body` (the live note text, which an edit or a re-enrich
 * may have moved on from `entry`) against a loaded index. The title falls back
 * to the history entry's when the body has no derivable heading.
 */
export function computeRelatedNotes(
  body: string,
  entry: Pick<CaptureEntry, "filepath" | "title" | "mode">,
  index: NoteIndex,
): NoteIndexEntry[] {
  return findRelatedNotes(
    {
      uri: entry.filepath,
      subdir: relatedSubdirForMode(entry.mode),
      title: deriveTitle(body) || entry.title,
      tags: tagsForNote(body),
    },
    index,
  );
}
