/**
 * Resolve a note's relative `../Photos/<file>` embed to an inline `data:` URI
 * the WYSIWYG editor can render (it loads at https://localhost/, where the
 * relative link can't resolve). The corruption-prone string surgery lives in
 * the pure ./editorImages module; this thin wrapper just does the disk read it
 * can't (native FileSystem), so it stays out of the unit tests.
 *
 * Returns null — caller leaves the embed canonical (shows broken, never corrupt)
 * — when the path isn't a Photos embed, the file is missing on disk, or the
 * image is larger than MAX_EDITOR_IMAGE_BASE64 (too big to inline into the DOM
 * and the bridge message; it still saves + renders in the read-only detail view).
 */

import * as FileSystem from "expo-file-system/legacy";

import { MAX_EDITOR_IMAGE_BASE64, toDataUri } from "./editorImages";
import { resolvePairedUri } from "./writer";
import type { Root } from "./vaultRoot";

const { StorageAccessFramework } = FileSystem;

export async function resolvePhotoDataUri(
  rel: string,
  rootOverride?: Root,
): Promise<string | null> {
  const match = rel.match(/^\.\.\/Photos\/(.+)$/);
  if (!match) return null;
  const filename = match[1];

  const resolved = rootOverride
    ? await resolvePairedUri("Photos", filename, rootOverride)
    : await resolvePairedUri("Photos", filename);
  if (!resolved) return null;

  // content:// (SAF) and file:// read through different APIs — same split the
  // writer's binary reader uses, derived from the resolved URI scheme.
  const isSaf = resolved.uri.startsWith("content://");
  const base64 = isSaf
    ? await StorageAccessFramework.readAsStringAsync(resolved.uri, {
        encoding: FileSystem.EncodingType.Base64,
      })
    : await FileSystem.readAsStringAsync(resolved.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

  if (base64.length > MAX_EDITOR_IMAGE_BASE64) return null;
  return toDataUri(resolved.mime, base64);
}
