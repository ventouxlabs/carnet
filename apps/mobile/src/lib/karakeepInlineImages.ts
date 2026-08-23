// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

// Rewrite a note body's `![alt](../Photos/x.jpg)` image embeds to their Karakeep
// asset URLs (`![alt](/api/assets/{id})`) so they render INLINE in the bookmark
// body — instead of the vault-relative link, which is dead outside the vault.
//
// Karakeep-export-only: the result is the text POSTed to the bookmark. The VAULT
// note keeps its `../Photos/` links untouched (Carnet + Obsidian resolve those;
// no base64 ever reaches disk — issue #43). Pure + unit-testable; the caller
// builds the `rel → assetUrl` map after uploading each image (see karakeepExport
// + karakeep.assetContentPath).

/** Canonical `../Photos/<file>` embed as carnet writes it, with an optional
 * markdown title (caption) we must preserve. Mirrors editorImages.PHOTO_EMBED:
 * `[^)"\s]` for the path rejects `)`, `"`, and whitespace so the title (if any)
 * is captured separately and a bare embed still matches. */
const PHOTO_EMBED =
  /!\[([^\]]*)\]\(\s*(\.\.\/Photos\/[^)"\s]+)\s*(?:"([^"]*)")?\s*\)/g;

/**
 * Replace each `../Photos/` image embed whose relative path is present in
 * `assetUrlByRel` with the mapped asset URL, preserving the alt text and any
 * caption title. An embed whose rel is NOT in the map (a failed/skipped upload,
 * or a broken link) is left UNCHANGED — Karakeep can't render the relative link,
 * but leaving it is strictly safer than emitting a dangling `/api/assets/`. Only
 * `../Photos/` embeds are touched; `../Files/` / `../Audio/` and external images
 * never match.
 *
 * Pure: returns a new string, mutates nothing. Idempotent on a body that has no
 * remaining `../Photos/` embeds (e.g. one already rewritten).
 */
export function rewriteImageEmbedsToAssetUrls(
  body: string,
  assetUrlByRel: ReadonlyMap<string, string>,
): string {
  return body.replace(
    PHOTO_EMBED,
    (whole: string, alt: string, rel: string, title: string | undefined) => {
      const url = assetUrlByRel.get(rel);
      if (!url) return whole;
      return title ? `![${alt}](${url} "${title}")` : `![${alt}](${url})`;
    },
  );
}
