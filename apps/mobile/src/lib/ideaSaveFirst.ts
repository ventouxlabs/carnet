/**
 * Save-first Idea capture (Stage 2 / branch B4).
 *
 * The default Idea flow no longer blocks on the LLM before anything is written.
 * On Save, a deterministic client-side raw note lands on disk immediately
 * (status `pending-enrich`), and enrichment runs afterwards, updating the SAME
 * file in place — never renaming it (a rename is delete+create, which doubles
 * Syncthing churn and reopens collision handling). The in-place overwrite is
 * guarded by the writer.ts mtime check so a user/synced edit inside the enrich
 * window is kept instead of clobbered.
 *
 * Journal and Person are intentionally NOT routed through this module: Journal
 * keeps its deferred-write model and Person keeps enrich-then-preview. Only Idea
 * is save-first, and only when Settings.previewBeforeSave is off (the default).
 *
 * The pure builders (deriveRawIdeaSlug, buildRawIdeaMarkdown) plus the IO
 * functions (writeRawIdea, applyEnrichedIdea, enrichIdeaInPlace) are kept here,
 * out of the React screen, so the timing- and conflict-sensitive logic is unit
 * testable without a renderer.
 */

import {
  getModificationTime,
  injectAttachments,
  slugify,
  updateNote,
  updateNoteIfUnchanged,
  writeIdea,
  type AttachmentRef,
} from "./writer";
import type { Root } from "./vaultRoot";
import { preserveFrontmatterFields, upsertFrontmatterField } from "./frontmatter";
import { mergeUserTags } from "./tags";
import {
  enrichIdea,
  isInsecureTransportError,
  isNotConfiguredError,
  isPermanentError,
} from "./dispatcher";
import type { VaultContext } from "./vaultContext";

/** Frontmatter `status` value stamped on the raw note before enrichment lands.
 * Enrichment overwrites the whole note (including this) with the LLM result. */
export const PENDING_ENRICH_STATUS = "pending-enrich";

/** Frontmatter key holding the raw note's revision token. Transient: it only
 * exists while the note is `pending-enrich`, and enrichment replaces the whole
 * frontmatter block with the model's own, so it never reaches an enriched note. */
export const RAW_REV_FIELD = "rev";

/** Short-lived receipt marker for a Drive Inbox raw note. It makes a restarted
 * headless task locate the already-written raw capture instead of creating a
 * collision-suffixed duplicate. Completion occurs before enrichment, whose
 * replacement frontmatter deliberately removes this field. */
export const DRIVE_INBOX_RECEIPT_FIELD = "carnet_drive_inbox_receipt";

/**
 * A fresh revision token, regenerated on EVERY raw write.
 *
 * The Edit-during-enrichment escape hatch invalidates the in-flight enrichment
 * by rewriting the raw note, relying on updateNoteIfUnchanged to then see the
 * file as changed. On SAF vaults that guard has no mtime and compares raw bytes
 * — so a user who taps Edit before typing anything produced a byte-IDENTICAL
 * rewrite, no conflict was detected, and the enrichment they walked away from
 * landed anyway. Content equality cannot express "this file was written again";
 * this token can, because it changes even when nothing else does.
 *
 * Non-crypto by design, same generator shape as CaptureScreen's `localId` (RN
 * has no crypto.getRandomValues without a native polyfill). It is a change
 * detector, not an identifier: it needs to differ from the previous token, not
 * to be globally unique or unguessable. Time alone would not do — two writes
 * inside the same millisecond are exactly the Edit-then-resubmit case.
 */
function newRevToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The captured inputs a save-first Idea needs. Attachments are the post-write
 * rel-path references (binaries already on disk), matching the online + offline
 * paths so all three inject identically. */
export interface RawIdeaInput {
  /** The user's raw idea text — becomes the note body verbatim. */
  text: string;
  /** User-entered tags, merged into the frontmatter deterministically. */
  tags: string[];
  /** User-selected `lat,lon`, injected into frontmatter when set. */
  location?: string;
  attachments?: AttachmentRef[];
  /** Native Android Auto receipt; omitted for normal in-app/notification ideas. */
  receiptId?: string;
}

/**
 * Decide whether Idea capture uses the save-first path. Save-first is the
 * default; `previewBeforeSave` (a Settings flag) restores the old blocking
 * enrich → preview → Save flow. Journal and Person never call this.
 */
export function usesSaveFirst(previewBeforeSave: boolean): boolean {
  return !previewBeforeSave;
}

/**
 * Derive the on-disk slug for a save-first Idea from the RAW text. The polished
 * LLM title doesn't exist yet at write time, and the file is deliberately not
 * renamed on enrichment, so the slug reflects the raw text — the accepted price
 * of save-first (see the decision memo). Falls back to "idea" when the text
 * slugifies to nothing (e.g. emoji-only input).
 */
export function deriveRawIdeaSlug(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return slugify(firstLine.slice(0, 80)) || "idea";
}

/**
 * Build the deterministic client-side markdown written immediately on Save,
 * before any enrichment. Frontmatter carries `created` (ISO),
 * `status: pending-enrich` and `rev`; the body is the user's raw text verbatim.
 * User tags and location are injected the same way the enriched paths do, and
 * attachments are folded in so the transient note already references its
 * binaries.
 *
 * `created` and `rev` are deliberate opposites: `created` is pinned across an
 * Edit-and-resubmit (the capture moment did not change because the text was
 * edited), while `rev` MUST differ on every single call — see newRevToken.
 *
 * Pass `now`/`rev` for deterministic output in tests.
 */
export function buildRawIdeaMarkdown(
  input: RawIdeaInput,
  now: Date = new Date(),
  rev: string = newRevToken(),
): string {
  const body = input.text.trim();
  const receipt = input.receiptId?.trim();
  const receiptLine = receipt ? `${DRIVE_INBOX_RECEIPT_FIELD}: ${receipt}\n` : "";
  let md = `---\ncreated: ${now.toISOString()}\nstatus: ${PENDING_ENRICH_STATUS}\n${RAW_REV_FIELD}: ${rev}\n${receiptLine}---\n${body}\n`;
  // Order matches confirmSave: attachments first (so the tag/location merges see
  // the final body), then user tags, then location.
  md = injectAttachments(md, input.attachments ?? []);
  md = mergeUserTags(md, input.tags);
  if (input.location) md = upsertFrontmatterField(md, "location", input.location);
  return md;
}

export interface WriteRawIdeaResult {
  filepath: string;
  slug: string;
  /** mtime captured right after the raw write — the conflict-guard baseline for
   * the enriched overwrite. null when the backend can't report one (SAF). */
  mtime: number | null;
  /** The exact markdown written to disk — lets the caller upsert the note
   * index without re-reading the file (or rebuilding with a drifted `now`). */
  markdown: string;
}

/**
 * Write the raw Idea note to disk immediately and return its path plus the
 * mtime baseline for the guarded enriched overwrite. This is the save-first
 * write: it completes before enrichment is even attempted.
 */
export async function writeRawIdea(
  input: RawIdeaInput,
  now?: Date,
  root?: Root,
): Promise<WriteRawIdeaResult> {
  const slug = deriveRawIdeaSlug(input.text);
  const markdown = buildRawIdeaMarkdown(input, now);
  const { filepath } = root
    ? await writeIdea(slug, markdown, root)
    : await writeIdea(slug, markdown);
  const mtime = await getModificationTime(filepath);
  return { filepath, slug, mtime, markdown };
}

export interface RewriteRawIdeaInput extends RawIdeaInput {
  /** The already-on-disk note to overwrite — NOT re-derived from the text. */
  filepath: string;
}

export interface RewriteRawIdeaResult {
  filepath: string;
  /** Fresh baseline for the enriched overwrite that follows this rewrite. */
  mtime: number | null;
  markdown: string;
}

/**
 * Overwrite an EXISTING raw Idea note in place with a revised draft — the
 * edit-then-resubmit path, where the user tapped Edit while enrichment was in
 * flight and changed their text.
 *
 * Deliberately not `writeRawIdea`: that derives the slug from the text's first
 * line and goes through `writeIdea`, which collision-suffixes rather than
 * overwrites. Calling it again after an edit would leave the original
 * `pending-enrich` note orphaned beside a new `-2.md`.
 */
export async function rewriteRawIdea(
  input: RewriteRawIdeaInput,
  now?: Date,
): Promise<RewriteRawIdeaResult> {
  const markdown = buildRawIdeaMarkdown(input, now);
  await updateNote(input.filepath, markdown);
  const mtime = await getModificationTime(input.filepath);
  return { filepath: input.filepath, mtime, markdown };
}

export interface ApplyEnrichedIdeaInput {
  filepath: string;
  /** mtime baseline from writeRawIdea (or a fresh read before a manual re-enrich). */
  expectedMtime: number | null;
  /** The note's content at the moment `expectedMtime` was taken. Carries the
   * conflict guard on SAF vaults, where there is no mtime to compare — see
   * updateNoteIfUnchanged. */
  expectedContent?: string | null;
  /** Raw enriched markdown from enrichIdea — its own frontmatter + H1. */
  enrichedMarkdown: string;
  /** The note as it exists on disk, when that note may carry frontmatter the
   * user added by hand. Any field it has that the model's output does not is
   * carried over — see preserveFrontmatterFields. Omit for a note whose
   * frontmatter carnet wrote itself (the save-first raw stub): there is nothing
   * of the user's in it to preserve. */
  preserveFrontmatterFrom?: string;
  tags: string[];
  location?: string;
  attachments?: AttachmentRef[];
}

/** Fields preserveFrontmatterFields must keep its hands off.
 *
 * `rev` is the raw write's change detector and `status: pending-enrich` would
 * leave a just-enriched note showing a permanent pending chip — neither may
 * survive into an enriched note even when the model omits the field itself.
 *
 * `tags` belongs to mergeUserTags, which runs after this and merges the model's
 * tags with the user's. Preserving it first would overwrite the model's own
 * (block-form) tag list before that merge ever sees it. */
const NEVER_PRESERVED_FIELDS = [RAW_REV_FIELD, DRIVE_INBOX_RECEIPT_FIELD, "status", "tags"] as const;

/**
 * Overwrite the raw Idea note in place with the enriched result, preserving the
 * user's tags/location and keeping the exact same filename (no rename). Guarded
 * by the mtime check: if the file changed under us (a user edit or a synced
 * workstation edit), the enriched write is skipped and the user's version is
 * kept — `status: "conflict"`.
 */
export async function applyEnrichedIdea(
  input: ApplyEnrichedIdeaInput,
): Promise<{ status: "updated" | "conflict"; markdown: string }> {
  let md = input.preserveFrontmatterFrom
    ? preserveFrontmatterFields(
        input.enrichedMarkdown,
        input.preserveFrontmatterFrom,
        NEVER_PRESERVED_FIELDS,
      )
    : input.enrichedMarkdown;
  md = injectAttachments(md, input.attachments ?? []);
  md = mergeUserTags(md, input.tags);
  if (input.location) md = upsertFrontmatterField(md, "location", input.location);
  const result = await updateNoteIfUnchanged(
    input.filepath,
    md,
    input.expectedMtime,
    input.expectedContent,
  );
  return { status: result.ok ? "updated" : "conflict", markdown: md };
}

/** Everything enrichIdeaInPlace needs — the raw text plus the target file the
 * raw write already produced. */
export interface EnrichIdeaInPlaceInput {
  filepath: string;
  expectedMtime: number | null;
  /** Content baseline for SAF vaults — see ApplyEnrichedIdeaInput. */
  expectedContent?: string | null;
  /** See ApplyEnrichedIdeaInput. */
  preserveFrontmatterFrom?: string;
  text: string;
  tags: string[];
  location?: string;
  attachments?: AttachmentRef[];
  /** Vault selected for the raw write; its cached tags must accompany the
   * delayed enrichment even when another profile becomes active meanwhile. */
  vaultContext?: VaultContext;
}

/**
 * Outcome of the async enrichment that follows a save-first raw write.
 *   - updated:  enrichment succeeded and the note was overwritten in place.
 *   - conflict: the note changed during enrichment — the user's version is kept.
 *   - failed:   enrichment threw. `transient` distinguishes a network/5xx blip
 *               (caller should enqueue for a later drain) from a permanent 4xx /
 *               not-configured failure (caller keeps the raw note + shows the
 *               degraded banner). Either way the raw note is safe on disk.
 */
export type EnrichIdeaOutcome =
  /** `markdown` is the final on-disk content — callers use it to upsert the
   * note index so browse surfaces reflect the enriched note immediately. */
  | { kind: "updated"; markdown: string }
  | { kind: "conflict" }
  | { kind: "failed"; transient: boolean; reason: string };

/**
 * Enrich a save-first Idea and update its file in place. The raw note already
 * exists on disk (writeRawIdea ran first), so any failure here is recoverable:
 * the raw note stays, and the outcome tells the caller how to surface it.
 */
export async function enrichIdeaInPlace(
  input: EnrichIdeaInPlaceInput,
): Promise<EnrichIdeaOutcome> {
  let enriched: string;
  try {
    const result = await enrichIdea(input.text, { vaultContext: input.vaultContext });
    enriched = result.markdown;
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    // Not-configured + 4xx are permanent (no retry helps); everything else
    // (network / timeout / 5xx) is transient and safe to queue for a drain.
    // Insecure transport (a plain-http remote URL) joins the non-transient set:
    // it looks like a connection error but only a Settings change can fix it,
    // so queueing it would burn retries on a request that can never succeed.
    const transient =
      !isNotConfiguredError(e) && !isPermanentError(e) && !isInsecureTransportError(e);
    return { kind: "failed", transient, reason };
  }
  const applied = await applyEnrichedIdea({
    filepath: input.filepath,
    expectedMtime: input.expectedMtime,
    expectedContent: input.expectedContent,
    preserveFrontmatterFrom: input.preserveFrontmatterFrom,
    enrichedMarkdown: enriched,
    tags: input.tags,
    location: input.location,
    attachments: input.attachments,
  });
  return applied.status === "updated"
    ? { kind: "updated", markdown: applied.markdown }
    : { kind: "conflict" };
}
