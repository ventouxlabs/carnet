/**
 * The paired-binary convention: a note's markdown body references its binaries
 * by the relative link `../{Photos|Audio|Files}/{name}`, and the bytes live in
 * that sibling subdir of the vault root.
 *
 * Everything that reads, resolves, or strips those links lives here — link
 * enumeration (listPairedBinaries), URI resolution against the active vault
 * root (resolvePairedUri and the two readPairedBinary* readers), display-time
 * stripping (stripPairedBinaryLinks), plus the MIME↔extension mapping the
 * writers and readers share. The WRITE side (writeBinary, moveToArchive) stays
 * in writer.ts, which imports from here.
 */

import { fsForUri } from "./vaultFs";
import { resolveRoot, type Root } from "./vaultRoot";
import { mimeFromFilename } from "./mimeTypes";
import { pairedMarkdownLinks } from "./pairedMarkdownLinks";

// The MIME<->extension mapping lives in ./mimeTypes — pure, shared beyond the
// paired-binary convention. Re-exported so importers of ./pairedBinaries (and
// ./writer, which re-exports this module) keep their import path unchanged.
export { extFromMime, mimeFromFilename } from "./mimeTypes";

type PairedSubdir = "Photos" | "Audio" | "Files";

export interface PairedBinary {
  subdir: PairedSubdir;
  filename: string;
  /** `../{subdir}/{filename}` — the exact link text found in the body. */
  rel: string;
}

/**
 * List every paired binary referenced by a note body (`../{Photos|Audio|Files}/
 * {name}`), de-duplicated by relative path. Replaces the single-`.match()`
 * lookups so a capture with several attachments archives/renders all of them.
 */
export function listPairedBinaries(body: string): PairedBinary[] {
  const out: PairedBinary[] = [];
  const seen = new Set<string>();
  for (const link of pairedMarkdownLinks(body)) {
    const { rel, subdir, filename } = link;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({ subdir, filename, rel });
  }
  return out;
}

/**
 * Resolve a paired binary's storage URI + inferred MIME without reading bytes.
 * Returns null when the file isn't on disk (a broken link from an external
 * rename/move). Factored out of readPairedBinaryUri so RecentDetail's
 * Attachments card can resolve many links, while the single-match callers keep
 * their friendly throw-on-missing contract.
 */
export async function resolvePairedUri(
  subdir: string,
  filename: string,
  rootOverride?: Root,
): Promise<{ uri: string; mime: string } | null> {
  const root = rootOverride ?? await resolveRoot();
  const subdirUri = await root.fs.findSubdir(root.uri, subdir);
  if (!subdirUri) return null; // subdir absent — broken link, don't create it
  const binaryUri = await root.fs.findChild(subdirUri, filename);
  if (!binaryUri) return null;
  return { uri: binaryUri, mime: mimeFromFilename(filename) };
}

/**
 * Strip paired-binary embeds/links from a body for display. RecentDetail now
 * renders attachments in a dedicated card (images inline, files as tappable
 * rows), so the raw `![](../Photos/x)` / `[name](../Files/x)` markdown — which
 * the renderer can't resolve anyway — is removed to keep the prose clean.
 *
 * Only whole-line embeds/links are removed (an inline `[see this](../Files/x)`
 * mid-sentence is left intact). A `## File` / `## Files` heading whose only
 * content was the stripped link is dropped too, so no empty heading is left
 * behind. Display-only — callers keep the original body for playback,
 * transcription, re-enrich, and edit.
 */
export function stripPairedBinaryLinks(
  body: string,
  opts?: { keepImages?: boolean },
): string {
  // With `keepImages`, leave `../Photos/` image embeds in the prose so the
  // detail view can render them INLINE (a custom markdown image rule resolves
  // each to a device URI); only Audio (dedicated player) and Files (tappable
  // rows) are pulled out. Default — no opts — strips all three, as before.
  const linksByStart = new Map(pairedMarkdownLinks(body).map(link => [link.start, link]));
  let offset = 0;
  // Parse once with the complete body so fenced examples retain their context.
  const kept = body.split("\n").filter(line => {
    const start = offset + line.length - line.trimStart().length;
    const end = offset + line.trimEnd().length;
    offset += line.length + 1;
    const link = linksByStart.get(start);
    return !link || link.end !== end || (opts?.keepImages && link.subdir === "Photos");
  });

  // Pass 2: drop a "## File"/"## Files" heading left with no body content.
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const trimmed = kept[i].trim();
    if (trimmed === "## File" || trimmed === "## Files") {
      let hasContent = false;
      for (let j = i + 1; j < kept.length; j++) {
        const next = kept[j].trim();
        if (next === "") continue;
        if (next.startsWith("# ") || next.startsWith("## ")) break;
        hasContent = true;
        break;
      }
      if (!hasContent) continue;
    }
    out.push(kept[i]);
  }

  // Collapse the blank-line runs left by removals; keep a single trailing \n.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "\n");
}

/**
 * Locate the paired binary referenced by a note's body and return its URI
 * + filename + inferred MIME — WITHOUT reading the bytes. Used by the
 * RecentDetail audio player which streams the file via expo-av's
 * Audio.Sound (it accepts a URI directly). Cheaper than
 * readPairedBinaryFromNote for the playback path — no base64 round-trip
 * through JS heap for a 10MB audio file just to hand it to the player.
 *
 * Returned URI is the raw storage URI (file:// or content://) — Audio.Sound
 * handles file:// directly on Android. For content:// SAF URIs the
 * caller may need to first copy to a cache file (expo-av's SAF support is
 * version-dependent); cross that bridge when a SAF user reports playback
 * failing.
 *
 * Same error-message contract as readPairedBinaryFromNote — friendly text
 * for the two failure modes (no link found / target file missing).
 */
export async function readPairedBinaryUri(
  body: string,
  rootOverride?: Root,
): Promise<{ uri: string; mime: string; filename: string }> {
  const linkMatch = pairedMarkdownLinks(body)[0];
  if (!linkMatch) {
    throw new Error("No paired binary link found in note.");
  }
  const { subdir, filename } = linkMatch;
  const resolved = await resolvePairedUri(subdir, filename, rootOverride);
  if (!resolved) {
    throw new Error(`Paired binary not found: ${subdir}/${filename}`);
  }
  return { uri: resolved.uri, mime: resolved.mime, filename };
}

/**
 * Locate and read the paired binary referenced by a note's body (e.g. the
 * JPEG behind a photo/shared-image .md), returning the base64 payload and
 * the inferred MIME type. Used by RecentDetail's retro-enrich flow when the
 * raw image needs to be re-sent to the vision model days after capture.
 *
 * Resolves the first `../{Photos|Audio|Files}/<name>` link in `body`,
 * looks the file up in that subdir of the active vault root, and reads it
 * as base64. Path-traversal characters in the captured filename are
 * rejected by the shared Markdown destination parser.
 *
 * Throws with a friendly message when:
 *   - the body contains no recognized paired-binary link
 *   - the link target doesn't exist on disk (e.g. user moved or renamed
 *     the binary in Obsidian)
 *
 * Callers should surface the error in a banner — never overwrite the
 * existing note when this fails.
 */
export async function readPairedBinaryFromNote(
  body: string,
  rootOverride?: Root,
): Promise<{ base64: string; mime: string }> {
  const linkMatch = pairedMarkdownLinks(body)[0];
  if (!linkMatch) {
    throw new Error("No paired binary link found in note.");
  }
  const { subdir, filename } = linkMatch;
  const resolved = await resolvePairedUri(subdir, filename, rootOverride);
  if (!resolved) {
    throw new Error(`Paired binary not found: ${subdir}/${filename}`);
  }
  // The resolved URI's scheme is the same discriminator resolveRoot uses, so
  // pick the backend from the URI directly — this reader doesn't need the Root.
  const base64 = await fsForUri(resolved.uri).readBinary(resolved.uri);
  return { base64, mime: resolved.mime };
}
