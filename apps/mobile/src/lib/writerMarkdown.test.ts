import { describe, expect, it } from "vitest";

import {
  upsertSection,
  injectImageEmbed,
  injectAttachments,
  injectPlaces,
  stripInjectedAttachments,
  type AttachmentRef,
  type Place,
} from "./writerMarkdown";
import { splitFrontmatter } from "./frontmatter";

// ── injectImageEmbed ──────────────────────────────────────────────────────────

describe("injectImageEmbed", () => {
  it("inserts embed under H1 with trailing newline", () => {
    const md = "# Title\n\nbody\n";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "# Title\n\n![](../Photos/a.jpg)\n\nbody\n",
    );
  });

  it("inserts embed under H1 even when H1 is the last line (no trailing newline)", () => {
    const md = "# Lonely Title";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "# Lonely Title\n\n![](../Photos/a.jpg)\n",
    );
  });

  it("inserts embed under H1 with CRLF line ending", () => {
    const md = "# Title\r\nbody\r\n";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "# Title\n\n![](../Photos/a.jpg)\nbody\r\n",
    );
  });

  it("prepends embed when no H1 is present", () => {
    const md = "no heading here\n\njust prose.\n";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "![](../Photos/a.jpg)\n\nno heading here\n\njust prose.\n",
    );
  });

  it("picks the first H1 when multiple are present", () => {
    const md = "# First\n\nbody\n\n# Second\n\nmore\n";
    const out = injectImageEmbed(md, "../Photos/a.jpg");
    expect(out.indexOf("![](../Photos/a.jpg)")).toBeLessThan(out.indexOf("# Second"));
    expect(out.indexOf("![](../Photos/a.jpg)")).toBeGreaterThan(out.indexOf("# First"));
  });

  it("ignores frontmatter and only matches body H1", () => {
    const md = "---\nkind: photo\n---\n# Body Title\n\nbody\n";
    const out = injectImageEmbed(md, "../Photos/a.jpg");
    expect(out).toContain("# Body Title\n\n![](../Photos/a.jpg)\n");
    // frontmatter preserved
    expect(out.startsWith("---\nkind: photo\n---\n")).toBe(true);
  });

  // The save-first raw stub has frontmatter and (usually) no H1. Prepending
  // the embed above `---` broke the frontmatter: the stub stopped reading as
  // pending-enrich, so Finish enrichment refused it.
  it("puts the embed at the start of the body — after the frontmatter — when the body has no H1", () => {
    const md = "---\ncreated: 2026-09-29\nstatus: pending-enrich\n---\nlook at this\n";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "---\ncreated: 2026-09-29\nstatus: pending-enrich\n---\n![](../Photos/a.jpg)\n\nlook at this\n",
    );
  });

  it("never merges the embed into a closing fence with no trailing newline", () => {
    expect(injectImageEmbed("---\nkind: photo\n---", "../Photos/a.jpg")).toBe(
      "---\nkind: photo\n---\n![](../Photos/a.jpg)\n\n",
    );
  });

  it("looks for the H1 in the body only — a # line inside the frontmatter is not it", () => {
    const md = "---\n# a YAML comment\ncreated: 2026-09-29\n---\n# Body Title\n\nbody\n";
    expect(injectImageEmbed(md, "../Photos/a.jpg")).toBe(
      "---\n# a YAML comment\ncreated: 2026-09-29\n---\n# Body Title\n\n![](../Photos/a.jpg)\n\nbody\n",
    );
  });

  // Re-enrich and Finish send the on-disk body (embeds included) to the model
  // and then re-inject the same embeds; each run added another copy.
  it("is idempotent: never adds an embed the note already contains", () => {
    const withH1 = "# Title\n\n![](../Photos/a.jpg)\n\nbody\n";
    expect(injectImageEmbed(withH1, "../Photos/a.jpg")).toBe(withH1);
    const noH1 = "---\ncreated: 2026-09-29\n---\n![](../Photos/a.jpg)\n\nbody\n";
    expect(injectImageEmbed(noH1, "../Photos/a.jpg")).toBe(noH1);
  });
});

// ── injectAttachments ─────────────────────────────────────────────────────────

describe("injectAttachments", () => {
  const img = (rel: string, filename: string): AttachmentRef => ({
    kind: "image",
    rel,
    filename,
  });
  const file = (rel: string, filename: string): AttachmentRef => ({
    kind: "file",
    rel,
    filename,
  });

  it("returns the body unchanged for an empty attachment list", () => {
    const md = "# T\n\nbody\n";
    expect(injectAttachments(md, [])).toBe(md);
  });

  it("never doubles an image embed when the same images are injected twice", () => {
    // Files already upsert (one `## Files` section); images used to stack.
    const refs = [img("../Photos/a.jpg", "a.jpg"), img("../Photos/b.jpg", "b.jpg")];
    const once = injectAttachments("# T\n\nbody\n", refs);
    expect(injectAttachments(once, refs)).toBe(once);
  });

  it("injects a single image embed under the H1", () => {
    const out = injectAttachments("# T\n\nbody\n", [
      img("../Photos/a.jpg", "a.jpg"),
    ]);
    expect(out).toBe("# T\n\n![](../Photos/a.jpg)\n\nbody\n");
  });

  it("keeps multiple images in input order under the H1", () => {
    const out = injectAttachments("# T\n\nbody\n", [
      img("../Photos/a.jpg", "a.jpg"),
      img("../Photos/b.jpg", "b.jpg"),
    ]);
    // First attachment appears first even though each embed inserts directly
    // below the H1 (the helper injects in reverse to preserve order).
    expect(out.indexOf("../Photos/a.jpg")).toBeLessThan(
      out.indexOf("../Photos/b.jpg"),
    );
    expect(out.indexOf("../Photos/a.jpg")).toBeGreaterThan(out.indexOf("# T"));
  });

  it("collects non-image files into a single ## Files section as links", () => {
    const out = injectAttachments("# T\n\nbody\n", [
      file("../Files/spec.pdf", "spec.pdf"),
      file("../Files/data.csv", "data.csv"),
    ]);
    expect(out).toContain("## Files");
    expect(out).toContain("[spec.pdf](../Files/spec.pdf)");
    expect(out).toContain("[data.csv](../Files/data.csv)");
    // Exactly one Files heading even with two files.
    expect(out.match(/^## Files$/gm)?.length).toBe(1);
  });

  it("handles a mix of images and files in one pass", () => {
    const out = injectAttachments("# T\n\nbody\n", [
      img("../Photos/a.jpg", "a.jpg"),
      file("../Files/spec.pdf", "spec.pdf"),
    ]);
    expect(out).toContain("![](../Photos/a.jpg)");
    expect(out).toContain("[spec.pdf](../Files/spec.pdf)");
    // Image is embedded under the H1; file link lives in the appended section.
    expect(out.indexOf("![](../Photos/a.jpg)")).toBeLessThan(
      out.indexOf("## Files"),
    );
  });
});

// ── stripInjectedAttachments ──────────────────────────────────────────────────

describe("stripInjectedAttachments", () => {
  const FM = "---\ncreated: 2026-10-02\nstatus: pending-enrich\n---\n";
  const REFS: AttachmentRef[] = [
    { kind: "image", rel: "../Photos/a.jpg", filename: "a.jpg" },
    { kind: "image", rel: "../Photos/b.jpg", filename: "b.jpg" },
    { kind: "file", rel: "../Files/spec.pdf", filename: "spec.pdf" },
  ];
  /** What injectAttachments did to `body`, read back the way Finish/Re-enrich
   * read a note: frontmatter off, body only. */
  const injectedBody = (body: string): string =>
    splitFrontmatter(injectAttachments(FM + body, REFS)).body;

  it("undoes injectAttachments on a raw save-first body (no H1)", () => {
    const raw = "Errands for Saturday\n- [ ] buy milk\nthe ferns need water\n";
    expect(injectedBody(raw)).toContain("![](../Photos/a.jpg)");
    expect(stripInjectedAttachments(injectedBody(raw))).toBe(raw);
  });

  it("undoes injectAttachments on an enriched body (H1, then a blank line)", () => {
    const enriched = "# Errands\n\nSaturday.\n\n- [ ] buy milk\n";
    expect(stripInjectedAttachments(injectedBody(enriched))).toBe(enriched);
  });

  it("leaves a body with nothing app-owned in it byte-identical", () => {
    const body = [
      "# Trip",
      "",
      "![](https://example.com/remote.png)",
      "",
      "See [the spec](../Files/spec.pdf) before Monday.",
      "",
      "## Files",
      "",
      "Scans are still on the laptop.",
      "",
      "## Places",
      "",
      "[Gare de Lyon](geo:48.84430,2.37350)",
      "",
    ].join("\n");
    expect(stripInjectedAttachments(body)).toBe(body);
  });

  it("drops the links from a Files section that has prose, but keeps the heading and prose", () => {
    const body = "Body.\n\n## Files\n\nScans are on the laptop.\n\n[spec.pdf](../Files/spec.pdf)\n";
    expect(stripInjectedAttachments(body)).toBe("Body.\n\n## Files\n\nScans are on the laptop.\n");
  });

  it("drops an embed the user moved mid-text without merging the lines around it", () => {
    const body = "First paragraph.\n\n![](../Photos/a.jpg)\n\nSecond paragraph.\n";
    expect(stripInjectedAttachments(body)).toBe("First paragraph.\n\nSecond paragraph.\n");
  });

  it("handles a CRLF body synced from a Windows workstation", () => {
    const body = "![](../Photos/a.jpg)\r\n\r\nHello\r\n\r\n## Files\r\n\r\n[spec.pdf](../Files/spec.pdf)\r\n";
    expect(stripInjectedAttachments(body)).toBe("Hello\r\n");
  });
});

// ── upsertSection ─────────────────────────────────────────────────────────────

describe("upsertSection", () => {
  it("appends a new section when the heading does not exist", () => {
    const before =
      "---\nkind: shared-audio\n---\n# Audio\n\n## File\n[a.m4a](../Audio/a.m4a)\n";
    const after = upsertSection(before, "Transcript", "hello world");
    expect(after).toContain("## Transcript");
    expect(after).toContain("hello world");
    expect(after).toContain("## File");
    expect(after.endsWith("\n")).toBe(true);
  });

  it("normalizes trailing newlines on append (no double-blank gap)", () => {
    // Input ends with several newlines — output should end with exactly one.
    const before = "# Title\n\nbody\n\n\n\n";
    const after = upsertSection(before, "Notes", "added");
    expect(after).toBe("# Title\n\nbody\n\n## Notes\n\nadded\n");
  });

  it("appends correctly when input has no trailing newline", () => {
    const before = "# Title\n\nbody";
    const after = upsertSection(before, "Notes", "added");
    expect(after).toBe("# Title\n\nbody\n\n## Notes\n\nadded\n");
  });

  it("replaces a single-section body when the heading exists at EOF", () => {
    const before = "# Title\n\n## Transcript\n\nold text\n";
    const after = upsertSection(before, "Transcript", "new text");
    expect(after).toContain("## Transcript");
    expect(after).toContain("new text");
    expect(after).not.toContain("old text");
  });

  it("preserves following H2 section when replacing in the middle", () => {
    const before =
      "# T\n\n## Transcript\n\nold\n\n## Footer\n\nkeep\n";
    const after = upsertSection(before, "Transcript", "new");
    expect(after).toContain("## Transcript\n\nnew");
    expect(after).toContain("## Footer");
    expect(after).toContain("keep");
    expect(after).not.toContain("old");
  });

  it("preserves following H1 when replacing the last H2 before it", () => {
    const before = "## Transcript\n\nold\n\n# Next Doc\n\nkeep\n";
    const after = upsertSection(before, "Transcript", "new");
    expect(after).toContain("## Transcript\n\nnew");
    expect(after).toContain("# Next Doc");
    expect(after).toContain("keep");
  });

  it("does not match a heading with trailing whitespace (appends instead)", () => {
    // Obsidian's heading parser is strict; our match must be too.
    const before = "# T\n\n## Transcript \n\nold\n";
    const after = upsertSection(before, "Transcript", "new");
    // The malformed heading is left as body content; a new section is appended.
    expect(after).toContain("## Transcript \n");
    expect(after.endsWith("## Transcript\n\nnew\n")).toBe(true);
  });

  it("leaves frontmatter untouched", () => {
    const before =
      "---\nkind: shared-audio\ntags: [shared, audio]\n---\n# Audio\n";
    const after = upsertSection(before, "Transcript", "txt");
    expect(after).toContain("---\nkind: shared-audio");
    expect(after).toContain("tags: [shared, audio]");
  });

  it("is idempotent — re-running with the same body returns identical output", () => {
    const before = "# T\n\n## Transcript\n\nfoo\n";
    const once = upsertSection(before, "Transcript", "bar");
    const twice = upsertSection(once, "Transcript", "bar");
    expect(twice).toBe(once);
  });

  it("treats H3+ subheadings as part of the current section body", () => {
    const before =
      "# T\n\n## Transcript\n\nold\n\n### Speakers\n\nA, B\n\n## Footer\n\nkeep\n";
    const after = upsertSection(before, "Transcript", "new");
    // The H3 + its content get replaced because they belong to the H2 section.
    expect(after).not.toContain("### Speakers");
    expect(after).toContain("## Footer");
    expect(after).toContain("keep");
  });

  it("produces a clean section when input markdown is empty (no leading blank lines)", () => {
    // Pre-fix this returned "\n\n## Transcript\n\nhi\n" with two phantom
    // newlines at the start — caught by review, fixed via empty-string guard.
    expect(upsertSection("", "Transcript", "hi")).toBe(
      "## Transcript\n\nhi\n",
    );
  });

  it("rejects headings containing newlines (defense against multi-line injection)", () => {
    expect(() => upsertSection("# T\n", "Transcript\n## Pwned", "x")).toThrow(
      /heading cannot contain newlines/,
    );
    expect(() => upsertSection("# T\n", "A\rB", "x")).toThrow(
      /heading cannot contain newlines/,
    );
  });
});

// ── injectPlaces ──────────────────────────────────────────────────────────────

describe("injectPlaces", () => {
  const place = (name: string, lat: number, lon: number): Place => ({
    name,
    coords: { lat, lon },
  });

  /** Every non-empty line of the ## Places section. */
  const readPlacesLinks = (md: string): string[] => {
    const after = md.split("## Places\n")[1] ?? "";
    return after.split("\n").filter((l) => l.trim().length > 0);
  };

  it("returns the body unchanged for an empty place list", () => {
    const md = "# T\n\nbody\n";
    expect(injectPlaces(md, [])).toBe(md);
  });

  it("injects a single place as a geo link under ## Places", () => {
    const out = injectPlaces("# T\n\nbody\n", [place("Rud-Alpe", 47.2011, 10.1166)]);
    expect(out).toContain("## Places");
    expect(out).toContain("[Rud-Alpe](geo:47.20110,10.11660)");
  });

  it("lists multiple places under one heading, blank-line separated", () => {
    const out = injectPlaces("# T\n\nbody\n", [
      place("Rud-Alpe", 47.2011, 10.1166),
      place("Lech", 47.2063, 10.1435),
    ]);
    expect(out.match(/^## Places$/gm)?.length).toBe(1);
    expect(out).toContain(
      "[Rud-Alpe](geo:47.20110,10.11660)\n\n[Lech](geo:47.20630,10.14350)",
    );
  });

  it("appends to an existing section rather than duplicating the heading", () => {
    const first = injectPlaces("# T\n\nbody\n", [place("Rud-Alpe", 47.2011, 10.1166)]);
    const second = injectPlaces(first, [place("Lech", 47.2063, 10.1435)]);
    expect(second.match(/^## Places$/gm)?.length).toBe(1);
    // Both survive — re-injection must not silently drop earlier entries.
    expect(second).toContain("[Rud-Alpe](geo:47.20110,10.11660)");
    expect(second).toContain("[Lech](geo:47.20630,10.14350)");
  });

  it("preserves a pre-existing (model-written) ## Places section", () => {
    const authored = "# T\n\nbody\n\n## Places\n\nWe wandered around Lech all day.\n";
    const out = injectPlaces(authored, [place("Rud-Alpe", 47.2011, 10.1166)]);
    expect(out.match(/^## Places$/gm)?.length).toBe(1);
    expect(out).toContain("We wandered around Lech all day.");
    expect(out).toContain("[Rud-Alpe](geo:47.20110,10.11660)");
  });

  it("strips newlines from a place name so it cannot forge a section boundary", () => {
    const out = injectPlaces("# T\n\nbody\n", [
      { name: "Evil\n## Transcript\nowned", coords: { lat: 1, lon: 2 } },
    ]);
    expect(out).toContain("[Evil ## Transcript owned](geo:1.00000,2.00000)");
    // Exactly two headings: the H1 and our Places section.
    expect(out.match(/^#{1,2} /gm)?.length).toBe(2);
  });

  it("strips brackets from a place name so the link label cannot terminate early", () => {
    const out = injectPlaces("# T\n\nbody\n", [
      { name: "Caf[e] Sperl](evil:1)", coords: { lat: 1, lon: 2 } },
    ]);
    // The label keeps its parens (harmless) but loses every bracket, so the
    // result is exactly one well-formed link, not a link plus injected markup.
    expect(out).toContain("[Cafe Sperl(evil:1)](geo:1.00000,2.00000)");
    expect(readPlacesLinks(out)).toEqual(["[Cafe Sperl(evil:1)](geo:1.00000,2.00000)"]);
  });

  it("falls back to the coordinates when a name sanitizes to nothing", () => {
    const out = injectPlaces("# T\n\nbody\n", [
      { name: "[[]]", coords: { lat: 47.2011, lon: 10.1166 } },
    ]);
    expect(out).toContain("[47.20110,10.11660](geo:47.20110,10.11660)");
  });

  it("leaves an existing ## Files section intact", () => {
    const withFiles = injectAttachments("# T\n\nbody\n", [
      { kind: "file", rel: "../Files/spec.pdf", filename: "spec.pdf" },
    ]);
    const out = injectPlaces(withFiles, [place("Lech", 47.2063, 10.1435)]);
    expect(out).toContain("## Files");
    expect(out).toContain("[spec.pdf](../Files/spec.pdf)");
    expect(out).toContain("## Places");
  });
});
