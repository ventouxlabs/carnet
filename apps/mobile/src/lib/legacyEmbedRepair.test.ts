// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { repairEmbedsAboveFrontmatter } from "./legacyEmbedRepair";
import { upsertFrontmatterField } from "./frontmatter";
import { mergeUserTags } from "./tags";
import { injectAttachments, type AttachmentRef } from "./writerMarkdown";

/** v0.11.0's injectImageEmbed, verbatim: with no H1 anywhere it put the embed
 * on top of the whole file — above the frontmatter. */
function v011InjectImageEmbed(markdown: string, rel: string): string {
  const embed = `![](${rel})`;
  const match = markdown.match(/^(#\s+.+?)(\r?\n|$)/m);
  if (!match) return `${embed}\n\n${markdown}`;
  const idx = match.index ?? 0;
  return `${markdown.slice(0, idx + match[1].length)}\n\n${embed}\n${markdown.slice(idx + match[0].length)}`;
}

/** v0.11.0's buildRawIdeaMarkdown / applyEnrichedIdea order: attachments,
 * then user tags, then location. Today's mergeUserTags/upsertFrontmatterField
 * still behave exactly as v0.11.0's on a file with no frontmatter on top,
 * which is how they prepended a second block. */
function v011Write(md: string, images: string[], tags: string[], location?: string): string {
  let out = [...images].reverse().reduce((acc, name) => v011InjectImageEmbed(acc, `../Photos/${name}`), md);
  out = mergeUserTags(out, tags);
  return location ? upsertFrontmatterField(out, "location", location) : out;
}

/** The same write today — the shape the repair must produce. */
function currentWrite(md: string, images: string[], tags: string[], location?: string): string {
  const refs = images.map((name): AttachmentRef => ({ kind: "image", rel: `../Photos/${name}`, filename: name }));
  let out = injectAttachments(md, refs);
  out = mergeUserTags(out, tags);
  return location ? upsertFrontmatterField(out, "location", location) : out;
}

const RAW =
  "---\ncreated: 2026-09-20T08:00:00.000Z\nstatus: pending-enrich\nrev: r1\n---\n" +
  "the ferns need water\n- [ ] buy compost\n";
const ENRICHED =
  "---\ncreated: 2026-09-20\nstatus: seedling\ntags: [plants]\n---\n" +
  "Ferns need water weekly.\n";
const LOCATION = "48.85660,2.35220";

describe("repairEmbedsAboveFrontmatter", () => {
  it("moves an embed above the frontmatter to where today's write puts it", () => {
    const broken = v011Write(RAW, ["a.jpg"], []);
    expect(broken.startsWith("![](../Photos/a.jpg)\n\n---\n")).toBe(true);
    expect(repairEmbedsAboveFrontmatter(broken)).toBe(currentWrite(RAW, ["a.jpg"], []));
  });

  it("keeps several embeds in their order", () => {
    const broken = v011Write(RAW, ["a.jpg", "b.jpg"], []);
    expect(repairEmbedsAboveFrontmatter(broken)).toBe(currentWrite(RAW, ["a.jpg", "b.jpg"], []));
  });

  it("folds the tags and location v0.11.0 put in a second block on top into the real frontmatter", () => {
    const broken = v011Write(RAW, ["a.jpg"], ["garden", "weekend"], LOCATION);
    // Two blocks: the user's fields first, so the raw note's status is unreadable.
    expect(broken.startsWith("---\ntags: [garden, weekend]\nlocation: 48.85660,2.35220\n---\n![](")).toBe(true);
    expect(repairEmbedsAboveFrontmatter(broken)).toBe(
      currentWrite(RAW, ["a.jpg"], ["garden", "weekend"], LOCATION),
    );
  });

  it("handles a second block holding only a location", () => {
    const broken = v011Write(RAW, ["a.jpg"], [], LOCATION);
    expect(repairEmbedsAboveFrontmatter(broken)).toBe(currentWrite(RAW, ["a.jpg"], [], LOCATION));
  });

  it("merges the user's tags with the model's on an enriched note whose reply had no H1", () => {
    const broken = v011Write(ENRICHED, ["a.jpg"], ["garden"], LOCATION);
    const repaired = repairEmbedsAboveFrontmatter(broken);
    expect(repaired).toBe(currentWrite(ENRICHED, ["a.jpg"], ["garden"], LOCATION));
    expect(repaired).toContain("tags: [plants, garden]");
  });

  it("drops the leading copy when the body already embeds the same image", () => {
    const fixed = currentWrite(RAW, ["a.jpg"], []);
    expect(repairEmbedsAboveFrontmatter(`![](../Photos/a.jpg)\n\n${fixed}`)).toBe(fixed);
  });

  it.each([
    ["a well-formed note", currentWrite(RAW, ["a.jpg"], ["garden"], LOCATION)],
    ["a note with no frontmatter", "![](../Photos/a.jpg)\n\nJust prose.\n"],
    ["a thematic break, not frontmatter", "![](../Photos/a.jpg)\n\nIntro\n---\nMore\n"],
    ["an unclosed --- block", "![](../Photos/a.jpg)\n\n---\ncreated: x\nno close\n"],
    ["a remote image", `![](https://example.com/a.png)\n\n${RAW}`],
    ["an embed with alt text (not a shape v0.11.0 wrote)", `![a](../Photos/a.jpg)\n\n${RAW}`],
    [
      "a top block with keys v0.11.0 never prepended",
      `---\nproject: allotment\n---\n![](../Photos/a.jpg)\n\n${RAW}`,
    ],
  ])("leaves %s byte-identical", (_label, markdown) => {
    expect(repairEmbedsAboveFrontmatter(markdown)).toBe(markdown);
  });
});
