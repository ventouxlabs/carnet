/**
 * Local markdown writer for carnet v0.2+.
 *
 * Writes notes under the user-configured `captureFolderPath` setting, or
 * the app sandbox `${FileSystem.documentDirectory}carnet/` if unset.
 * Directory structure inside that root:
 *   Ideas/{slug}.md            — one file per idea
 *   Journal/YYYY-MM-DD.md      — daily journal, append-on-existing
 *   People/{Firstname-Lastname}.md — one file per contact
 *
 * Storage paths come in two flavors — `file://...` (expo-file-system legacy)
 * and `content://...tree/...` (Storage Access Framework). The per-backend
 * branching lives behind the `VaultFs` seam in ./vaultFs; a backend is selected
 * ONCE by resolveRoot in ./vaultRoot (or by fsForUri for a caller-supplied
 * URI) and this module calls its primitives, so the public API (writeIdea,
 * appendJournal, writePerson, readNote, updateNote) stays the same shape
 * callers depend on.
 *
 * This module owns file IO: collision-free naming, the note writers, the
 * guarded overwrite, note enumeration, and archiving. Logic that sits beside
 * it was extracted into focused siblings and is RE-EXPORTED from here, so the
 * `./writer` import path stays valid for every existing caller:
 *   ./vaultRoot       — root resolution / backend selection
 *   ./writerMarkdown  — pure markdown section + injection helpers
 *   ./pairedBinaries  — the `../{Photos|Audio|Files}/{name}` convention
 *   ./noteNaming      — slug / person-filename / title extraction
 */

import * as FileSystem from "expo-file-system/legacy";
import { fsForUri, safLastSegment, type VaultFs } from "./vaultFs";
import { resolveRoot, type Root } from "./vaultRoot";
// Pure predicate only — syncConflicts.ts stays filesystem-free, so this import
// cannot form a cycle (its NoteFileRef import back is type-only).
import { isSyncConflictName } from "./syncConflicts";
// Pure frontmatter helpers used internally; the full set is re-exported below.
import {
  extractFrontmatterField,
  getFrontmatterTags,
  setFrontmatterTags,
  stripFrontmatter,
  upsertFrontmatterField,
} from "./frontmatter";
// Helpers used internally by the writers below; both modules' public surfaces
// are re-exported at the bottom of this file.
import { listPairedBinaries, mimeFromFilename } from "./pairedBinaries";
import { extractH1, personFilename } from "./noteNaming";
import { toggleChecklistLine } from "./checklist";


/** Upper bound on collision-bumped filename variants ({stem}-2.md … {stem}-99.md).
 * If 99 variants are taken, the user has a real cleanup problem and we throw
 * rather than silently overwriting. Same ceiling for ideas / people / binaries. */
const MAX_COLLISION_VARIANTS = 100;

// safLastSegment (SAF URI → filename decoder) now lives in ./vaultFs alongside
// the backends that use it; re-exported below so importers of ./writer are
// unaffected.

/**
 * Resolve a collision-free filename of shape `{base}{ext}` or `{base}-N{ext}`.
 * Lists the directory once and probes against an in-memory Set so the SAF
 * backend doesn't pay one IPC round-trip per probe.
 */
async function findCollisionFreeName(
  parentUri: string,
  base: string,
  ext: string,
  fs: VaultFs,
): Promise<string> {
  const children = await fs.listChildren(parentUri);
  const existing = new Set(children.map((c) => c.name));
  const first = `${base}${ext}`;
  if (!existing.has(first)) return first;
  for (let n = 2; n < MAX_COLLISION_VARIANTS; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(
    `More than ${MAX_COLLISION_VARIANTS - 1} files with stem "${base}" — clean up duplicates first`,
  );
}

/** Create a new markdown file in `parentUri` with `filename` and write
 * `content`. Returns the URI of the new file (SAF may hand back a renamed URI,
 * but a `.md` name already carries the canonical extension, so it doesn't
 * here). Caller must guarantee `filename` is collision-free. */
async function writeNewFile(
  parentUri: string,
  filename: string,
  content: string,
  fs: VaultFs,
): Promise<string> {
  const fileUri = await fs.createFile(parentUri, filename, "text/markdown");
  await fs.writeString(fileUri, content);
  return fileUri;
}

/** Read a file by its URI (handles both file:// and content://). */
async function readByUri(uri: string): Promise<string> {
  return fsForUri(uri).readString(uri);
}

/** Overwrite a file by its URI. */
async function writeByUri(uri: string, content: string): Promise<void> {
  await fsForUri(uri).writeString(uri, content);
}

/** Write a base64-encoded binary into `parentUri/filename` (generic mime).
 * Used by the archive flow when relocating a paired binary. */
async function writeBinaryBytes(
  parentUri: string,
  filename: string,
  base64: string,
  fs: VaultFs,
): Promise<string> {
  const fileUri = await fs.createFile(parentUri, filename, "application/octet-stream");
  await fs.writeBinaryBytes(fileUri, base64);
  return fileUri;
}

// Frontmatter parse/serialize logic lives in ./frontmatter — a pure, native-free
// module so it can be unit-tested without mocks. Re-exported here so existing
// importers (RecentDetailScreen, CaptureScreen, tests) keep their `./writer`
// import path unchanged.
export {
  extractFrontmatterField,
  stripFrontmatter,
  splitFrontmatter,
  rewriteFrontmatterField,
} from "./frontmatter";

// SAF URI → filename decoder lives in ./vaultFs; re-exported so existing
// importers of ./writer (and the writer test suites) keep their import path.
export { safLastSegment } from "./vaultFs";

/**
 * Per-filepath promise chain. Used to serialize concurrent reads-then-writes
 * to the same file (the offline drain may process two journal entries for
 * the same day back-to-back; without serialization the second read sees
 * stale content and overwrites the first). Each entry resolves when the
 * last queued op for that path completes.
 */
const _writeChain = new Map<string, Promise<unknown>>();

/** Serialize work that touches `filepath`. Subsequent calls queue behind
 * any in-flight op on the same path. */
async function serialize<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeChain.get(filepath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _writeChain.set(filepath, next);
  try {
    return (await next) as T;
  } finally {
    if (_writeChain.get(filepath) === next) _writeChain.delete(filepath);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write an idea note. Slug is derived from the markdown H1.
 * Handles collision by appending -2, -3, etc. up to -99.
 */
export async function writeIdea(
  slug: string,
  markdown: string,
): Promise<{ filepath: string }> {
  const root = await resolveRoot();
  const ideasUri = await root.fs.findOrCreateSubdir(root.uri, "Ideas");
  const filename = await findCollisionFreeName(ideasUri, slug, ".md", root.fs);
  const filepath = await writeNewFile(ideasUri, filename, markdown, root.fs);
  return { filepath };
}

/**
 * Append a journal entry to today's file. If the file already exists, the new
 * entry's body (frontmatter stripped) is appended under a `## HH:MM` heading.
 *
 * Read-then-write is serialized per-filepath so two captures arriving in
 * quick succession (e.g. during an offline drain pass) don't both read the
 * same baseline and clobber each other.
 *
 * Returns the day file's full accumulated markdown (every same-day capture
 * merged, with this entry's tags unioned into the frontmatter) alongside its
 * filepath — callers that maintain the note/tag index must index off this,
 * not the just-written fragment, or earlier same-day tags are lost.
 */
export async function appendJournal(
  date: string,
  markdown: string,
): Promise<{ filepath: string; markdown: string }> {
  const root = await resolveRoot();
  const journalUri = await root.fs.findOrCreateSubdir(root.uri, "Journal");
  const filename = `${date}.md`;

  // Serialize per (journalUri + filename) so two concurrent appends to today's
  // file (e.g. an offline drain pass) don't read the same baseline and clobber.
  // The journalUri may be a content:// URI when SAF is in play; that's fine —
  // it's still unique per file.
  const lockKey = `${journalUri}/${filename}`;

  return serialize(lockKey, async () => {
    const existingUri = await root.fs.findChild(journalUri, filename);

    if (existingUri) {
      const existing = await readByUri(existingUri);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      // The appended entry's frontmatter is stripped (only the day file's first
      // block survives), so carry this entry's metadata into that block —
      // otherwise tags/location on a 2nd+ same-day capture would be silently lost.
      const newTags = getFrontmatterTags(markdown);
      let base = newTags.length
        ? setFrontmatterTags(existing, [...getFrontmatterTags(existing), ...newTags])
        : existing;
      // Tags accumulate (union); location is a scalar — a day file has one
      // frontmatter, so the latest same-day capture's location wins.
      const newLocation = extractFrontmatterField(markdown, "location");
      if (newLocation) base = upsertFrontmatterField(base, "location", newLocation);
      const appended = stripFrontmatter(markdown);
      const finalMarkdown = `${base.trimEnd()}\n\n## ${hhmm}\n\n${appended.trimStart()}`;
      await writeByUri(existingUri, finalMarkdown);
      return { filepath: existingUri, markdown: finalMarkdown };
    }

    const filepath = await writeNewFile(journalUri, filename, markdown, root.fs);
    return { filepath, markdown };
  });
}

/**
 * Write a person (contact) note. Filename derived from the `name:` frontmatter
 * field or the H1 title.
 *
 * Collision behavior: if a file with the same stem exists, the new note
 * lands as `{stem}-2.md`, `{stem}-3.md`, etc. up to -99. Same person
 * captured twice does NOT silently overwrite — Obsidian on desktop may
 * have edits we shouldn't destroy. The user can manually merge duplicates.
 */
export async function writePerson(
  firstName: string,
  lastName: string,
  markdown: string,
): Promise<{ filepath: string }> {
  const root = await resolveRoot();
  const peopleUri = await root.fs.findOrCreateSubdir(root.uri, "People");

  // Use provided names if non-empty; fall back to frontmatter/H1.
  let stem: string;
  if (firstName.trim() || lastName.trim()) {
    stem = personFilename(`${firstName} ${lastName}`.trim());
  } else {
    const fromFrontmatter = extractFrontmatterField(markdown, "name");
    const fromH1 = extractH1(markdown);
    const raw = fromFrontmatter ?? fromH1 ?? "Unknown Person";
    stem = personFilename(raw);
  }
  if (!stem) stem = "Unknown-Person";

  const filename = await findCollisionFreeName(peopleUri, stem, ".md", root.fs);
  const filepath = await writeNewFile(peopleUri, filename, markdown, root.fs);
  return { filepath };
}

/**
 * Write a UTF-8 sidecar below the vault root. This is intentionally separate
 * from note writers: callers use it for durable source material such as raw
 * OCR, not user-facing Obsidian notes. Like every new-file writer, a name
 * collision produces a numbered sibling instead of overwriting existing data.
 */
export async function writeTextFile(
  subdir: string,
  filename: string,
  content: string,
): Promise<{ filepath: string; finalName: string }> {
  const root = await resolveRoot();
  const dirUri = await root.fs.findOrCreateSubdir(root.uri, subdir);
  const dot = filename.lastIndexOf(".");
  const stem = dot >= 0 ? filename.slice(0, dot) : filename;
  const ext = dot >= 0 ? filename.slice(dot) : "";
  const finalName = await findCollisionFreeName(dirUri, stem, ext, root.fs);
  // Derive the MIME from the name rather than hardcoding text/plain: SAF's
  // createFileAsync appends the canonical extension for whatever MIME it is
  // given, so a `.md` record written as text/plain landed as `cap_x.md.txt`,
  // which mdcrm's `*.md`-only discovery never picks up.
  const filepath = await root.fs.createFile(dirUri, finalName, mimeFromFilename(finalName));
  await root.fs.writeString(filepath, content);
  return { filepath, finalName: root.fs.isSaf ? safLastSegment(filepath) || finalName : finalName };
}

/**
 * Save a binary file (e.g. an image shared into carnet) under `subdir`
 * with the given filename. base64-encoded content. Handles collision by
 * appending -2, -3, … like the markdown writers do. Returns the URI of
 * the written file.
 *
 * The two storage modes diverge here:
 *   - SAF: createFileAsync with the mime type, then writeAsStringAsync
 *     with base64 encoding.
 *   - file://: writeAsStringAsync with base64 encoding directly.
 */
export async function writeBinary(
  subdir: string,
  filename: string,
  base64: string,
  mimeType: string,
): Promise<{ filepath: string; finalName: string }> {
  const root = await resolveRoot();
  const dirUri = await root.fs.findOrCreateSubdir(root.uri, subdir);

  const dot = filename.lastIndexOf(".");
  const stem = dot >= 0 ? filename.slice(0, dot) : filename;
  const ext = dot >= 0 ? filename.slice(dot) : "";

  const finalName = await findCollisionFreeName(dirUri, stem, ext, root.fs);

  const filepath = await root.fs.createFile(dirUri, finalName, mimeType);
  await root.fs.writeBinaryBytes(filepath, base64);
  if (root.fs.isSaf) {
    // SAF may RENAME on create: DocumentsContract appends the mime-canonical
    // extension when the display name doesn't already end with it (observed
    // on-device 2026-07-14: requested `agenda-test.vnd.…document`, created
    // `agenda-test.vnd.…document.docx`). The caller links `finalName` in the
    // note body, so it MUST be the name SAF actually created — otherwise the
    // pairing silently breaks (attachment skipped on Karakeep export,
    // orphaned on archive). Derive it from the returned document URI.
    const created = safLastSegment(filepath);
    if (created) return { filepath, finalName: created };
  }
  return { filepath, finalName };
}

/** Read the raw string content of a note file. Supports both file:// and content:// URIs. */
export async function readNote(filepath: string): Promise<string> {
  return readByUri(filepath);
}

/** Overwrite a note file with new content. Supports both file:// and content:// URIs. */
export async function updateNote(filepath: string, markdown: string): Promise<void> {
  await writeByUri(filepath, markdown);
}

export type ChecklistUpdateResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "ambiguous" };

/**
 * Toggle one checklist line in a note by TEXT, not by position. Always reads
 * the file fresh (inside the same serialized call it writes from) and hands
 * that exact content to the pure toggleChecklistLine — the read IS the
 * write's baseline, so there is no separate staleness guard to maintain.
 * Serialized per-filepath so two toggles racing on the same file (or a
 * toggle racing an offline-drain write) don't interleave.
 */
export async function updateChecklistItem(
  filepath: string,
  text: string,
  expectedChecked: boolean,
): Promise<ChecklistUpdateResult> {
  return serialize(filepath, async () => {
    const current = await readByUri(filepath);
    const result = toggleChecklistLine(current, text, expectedChecked);
    if (!result.ok) return { ok: false, reason: result.reason };
    await writeByUri(filepath, result.markdown);
    return { ok: true };
  });
}

/**
 * Read a note file's last-modification time (epoch seconds) via getInfoAsync.
 * Returns null when the file doesn't exist, or when the backend can't report a
 * usable mtime — notably SAF `content://` URIs, which don't expose a reliable
 * modification time. A null baseline sends `updateNoteIfUnchanged` to its
 * content-comparison fallback; with no content snapshot either, the guard cannot
 * fire and cross-device edits resolve to Syncthing `*.sync-conflict-*.md` files
 * instead (see the capture-timing decision memo).
 *
 * This is the primitive the save-first Idea path and the promote-idea race
 * (TODO.md) both need: record it right after a write, re-check it before the
 * next overwrite.
 */
export async function getModificationTime(filepath: string): Promise<number | null> {
  if (filepath.startsWith("content://")) return null;
  try {
    const info = await FileSystem.getInfoAsync(filepath);
    if (!info.exists) return null;
    return typeof info.modificationTime === "number" ? info.modificationTime : null;
  } catch {
    return null;
  }
}

/** Result of a guarded overwrite. `reason: "conflict"` means the file changed
 * under us and the write was deliberately skipped (the on-disk version wins). */
export interface GuardedUpdateResult {
  ok: boolean;
  reason?: "conflict";
}

/**
 * Overwrite a note ONLY if it still looks the way the caller last saw it.
 *
 * Detects a user edit (or a synced workstation edit that already reached the
 * device) landing between when the caller recorded its baseline and this
 * overwrite. On a mismatch the write is skipped and `{ ok: false,
 * reason: "conflict" }` is returned so the caller can keep the existing version
 * and surface a banner instead of clobbering it.
 *
 * Two baselines, in priority order:
 *   - `expectedMtime` — the fast path (one stat, no file read). Used whenever
 *     the backend reports an mtime at all.
 *   - `expectedContent` — the SAF fallback. `getModificationTime` returns null
 *     for every `content://` URI, which is the NORMAL Android/Syncthing vault
 *     setup, so an mtime-only guard was dead code exactly where the vault is
 *     shared with a workstation. Comparing the file's current bytes against the
 *     snapshot taken alongside the (absent) mtime baseline restores the guard
 *     there: any intervening write changes the bytes.
 *
 * With neither baseline the guard cannot fire and the overwrite proceeds —
 * cross-device races then fall back to Syncthing conflict files, exactly as the
 * decision memo describes.
 */
export async function updateNoteIfUnchanged(
  filepath: string,
  markdown: string,
  expectedMtime: number | null,
  expectedContent?: string | null,
): Promise<GuardedUpdateResult> {
  if (expectedMtime !== null) {
    const current = await getModificationTime(filepath);
    if (current !== null && current !== expectedMtime) {
      return { ok: false, reason: "conflict" };
    }
  } else if (expectedContent != null) {
    let current: string;
    try {
      current = await readByUri(filepath);
    } catch {
      // Unreadable (permission revoked, file moved) — no baseline to compare, so
      // fall through to the write rather than refusing it. Same "can't verify →
      // proceed" stance the null-baseline case takes.
      current = expectedContent;
    }
    if (current !== expectedContent) {
      return { ok: false, reason: "conflict" };
    }
  }
  await writeByUri(filepath, markdown);
  return { ok: true };
}

/** Vault subdirs that hold markdown notes. Photos/Audio/Files hold binaries
 * and are deliberately excluded from note enumeration. */
const NOTE_SUBDIRS = ["Ideas", "Journal", "People"] as const;
export type NoteSubdir = (typeof NOTE_SUBDIRS)[number];

export interface NoteFileRef {
  /** Full readable URI (file:// path or SAF content:// document URI). */
  uri: string;
  /** Basename, e.g. "my-idea.md". */
  name: string;
  /** Which note subdir it came from. */
  subdir: NoteSubdir;
}

/** Enumerate every `.md` across the note subdirs, unfiltered. Internal — the
 * public listings split it into canonical notes vs Syncthing conflict copies. */
async function listNoteDirMarkdown(): Promise<NoteFileRef[]> {
  const root = await resolveRoot();
  const out: NoteFileRef[] = [];
  for (const subdir of NOTE_SUBDIRS) {
    const subdirUri = await root.fs.findOrCreateSubdir(root.uri, subdir);
    const entries = await root.fs.listChildren(subdirUri);
    for (const { uri, name } of entries) {
      if (name.toLowerCase().endsWith(".md")) {
        out.push({ uri, name, subdir });
      }
    }
  }
  return out;
}

/**
 * Enumerate every CANONICAL markdown note across the vault's note subdirs
 * (Ideas, Journal, People). Binaries (Photos/Audio/Files) are excluded, and so
 * are Syncthing `*.sync-conflict-*` copies — before that filter they were
 * indexed as regular notes, appearing in Search and inflating tag counts.
 * This is the source the tag index scans — Recents (AsyncStorage, max 20) is a
 * capture history, NOT a vault scan, so it cannot back tag enumeration.
 */
export async function listNoteFiles(): Promise<NoteFileRef[]> {
  return (await listNoteDirMarkdown()).filter((f) => !isSyncConflictName(f.name));
}

/**
 * Enumerate every `.md` note under an EXPLICIT root's note subdirs, unlike
 * {@link listNoteFiles} (which always reads the CURRENT `resolveRoot()`).
 * Used by vaultMigration.ts to enumerate the internal-storage root while
 * `resolveRoot()` points at the just-picked target vault.
 *
 * Deliberately does NOT reuse listNoteDirMarkdown's `findOrCreateSubdir` —
 * that CREATES the subdir on read, which would fabricate empty
 * Ideas/Journal/People folders inside a never-used internal root on a fresh
 * install (and make an "empty root → no migration" test lie). This uses the
 * read-only `findSubdir`, which returns null for an absent subdir instead.
 * Syncthing conflict copies are excluded, matching listNoteFiles' scope.
 */
export async function listNoteFilesInRoot(root: Root): Promise<NoteFileRef[]> {
  const out: NoteFileRef[] = [];
  for (const subdir of NOTE_SUBDIRS) {
    const subdirUri = await root.fs.findSubdir(root.uri, subdir);
    if (!subdirUri) continue; // subdir never created — nothing to enumerate
    const entries = await root.fs.listChildren(subdirUri);
    for (const { uri, name } of entries) {
      if (name.toLowerCase().endsWith(".md") && !isSyncConflictName(name)) {
        out.push({ uri, name, subdir });
      }
    }
  }
  return out;
}

/** Resolve a collision-free filename in `parentUri`. Exported so
 * vaultMigration.ts can place a copied note/binary in the target vault
 * without reinventing the numbered-suffix (`{stem}-2{ext}`) convention every
 * other writer in this module uses. */
export { findCollisionFreeName };

/** Enumerate the Syncthing conflict copies in the note subdirs — the review
 * surface's source (Home banner). Markdown only, matching listNoteFiles'
 * scope; binary-subdir conflicts are out of scope (see the plan). */
export async function listSyncConflictFiles(): Promise<NoteFileRef[]> {
  return (await listNoteDirMarkdown()).filter((f) => isSyncConflictName(f.name));
}

/**
 * Soft-delete a note. Copies the .md (and any paired binary referenced by a
 * relative `../{Photos|Audio|Files}/{name}.{ext}` link in the body) into the
 * vault's `Archive/` subdir with collision-bumped names, then removes the
 * originals. Used by RecentDetail's Delete button so a misfire can be
 * recovered by browsing the vault in Obsidian.
 *
 * Returns the new .md path plus the archived binary paths. `archivedBinaryPath`
 * is the FIRST archived binary (kept for back-compat with single-binary
 * callers); `archivedBinaryPaths` lists all of them. Both are empty/null when
 * the body has no recognized relative link or every link's target was missing
 * on disk (broken link from a prior external edit — archive the .md, accept
 * the orphan).
 *
 * Multi-binary: every `../{Photos|Audio|Files}/{name}` link in the body is
 * followed. Legacy notes (photo, share-image, share-audio, share-file) carry
 * exactly one; capture-with-attachments notes can carry several.
 *
 * Delete failures (SAF revoked the tree permission, file already gone) are
 * swallowed — the archive copy succeeded and is the source of truth for
 * recovery; the stranded original is acceptable.
 */
export async function moveToArchive(
  filepath: string,
): Promise<{
  archivedMdPath: string;
  archivedBinaryPath: string | null;
  archivedBinaryPaths: string[];
}> {
  const root = await resolveRoot();
  const archiveUri = await root.fs.findOrCreateSubdir(root.uri, "Archive");

  const content = await readByUri(filepath);

  // Build collision-free archive name for the .md. The URI's raw last path
  // segment is only the filename on file:// paths — a SAF document URI ends in
  // the URL-ENCODED document id (primary%3Acarnet%2FIdeas%2Fnote.md), which
  // used to archive verbatim as the display name (observed on-device
  // 2026-07-16). safLastSegment decodes SAF ids to the real filename.
  const mdName = filepath.startsWith("content://")
    ? safLastSegment(filepath)
    : (filepath.split("/").pop() ?? "note.md");
  const mdDot = mdName.lastIndexOf(".");
  const mdStem = mdDot >= 0 ? mdName.slice(0, mdDot) : mdName;
  const mdExt = mdDot >= 0 ? mdName.slice(mdDot) : ".md";
  const mdArchiveName = await findCollisionFreeName(
    archiveUri,
    mdStem,
    mdExt,
    root.fs,
  );
  const archivedMdPath = await writeNewFile(
    archiveUri,
    mdArchiveName,
    content,
    root.fs,
  );

  // Archive every paired binary referenced by the body (each resolvable one).
  // The filename class in PAIRED_BINARY_LINK rejects `/`, so a crafted
  // `[x](../Photos/../../secret)` link can't traverse out of the subdir — this
  // is defense-in-depth; today's writers emit slugified ASCII names.
  const archivedBinaryPaths: string[] = [];
  const binaryOriginals: string[] = [];
  for (const pb of listPairedBinaries(content)) {
    const subdirUri = await root.fs.findOrCreateSubdir(root.uri, pb.subdir);
    const binUri = await root.fs.findChild(subdirUri, pb.filename);
    if (!binUri) continue; // broken link — archive the .md, accept the orphan
    const binDot = pb.filename.lastIndexOf(".");
    const binStem = binDot >= 0 ? pb.filename.slice(0, binDot) : pb.filename;
    const binExt = binDot >= 0 ? pb.filename.slice(binDot) : "";
    const binArchiveName = await findCollisionFreeName(
      archiveUri,
      binStem,
      binExt,
      root.fs,
    );
    const binBase64 = await root.fs.readBinary(binUri);
    const archived = await writeBinaryBytes(
      archiveUri,
      binArchiveName,
      binBase64,
      root.fs,
    );
    archivedBinaryPaths.push(archived);
    binaryOriginals.push(binUri);
  }

  // Best-effort delete of the originals — see jsdoc.
  try {
    await root.fs.delete(filepath);
  } catch {
    /* leave the original; archive copy is canonical */
  }
  for (const orig of binaryOriginals) {
    try {
      await root.fs.delete(orig);
    } catch {
      /* leave the original binary */
    }
  }

  return {
    archivedMdPath,
    archivedBinaryPath: archivedBinaryPaths[0] ?? null,
    archivedBinaryPaths,
  };
}

// The markdown-body helpers (section upsert, image/attachment/place injection)
// live in ./writerMarkdown — pure string transforms, no filesystem. Re-exported
// so importers of ./writer keep their import path unchanged.
export {
  upsertSection,
  injectImageEmbed,
  injectAttachments,
  injectPlaces,
  type AttachmentRef,
  type Place,
} from "./writerMarkdown";

// The paired-binary convention (`../{Photos|Audio|Files}/{name}` links and the
// readers/resolvers that follow them) lives in ./pairedBinaries. Re-exported
// for the same reason.
export {
  extFromMime,
  mimeFromFilename,
  listPairedBinaries,
  resolvePairedUri,
  stripPairedBinaryLinks,
  readPairedBinaryUri,
  readPairedBinaryFromNote,
  type PairedBinary,
} from "./pairedBinaries";

// Slug / person-filename / title extraction lives in ./noteNaming.
export { slugify, personFilename, extractNameFromMarkdown } from "./noteNaming";
