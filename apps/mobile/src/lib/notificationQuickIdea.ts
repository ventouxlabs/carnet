/**
 * Notification inline-reply quick-idea capture (Stage 2 / branch B5).
 *
 * The persistent capture notification (see plugins/withCaptureNotification.js)
 * carries a RemoteInput "Quick idea" action. When the user types a quick idea
 * and submits it, native code (QuickIdeaReceiver → QuickIdeaTaskService, a
 * HeadlessJsTaskService) starts the "CarnetQuickIdea" headless JS task with the
 * typed text — WITHOUT opening the app. That task calls the single entry point
 * below.
 *
 * This is the zero-app-open capture surface B4 unblocked: the notification
 * action can't block on the LLM, so it uses the exact save-first path the Idea
 * screen uses — write a raw note to disk immediately (status pending-enrich),
 * then enrich it in place asynchronously. On a transient enrichment failure the
 * capture is queued for the next drain, mirroring CaptureScreen.submit's
 * finishSaveFirst. The raw note is always safe on disk regardless of outcome.
 *
 * Kept out of any React screen so the headless (no-renderer) path is unit
 * testable. The disk-write / enrichment / mtime-guard internals are owned and
 * tested by ideaSaveFirst.ts; this module only orchestrates them for the
 * notification surface (empty-input guard, recents bookkeeping, and the
 * transient-failure enqueue).
 */

import { deriveTitle } from "@carnet/shared";
import {
  enrichIdeaInPlace,
  writeRawIdea,
  type EnrichIdeaOutcome,
  type RawIdeaInput,
} from "./ideaSaveFirst";
import { recordCapture } from "./storage";
import { invalidateTagIndex } from "./vault";
import { enqueue } from "./queue";
import { getSettings } from "./settings";
import { captureVaultContext, type VaultContext } from "./vaultContext";
import { resolveContextRoot } from "./vaultRoot";

/**
 * Outcome of handling a RemoteInput quick-idea submission. Every non-`empty`
 * and non-`write-failed` branch means the raw note is on disk; the variant only
 * describes what happened to enrichment. Returned (rather than swallowed) so the
 * headless task can log it and tests can assert the branch taken.
 */
export type QuickIdeaResult =
  | { kind: "empty" }
  | { kind: "write-failed"; reason: string }
  | { kind: "enriched" }
  | { kind: "conflict" }
  | { kind: "queued" }
  | { kind: "degraded"; reason: string };

/** Local-unique id for the recents row. Mirrors queue.ts/CaptureScreen's
 * localId — `crypto.randomUUID` isn't available under Hermes without a polyfill,
 * and a recents id only needs local uniqueness. */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Handle a RemoteInput quick-idea submission end-to-end from the headless task.
 *
 * Blank/whitespace-only input is a no-op — no note is written (the native
 * receiver also guards this; this is the defense-in-depth JS guard so a direct
 * task invocation with empty text can never create an empty note).
 */
export async function handleQuickIdeaCapture(rawText: string): Promise<QuickIdeaResult> {
  const text = (rawText ?? "").trim();
  if (text.length === 0) {
    // Empty-input no-op (required behavior): nothing written, nothing enriched.
    return { kind: "empty" };
  }

  const ctx: RawIdeaInput = { text, tags: [] };
  // The headless task can overlap a foreground profile switch. Capture the
  // root before any write or network await so its raw note, history, index
  // invalidation, and possible queued retry remain one coherent vault.
  let vaultContext: VaultContext | undefined;
  try {
    vaultContext = captureVaultContext(await getSettings());
  } catch {
    // Keep the notification capture available if local settings is transiently
    // unreadable; writer/enqueue retain their existing default fallbacks.
  }

  // Save-first write: the raw note lands on disk immediately, before any
  // enrichment is attempted. A failure here means nothing was saved.
  let filepath: string;
  let mtime: number | null;
  // The exact bytes just written. On SAF vaults (the normal Android/Syncthing
  // setup) `mtime` is always null, so this snapshot is the ONLY baseline the
  // conflict guard can compare — see writer.ts's updateNoteIfUnchanged.
  let rawMarkdown: string;
  try {
    const res = await writeRawIdea(
      ctx,
      undefined,
      vaultContext ? resolveContextRoot(vaultContext) : undefined,
    );
    filepath = res.filepath;
    mtime = res.mtime;
    rawMarkdown = res.markdown;
  } catch (e: unknown) {
    return { kind: "write-failed", reason: e instanceof Error ? e.message : String(e) };
  }

  // Recents + tag-index bookkeeping — best-effort, mirrors CaptureScreen's
  // save-first path. The note is on disk regardless, so a failure here must not
  // mask the successful capture.
  try {
    await recordCapture(
      {
        id: localId(),
        mode: "idea",
        title: deriveTitle(ctx.text) || "Idea",
        filepath,
        createdAt: Date.now(),
      },
      vaultContext?.profileId,
    );
  } catch {
    // ignore — recents is a convenience surface, not the source of truth.
  }
  void invalidateTagIndex(vaultContext?.profileId).catch(() => undefined);

  // Async enrichment, updating the note in place under the mtime guard.
  const outcome = await enrichIdeaInPlace({
    filepath,
    expectedMtime: mtime,
    expectedContent: rawMarkdown,
    text: ctx.text,
    tags: ctx.tags,
    location: ctx.location,
    attachments: ctx.attachments,
    vaultContext,
  });
  return finishQuickIdea(outcome, ctx, filepath, mtime, rawMarkdown, vaultContext);
}

/**
 * Map a save-first enrichment outcome onto a headless result, enqueuing the
 * capture for a later drain on a transient failure exactly as
 * CaptureScreen.finishSaveFirst does (there is no UI here to surface a banner,
 * so the queue is the only recovery path).
 */
async function finishQuickIdea(
  outcome: EnrichIdeaOutcome,
  ctx: RawIdeaInput,
  filepath: string,
  mtime: number | null,
  /** The raw note's bytes at the `mtime` baseline. Has to survive into the queue
   * row: the drain can run hours later, and on SAF it is the only guard there. */
  baselineContent: string,
  vaultContext?: VaultContext,
): Promise<QuickIdeaResult> {
  if (outcome.kind === "updated") return { kind: "enriched" };
  if (outcome.kind === "conflict") return { kind: "conflict" };
  // outcome.kind === "failed"
  if (outcome.transient) {
    try {
      await enqueue({
        mode: "idea",
        text: ctx.text,
        attachments: ctx.attachments,
        tags: ctx.tags,
        location: ctx.location,
        // The raw note already exists — the drain updates it in place instead of
        // writing a duplicate.
        filepath,
        baselineMtime: mtime,
        baselineContent,
        vaultContext,
      });
      return { kind: "queued" };
    } catch {
      // Queue write failed too — the raw note is still on disk (status
      // pending-enrich) and will be re-enrichable when the app next opens.
      return { kind: "queued" };
    }
  }
  // Permanent failure — the raw note stays; nothing to retry automatically.
  return { kind: "degraded", reason: outcome.reason };
}
