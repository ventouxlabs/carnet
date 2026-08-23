// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Attachment plumbing for the note detail screen: resolving a note body's
 * paired binary links to device URIs, picking the image subset out for inline
 * markdown rendering, and handing a non-image file to the system share sheet.
 *
 * Split out of RecentDetailScreen so each step is unit-testable without a
 * renderer; the screen keeps only the effect that parks the result in state.
 */

import * as Sharing from "expo-sharing";

import type { ResolvedAttachment } from "../components/NoteAttachmentsCard";
import { listPairedBinaries, resolvePairedUri } from "./writer";

/**
 * Resolve every non-Audio paired binary linked from `body` to a storage URI.
 * Audio is excluded because the dedicated player renders it. Links that fail
 * to resolve are dropped, not surfaced — a note with one unreadable image
 * still renders.
 */
export async function resolveNoteAttachments(
  body: string,
): Promise<ResolvedAttachment[]> {
  const links = listPairedBinaries(body).filter((b) => b.subdir !== "Audio");
  const resolved: ResolvedAttachment[] = [];
  for (const link of links) {
    const r = await resolvePairedUri(link.subdir, link.filename);
    if (r) {
      resolved.push({
        rel: link.rel,
        filename: link.filename,
        uri: r.uri,
        mime: r.mime,
      });
    }
  }
  return resolved;
}

/**
 * Map each resolved IMAGE embed's relative link (`../Photos/x.jpg`) to its
 * device URI so the markdown renderer can draw it inline (see makeImageRule).
 * Non-image files stay out — they render as tappable rows in the files card.
 */
export function imageUrisByRel(
  attachments: readonly ResolvedAttachment[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of attachments) {
    if (a.mime.startsWith("image/")) m.set(a.rel, a.uri);
  }
  return m;
}

/**
 * Open a non-image attachment via the system share sheet. shareAsync wants a
 * file:// path; SAF content:// may not open on every device — surface the
 * failure rather than crash. (No-ops silently when sharing is unavailable.)
 */
export async function openAttachment(uri: string): Promise<void> {
  try {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri);
    }
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[RecentDetail] open attachment failed:", reason);
  }
}
