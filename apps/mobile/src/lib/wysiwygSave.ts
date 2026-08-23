// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The frontmatter-reattach + change-detection decision for the WYSIWYG note
 * save, lifted out of RecentDetailScreen so it is unit testable without the
 * WebView-backed editor. Pure: given the stashed header, the edited body, the
 * tag edits, and the current on-disk body, decide the exact next content,
 * whether tags changed (→ vault-index invalidation), and whether a write is even
 * needed (identical content → skip the write so open+save never churns mtime).
 */

import { applyTagsToHeader } from "./tags";

export interface WysiwygSavePlan {
  /** The exact markdown to write: reattached header + edited body. */
  next: string;
  /** True when the tag set changed (the header differs after reattach). */
  tagsChanged: boolean;
  /** False when `next` equals the current on-disk body — skip the write. */
  shouldWrite: boolean;
}

/**
 * Reattach the stashed frontmatter header (applying any tag edits) to the edited
 * body and decide whether to write. `applyTagsToHeader` returns the header
 * byte-exact when the tag set is unchanged, so a differing header means the tags
 * changed. When the reattached content equals `currentBody`, the editor returned
 * the exact on-disk content and the write is skipped.
 */
export function planWysiwygSave(input: {
  header: string;
  editedBody: string;
  editTags: string[];
  originalTags: string[];
  currentBody: string;
}): WysiwygSavePlan {
  const header = applyTagsToHeader(
    input.header,
    input.editTags,
    input.originalTags,
  );
  const tagsChanged = header !== input.header;
  const next = header + input.editedBody;
  return { next, tagsChanged, shouldWrite: next !== input.currentBody };
}
