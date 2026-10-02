// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read-time repair for the notes v0.11.0 wrote with their image embeds ABOVE
 * their frontmatter.
 *
 * v0.11.0's injectImageEmbed, given a note whose body had no H1, put each
 * embed on top of the whole file. The tag and location merges that ran next
 * then found no frontmatter there and prepended a block of their own. So a raw
 * Idea with a photo landed on disk in one of two shapes:
 *
 *     ![](../Photos/a.jpg)            ---
 *                                     tags: [garden]
 *     ---                             location: 48.85660,2.35220
 *     created: …                      ---
 *     status: pending-enrich          ![](../Photos/a.jpg)
 *     ---
 *     the ferns need water            ---
 *                                     created: …
 *                                     status: pending-enrich
 *                                     ---
 *                                     the ferns need water
 *
 * Either way `status: pending-enrich` is unreadable, so "Finish enrichment" is
 * never offered. The fix to injectImageEmbed (#222) stops new files getting
 * this shape; this repairs the old ones as they are read. Callers repair what
 * they READ — the file itself is only rewritten by a write that was happening
 * anyway, never by a sweep over a Syncthing-shared vault.
 *
 * Imports the pure markdown helpers directly rather than through ./writer,
 * which carries the filesystem.
 */

import {
  extractFrontmatterField,
  getFrontmatterTags,
  splitFrontmatter,
  upsertFrontmatterField,
} from "./frontmatter";
import { mergeUserTags } from "./tags";
import { injectImageEmbed } from "./writerMarkdown";

/** Exactly what v0.11.0 wrote: an optional prepended block holding only the
 * `tags`/`location` lines its merges add, then one `![](../Photos/{name})`
 * line and a blank line per image, then the real frontmatter's `---`. */
const LEGACY_EMBEDS_ABOVE_FRONTMATTER =
  /^(---\n(?:(?:tags|location): [^\n]*\n)+---\n)?((?:!\[\]\(\.\.\/Photos\/[^/\s)]+\)\n\n)+)(?=---)/;

/**
 * Repair a note v0.11.0 wrote with its image embeds above its frontmatter (see
 * above). The result is the note today's write path produces: embeds under the
 * body's H1 (else at the top of the body) in their order, without repeating
 * one the body already has, then the prepended block's tags merged into the
 * real frontmatter's and its location upserted — the attachments → tags →
 * location order of buildRawIdeaMarkdown and applyEnrichedIdea.
 *
 * Pure, and byte-identical for every other note: a leading embed followed by
 * prose, a thematic break, an unclosed `---` block, a remote image, an embed
 * with alt text, or a top block with any other key.
 */
export function repairEmbedsAboveFrontmatter(markdown: string): string {
  const match = LEGACY_EMBEDS_ABOVE_FRONTMATTER.exec(markdown);
  if (!match) return markdown;
  const rest = markdown.slice(match[0].length);
  if (!splitFrontmatter(rest).header) return markdown;

  const rels = [...match[2].matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  // Last first: each injection lands at the same spot, so the first embed
  // ends up on top — the same reversal injectAttachments uses.
  const md = rels.reduceRight((acc, rel) => injectImageEmbed(acc, rel), rest);

  const prepended = match[1];
  if (!prepended) return md;
  const withTags = mergeUserTags(md, getFrontmatterTags(prepended));
  const location = extractFrontmatterField(prepended, "location");
  return location ? upsertFrontmatterField(withTags, "location", location) : withTags;
}
