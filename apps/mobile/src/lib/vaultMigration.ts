/**
 * One-time sweep that moves pre-vault captures into a newly-picked vault
 * folder (issue #172).
 *
 * On a fresh install, captures save to the app-sandbox root
 * ({@link internalVaultRoot}) until the user picks a real (SAF or file://)
 * vault folder in Settings. Notes written before that moment used to stay
 * stranded there forever — {@link resolveRoot} only ever reads the CURRENT
 * `captureFolderPath`, so nothing re-visits the old root once it changes.
 * {@link migratePreVaultNotes} enumerates every canonical note under the
 * internal root, copies each (and any paired binary it references) into the
 * just-picked vault with collision-safe naming, and deletes the internal
 * copy only after the copy is verified on disk.
 *
 * Day-file decision: a same-day Journal collision in the target is
 * COLLISION-SUFFIXED (`2026-08-18-2.md`), not merged via appendJournal.
 * appendJournal stamps a `## HH:MM` heading from the CURRENT time (migration
 * time, not capture time) and drops everything but tags/location from the
 * appended entry's frontmatter — semantically wrong for a bulk migration.
 * Collision-suffixing loses nothing and keeps every note's bytes untouched,
 * which is what the byte-identical-frontmatter constraint calls for anyway.
 *
 * Every note is copied byte-for-byte EXCEPT when a paired binary it
 * references collides with an existing target file: the binary itself is
 * still copied (under a collision-bumped name), and the note body's
 * `../{subdir}/{name}` link is rewritten to match via a targeted substring
 * replace — never a frontmatter rewrite, never a full re-serialize.
 *
 * Recents history (AsyncStorage, keyed by filepath — storage.ts) is repointed
 * to each note's new URI right after its migration succeeds, so a Recents row
 * surviving from before the vault was picked doesn't read as broken. The
 * remap is best-effort and isolated per note: it cannot fail the migration
 * itself (the note move is the half that matters — see migratePreVaultNotes).
 */

import { internalVaultRoot, resolveRoot, type Root } from "./vaultRoot";
import {
  listNoteFilesInRoot,
  readNote,
  writeUniqueFile,
  type NoteFileRef,
} from "./writer";
import { listPairedBinaries } from "./pairedBinaries";
import { updateCaptureFilepath } from "./storage";

export interface MigrationFailure {
  subdir: NoteFileRef["subdir"];
  name: string;
  error: string;
}

export interface MigrationResult {
  /** Notes successfully copied into the target vault and removed from the
   * internal root. */
  migrated: number;
  /** Notes left in place after a failed copy or verification — see
   * `failures` for why. Never silently dropped. */
  failed: number;
  failures: MigrationFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Split a filename into `{stem, ext}` — `ext` includes the leading dot, or
 * is "" for an extensionless name. Mirrors the convention every writer.ts
 * new-file path already uses. */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" };
}

/**
 * Copy every paired binary a note body references from `source` into
 * `target`, collision-bumping the filename when the target already has one
 * by that name. Returns the possibly-rewritten body (only the renamed
 * links change) plus the source URIs actually copied, so the caller can
 * delete them once the note write itself is verified.
 *
 * A referenced binary missing from `source` is a pre-existing broken link
 * (matches writer.ts's moveToArchive behavior) — left as-is, not an error.
 */
async function migratePairedBinaries(
  content: string,
  source: Root,
  target: Root,
): Promise<{ content: string; copiedSourceUris: string[] }> {
  let rewritten = content;
  const copiedSourceUris: string[] = [];

  for (const pb of listPairedBinaries(content)) {
    const sourceSubdirUri = await source.fs.findSubdir(source.uri, pb.subdir);
    if (!sourceSubdirUri) continue;
    const sourceBinUri = await source.fs.findChild(sourceSubdirUri, pb.filename);
    if (!sourceBinUri) continue; // broken link — accept the orphan, as elsewhere

    const base64 = await source.fs.readBinary(sourceBinUri);
    const targetSubdirUri = await target.fs.findOrCreateSubdir(target.uri, pb.subdir);
    const { stem, ext } = splitName(pb.filename);
    const { name: finalName } = await writeUniqueFile(
      targetSubdirUri,
      stem,
      ext,
      "application/octet-stream",
      target.fs,
      (uri) => target.fs.writeBinaryBytes(uri, base64),
    );

    if (finalName !== pb.filename) {
      // Collision forced a rename — retarget this link with a whole-note
      // substring replace (String.split/join over the FULL content, not a
      // frontmatter-aware edit). Safe today because app-written frontmatter
      // never contains a `../{subdir}/{filename}` path, so nothing in the
      // YAML block can match `pb.rel`. Accepted hazard: if `pb.rel` were a
      // strict prefix of another paired-binary link in the same note (e.g.
      // `../Photos/pic.jpg` and `../Photos/pic.jpg.bak`), this would also
      // corrupt the longer link's rewritten remainder — requires unusual
      // paired-binary naming this codebase's own writers never produce.
      rewritten = rewritten.split(pb.rel).join(`../${pb.subdir}/${finalName}`);
    }
    // Edge case (accepted, not fixed): if a SECOND note also references this
    // exact `../{subdir}/{filename}` binary, its own migration pass runs
    // this same lookup — but by then the first pass has already deleted the
    // source binary (see migratePreVaultNotes' post-verify cleanup), so its
    // `findChild` above returns null and that link is left unchanged. It
    // then resolves to whatever pre-existing file already sat at that name
    // in the target (the collision that triggered the rename in the first
    // place), not to the second note's own bytes. Needs BOTH a binary shared
    // across notes AND a target-name collision to trigger; narrow enough
    // that a fix (tracking cross-note binary moves) isn't worth the
    // complexity here.
    copiedSourceUris.push(sourceBinUri);
  }

  return { content: rewritten, copiedSourceUris };
}

/**
 * Migrate every pre-vault note (and its paired binaries) from the internal
 * app-sandbox root into whatever vault {@link resolveRoot} currently
 * resolves to. Safe to call any time — a no-op when the internal root has
 * no notes, or when it IS the currently-resolved root (nothing to migrate
 * into; guards against a self-copy-then-delete that would destroy data).
 *
 * Per-note failures never abort the sweep and never delete the source: a
 * note's internal copy is deleted ONLY after its target copy is written and
 * read back byte-identical (binaries are trusted on write-success — a
 * base64 read-back would double their memory footprint for no added safety
 * here, since a failed write already throws before reaching this point).
 */
export async function migratePreVaultNotes(): Promise<MigrationResult> {
  const source = internalVaultRoot();
  const target = await resolveRoot();

  if (source.uri === target.uri) {
    return { migrated: 0, failed: 0, failures: [] };
  }

  const notes = await listNoteFilesInRoot(source);
  let migrated = 0;
  const failures: MigrationFailure[] = [];

  for (const note of notes) {
    try {
      const original = await readNote(note.uri);
      const { content, copiedSourceUris } = await migratePairedBinaries(
        original,
        source,
        target,
      );

      const targetSubdirUri = await target.fs.findOrCreateSubdir(target.uri, note.subdir);
      const { stem, ext } = splitName(note.name);
      const { uri: targetUri } = await writeUniqueFile(
        targetSubdirUri,
        stem,
        ext,
        "text/markdown",
        target.fs,
        (uri) => target.fs.writeString(uri, content),
      );

      const readback = await target.fs.readString(targetUri);
      if (readback !== content) {
        throw new Error("Verification read-back did not match what was written");
      }

      // Only now — write verified — remove the internal originals.
      await source.fs.delete(note.uri);
      for (const binUri of copiedSourceUris) {
        try {
          await source.fs.delete(binUri);
        } catch {
          /* stray internal binary left behind; the vault copy is canonical */
        }
      }
      migrated++;

      // Best-effort: repoint any Recents entry at the note's new path. A
      // failure here (or no matching entry at all — most pre-vault notes were
      // never opened via a Recents-tracked capture) must not undo or fail the
      // migration that already succeeded above.
      try {
        await updateCaptureFilepath(note.uri, targetUri);
      } catch {
        /* Recents entry stays stale; the note itself is safely migrated */
      }
    } catch (error) {
      failures.push({ subdir: note.subdir, name: note.name, error: errorMessage(error) });
    }
  }

  return { migrated, failed: failures.length, failures };
}
