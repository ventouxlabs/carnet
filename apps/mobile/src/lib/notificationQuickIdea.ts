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
  DRIVE_INBOX_RECEIPT_FIELD,
  enrichIdeaInPlace,
  writeRawIdea,
  type EnrichIdeaOutcome,
  type RawIdeaInput,
} from "./ideaSaveFirst";
import { getModificationTime, listNoteFilesInRoot, readNote } from "./writer";
import { extractFrontmatterField } from "./frontmatter";
import { recordCapture } from "./storage";
import { invalidateTagIndex } from "./vault";
import { enqueue } from "./queue";
import { getSettings } from "./settings";
import { captureVaultContext, isVaultContext, type VaultContext } from "./vaultContext";
import { resolveContextRoot } from "./vaultRoot";
import {
  completeDriveInboxReceipt,
  releaseDriveInboxReceiptForRetry,
} from "./captureNotification";

const DRIVE_INBOX_RECEIPT_RE = /^[a-f0-9-]{16,64}$/i;

/** Headless tasks share one JS runtime. Keep a same-receipt restart from
 * racing its marker scan and raw write while native resumes a pending handoff.
 * A process restart cannot overlap the original task; its durable marker then
 * supplies the cross-process idempotency boundary. */
const driveInboxTasks = new Map<string, Promise<QuickIdeaResult>>();

function isDriveInboxReceipt(value: unknown): value is string {
  return typeof value === "string" && DRIVE_INBOX_RECEIPT_RE.test(value);
}

/** Best-effort latch release after a failed Drive Inbox dispatch. Never let a
 * recovery call mask the write failure that caused it. */
async function releaseDriveInboxReceiptAfterFailure(receiptId: string): Promise<void> {
  try {
    await releaseDriveInboxReceiptForRetry(receiptId);
  } catch {
    // Native retains the receipt even when the release call itself fails; a
    // later service restart can retry it. The original error is more useful.
  }
}

/** Scan only the frozen receipt vault for the short-lived raw marker. A failed
 * scan is unsafe to treat as "not found": it would risk a duplicate note, so
 * callers fail closed and leave native's pending handoff retryable. */
async function findReceiptRawNote(receiptId: string, root: ReturnType<typeof resolveContextRoot>) {
  const files = await listNoteFilesInRoot(root);
  for (const file of files) {
    if (file.subdir !== "Ideas") continue;
    const markdown = await readNote(file.uri);
    if (extractFrontmatterField(markdown, DRIVE_INBOX_RECEIPT_FIELD) === receiptId) {
      return {
        filepath: file.uri,
        markdown,
        mtime: await getModificationTime(file.uri),
      };
    }
  }
  return null;
}

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
export async function handleQuickIdeaCapture(
  rawText: string,
  suppliedVaultContext?: unknown,
  receiptId?: unknown,
): Promise<QuickIdeaResult> {
  const receipt = isDriveInboxReceipt(receiptId) ? receiptId : undefined;
  if (!receipt) return handleQuickIdeaCaptureInner(rawText, suppliedVaultContext, receiptId);

  const active = driveInboxTasks.get(receipt);
  if (active) return active;

  const task = handleQuickIdeaCaptureInner(rawText, suppliedVaultContext, receiptId);
  driveInboxTasks.set(receipt, task);
  try {
    const result = await task;
    if (result.kind === "write-failed") {
      await releaseDriveInboxReceiptAfterFailure(receipt);
    }
    return result;
  } catch (error) {
    await releaseDriveInboxReceiptAfterFailure(receipt);
    throw error;
  } finally {
    if (driveInboxTasks.get(receipt) === task) driveInboxTasks.delete(receipt);
  }
}

async function handleQuickIdeaCaptureInner(
  rawText: string,
  /**
   * A receipt-time vault snapshot supplied by the native Android Auto action.
   * It is deliberately `unknown`: Headless JS task data crosses the native
   * bridge untyped, so validate it before it can route a filesystem write.
   */
  suppliedVaultContext?: unknown,
  /** Present only for native Drive Inbox pending handoffs. */
  receiptId?: unknown,
): Promise<QuickIdeaResult> {
  const text = (rawText ?? "").trim();
  if (text.length === 0) {
    // Empty-input no-op (required behavior): nothing written, nothing enriched.
    return { kind: "empty" };
  }

  const ctx: RawIdeaInput = { text, tags: [] };
  // The headless task can overlap a foreground profile switch. Capture the
  // root before any write or network await so its raw note, history, index
  // invalidation, and possible queued retry remain one coherent vault.
  const receiptWasSupplied = typeof receiptId === "string" && receiptId.trim().length > 0;
  const driveInboxReceipt = isDriveInboxReceipt(receiptId) ? receiptId : undefined;
  if (receiptWasSupplied && (!driveInboxReceipt || !isVaultContext(suppliedVaultContext))) {
    // A Drive Inbox reply must retain its native receipt-time routing. Never
    // substitute the currently active Settings profile for malformed bridge
    // data: that would silently send the capture to a different vault.
    return { kind: "write-failed", reason: "Drive Inbox vault context missing" };
  }

  let vaultContext: VaultContext | undefined;
  if (isVaultContext(suppliedVaultContext)) {
    // Android Auto's action service captured these values at receipt time.
    // Copy them instead of retaining the bridge payload, then use this one
    // context for the raw write, recents, tags, enrichment, and retry queue.
    // In particular, do NOT consult Settings here: the user may have switched
    // profiles after replying from the car.
    vaultContext = Object.freeze({
      profileId: suppliedVaultContext.profileId,
      rootUri: suppliedVaultContext.rootUri,
    });
  } else {
    try {
      vaultContext = captureVaultContext(await getSettings());
    } catch {
      // Keep generic quick-idea capture available if local settings is
      // transiently unreadable; writer/enqueue retain their existing default
      // fallbacks.
    }
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
    const root = vaultContext ? resolveContextRoot(vaultContext) : undefined;
    const existing = driveInboxReceipt && root
      ? await findReceiptRawNote(driveInboxReceipt, root)
      : null;
    if (existing) {
      filepath = existing.filepath;
      mtime = existing.mtime;
      rawMarkdown = existing.markdown;
    } else {
      const res = await writeRawIdea(
        driveInboxReceipt ? { ...ctx, receiptId: driveInboxReceipt } : ctx,
        undefined,
        root,
      );
      filepath = res.filepath;
      mtime = res.mtime;
      rawMarkdown = res.markdown;
    }
  } catch (e: unknown) {
    return { kind: "write-failed", reason: e instanceof Error ? e.message : String(e) };
  }

  if (driveInboxReceipt && !(await completeDriveInboxReceipt(driveInboxReceipt))) {
    // The raw note carries its receipt marker, so a future native retry can
    // find it and complete without a second write. Do not enrich yet: that
    // would remove the marker before native acknowledged the handoff.
    return { kind: "write-failed", reason: "Drive Inbox handoff not confirmed; retry pending" };
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
