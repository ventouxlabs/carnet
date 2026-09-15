/**
 * Recents-history mutation chaining for CaptureScreen's submit flow.
 *
 * Owns the one invariant this module exists to enforce: `recordCapture` and
 * `removeFromHistoryByFilepath` are both read-modify-write cycles over the
 * same AsyncStorage array, so two attempts racing (a submit and the Edit ->
 * resubmit it enables) would interleave and silently lose one side's write.
 * Split out of CaptureScreen.tsx as a move-only extraction so the chaining
 * logic is unit-testable against mocked lib/storage without a renderer; the
 * screen still owns the `recordCaptureRef` that threads one attempt's chain
 * into the next.
 */

import {
  recordCapture,
  removeFromHistoryByFilepath,
  type CaptureMode,
} from "./storage";

export interface ChainHistoryWriteInput {
  /** The previous submit attempt's own full history-mutation chain (its
   * optional removal plus its recordCapture), or null for the first attempt
   * in this screen. Awaited first so this attempt's read-modify-write can't
   * interleave with one still in flight. */
  priorWrite: Promise<void> | null;
  /** True on a resubmit that overwrites an existing note (Edit was tapped
   * and the raw note is already on disk) — its stale-titled history row is
   * removed before the fresh one is recorded. */
  resuming: boolean;
  filepath: string;
  mode: CaptureMode;
  title: string;
  id: string;
  createdAt: number;
  /** Profile selected when this capture attempt began. */
  profileId?: string;
}

/**
 * Chain this submit attempt's recents-history mutation after the previous
 * attempt's, so a resumed (Edit → resubmit) capture doesn't interleave its
 * read-modify-write with one already in flight — `recordCapture` prepends
 * unconditionally, so an interleaved write silently drops one side (a
 * duplicate row, or the stale-titled one resurrected).
 *
 * This can reject (e.g. AsyncStorage write failure) — callers are expected to
 * store a never-rejecting derivative (`.catch(() => undefined)`) as the next
 * `priorWrite` *before* awaiting this one, so a later attempt can always chain
 * off it regardless of whether this one succeeds.
 */
export async function chainHistoryWrite(input: ChainHistoryWriteInput): Promise<void> {
  await input.priorWrite;
  if (input.resuming) {
    await (input.profileId
      ? removeFromHistoryByFilepath(input.filepath, input.profileId)
      : removeFromHistoryByFilepath(input.filepath));
  }
  const entry = {
    id: input.id,
    mode: input.mode,
    title: input.title,
    filepath: input.filepath,
    createdAt: input.createdAt,
  };
  await (input.profileId ? recordCapture(entry, input.profileId) : recordCapture(entry));
}
