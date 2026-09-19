/**
 * Staged-attachment persistence (extracted from CaptureScreen).
 *
 * Writes each staged attachment to the vault exactly once, at the commit moment
 * (confirmSave or enqueue), and returns the rel-path references to embed/queue —
 * so cancelling at preview never strands binaries on disk.
 *
 * Dedup is keyed by picked-attachment object identity via the caller-owned
 * `cache` WeakMap: a failed commit (writeIdea/enqueue threw) leaves `pending`
 * intact, and without the cache a retry would re-run writeBinary and — since
 * findCollisionFreeName never overwrites — strand the first write as an orphan
 * (`sketch.jpg` unreferenced, `sketch-2.jpg` linked). Keying by identity also
 * means removing an attachment between attempts drops it cleanly and a
 * newly-added one still gets written.
 */

import { slugify, writeBinary, extFromMime, type AttachmentRef } from "./writer";
import type { Root } from "./vaultRoot";
import type { PickedAttachment } from "./attachments";

/**
 * Write every staged attachment to the vault (once each, deduped through
 * `cache`) and return the rel-path references. Uses the collision-bumped
 * `finalName` for the link so it stays paired with the on-disk file.
 */
export async function persistAttachments(
  pending: readonly PickedAttachment[],
  cache: WeakMap<PickedAttachment, AttachmentRef>,
  root?: Root,
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const p of pending) {
    const cached = cache.get(p);
    if (cached) {
      refs.push(cached);
      continue;
    }
    const subdir = p.kind === "image" ? "Photos" : "Files";
    const ext = extFromMime(p.mime);
    const base = slugify(p.filename.replace(/\.[^.]+$/, "")) || "attachment";
    const { finalName } = root
      ? await writeBinary(subdir, `${base}.${ext}`, p.base64, p.mime, root)
      : await writeBinary(subdir, `${base}.${ext}`, p.base64, p.mime);
    const ref: AttachmentRef = {
      kind: p.kind,
      rel: `../${subdir}/${finalName}`,
      filename: finalName,
    };
    cache.set(p, ref);
    refs.push(ref);
  }
  return refs;
}
