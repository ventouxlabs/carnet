import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  parseFrontmatter,
  preserveFrontmatterFields,
  upsertFrontmatterField,
  getFrontmatterTags,
  setFrontmatterTags,
  normalizeTag,
  splitFrontmatter,
  extractFrontmatterField,
  rewriteFrontmatterField,
  isSynthesisNote,
} from "./frontmatter";
import { buildSynthesisNote } from "./retrospective";

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("returns ordered scalar fields with inline values", () => {
    const md = "---\nkind: idea\ncreated: 2026-05-08\nstatus: seedling\n---\n# T\n";
    expect(parseFrontmatter(md)).toEqual({
      hasBlock: true,
      fields: [
        ["kind", "idea"],
        ["created", "2026-05-08"],
        ["status", "seedling"],
      ],
    });
  });

  it("reports no block when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a title\n\nbody\n")).toEqual({
      hasBlock: false,
      fields: [],
    });
  });

  it("keeps the full inline value for a flow array", () => {
    const md = "---\ntags: [idea, seedling]\n---\n# T\n";
    expect(parseFrontmatter(md).fields).toEqual([["tags", "[idea, seedling]"]]);
  });

  it("preserves a value containing a colon (greedy after the key)", () => {
    const md = "---\ntime: 10:30\n---\n# T\n";
    expect(parseFrontmatter(md).fields).toEqual([["time", "10:30"]]);
  });

  it("ignores block-list continuation lines (use getFrontmatterTags for arrays)", () => {
    const md = "---\ntags:\n  - a\n  - b\nstatus: x\n---\n# T\n";
    expect(parseFrontmatter(md).fields).toEqual([
      ["tags", ""],
      ["status", "x"],
    ]);
  });
});

// ── normalizeTag ──────────────────────────────────────────────────────────────

describe("normalizeTag", () => {
  it("lowercases, strips a leading hash, and hyphenates spaces", () => {
    expect(normalizeTag("#My Tag")).toBe("my-tag");
  });

  it("drops punctuation and other non [a-z0-9-] characters", () => {
    expect(normalizeTag("Hello, World!")).toBe("hello-world");
  });

  it("collapses repeat hyphens and trims edge hyphens", () => {
    expect(normalizeTag("  --my---tag--  ")).toBe("my-tag");
  });

  it("strips emoji and merges the surrounding text", () => {
    expect(normalizeTag("emoji🚀tag")).toBe("emojitag");
  });

  it("returns empty string for input that normalizes to nothing", () => {
    expect(normalizeTag("---")).toBe("");
    expect(normalizeTag("🚀")).toBe("");
    expect(normalizeTag("   ")).toBe("");
  });

  it("is idempotent", () => {
    const once = normalizeTag("#Work In Progress!");
    expect(once).toBe("work-in-progress");
    expect(normalizeTag(once)).toBe(once);
  });
});

// ── getFrontmatterTags ────────────────────────────────────────────────────────

describe("getFrontmatterTags", () => {
  it("reads an inline flow array", () => {
    const md = "---\ntags: [idea, seedling]\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["idea", "seedling"]);
  });

  it("reads a YAML block list", () => {
    const md = "---\nkind: idea\ntags:\n  - work\n  - urgent\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["work", "urgent"]);
  });

  it("reads a block list whose items sit at the key's own indent", () => {
    const md = "---\ntags:\n- a\n- b\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["a", "b"]);
  });

  it("returns [] for an empty flow array", () => {
    expect(getFrontmatterTags("---\ntags: []\n---\n# T\n")).toEqual([]);
  });

  it("returns [] when there is no tags field", () => {
    expect(getFrontmatterTags("---\nkind: idea\n---\n# T\n")).toEqual([]);
  });

  it("returns [] when there is no frontmatter", () => {
    expect(getFrontmatterTags("# T\n\nbody\n")).toEqual([]);
  });

  it("treats a bare scalar as a single tag", () => {
    expect(getFrontmatterTags("---\ntags: idea\n---\n# T\n")).toEqual(["idea"]);
  });

  it("strips surrounding quotes from flow items", () => {
    const md = "---\ntags: ['idea', \"work\"]\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["idea", "work"]);
  });

  it("stops the block scan at the next top-level key", () => {
    const md = "---\ntags:\n  - a\nstatus: developing\n---\n# T\n";
    expect(getFrontmatterTags(md)).toEqual(["a"]);
  });
});

// ── upsertFrontmatterField ────────────────────────────────────────────────────

describe("upsertFrontmatterField", () => {
  it("rewrites an existing field, leaving others byte-exact", () => {
    const md = "---\nkind: idea\nlocation: 0,0\nstatus: seedling\n---\n# T\n\nbody\n";
    const out = upsertFrontmatterField(md, "location", "38.9072,-77.0369");
    expect(out).toBe(
      "---\nkind: idea\nlocation: 38.9072,-77.0369\nstatus: seedling\n---\n# T\n\nbody\n",
    );
  });

  it("inserts a missing field just before the closing fence", () => {
    const md = "---\nkind: idea\n---\n# T\n";
    expect(upsertFrontmatterField(md, "location", "1,2")).toBe(
      "---\nkind: idea\nlocation: 1,2\n---\n# T\n",
    );
  });

  it("synthesizes a frontmatter block when none exists", () => {
    expect(upsertFrontmatterField("# Just a title\n\nbody\n", "location", "1,2")).toBe(
      "---\nlocation: 1,2\n---\n# Just a title\n\nbody\n",
    );
  });

  it("preserves a body horizontal rule (does not mis-cut on `---`)", () => {
    const md = "---\nstatus: seedling\n---\n# T\n\nIntro.\n\n---\n\nAfter rule.\n";
    const out = upsertFrontmatterField(md, "status", "mature");
    expect(out).toContain("status: mature");
    expect(out).toContain("\n---\n\nAfter rule.\n");
  });

  it("preserves a frontmatter-only note with no trailing newline", () => {
    const md = "---\nkind: idea\n---";
    expect(upsertFrontmatterField(md, "location", "1,2")).toBe(
      "---\nkind: idea\nlocation: 1,2\n---",
    );
  });

  it("sweeps away the old block-list items when rewriting an array field inline", () => {
    const md = "---\ntags:\n  - old1\n  - old2\nstatus: x\n---\n# T\n";
    const out = upsertFrontmatterField(md, "tags", "[new]");
    expect(out).toBe("---\ntags: [new]\nstatus: x\n---\n# T\n");
  });

  it("rejects values containing newlines", () => {
    expect(() => upsertFrontmatterField("---\na: 1\n---\n", "a", "x\ninjected: y")).toThrow(
      "newlines",
    );
  });

  it("preserves the leading whitespace of an indented key on rewrite", () => {
    const md = "---\nmeta:\n  nested: old\n---\n# T\n";
    const out = upsertFrontmatterField(md, "nested", "new");
    expect(out).toContain("  nested: new");
  });
});

// ── setFrontmatterTags ────────────────────────────────────────────────────────

describe("setFrontmatterTags", () => {
  it("writes an inline flow array, upserting the field", () => {
    const md = "---\nkind: idea\n---\n# T\n";
    expect(setFrontmatterTags(md, ["work", "urgent"])).toBe(
      "---\nkind: idea\ntags: [work, urgent]\n---\n# T\n",
    );
  });

  it("normalizes and de-duplicates (case/whitespace folded once)", () => {
    const md = "---\nkind: idea\n---\n# T\n";
    expect(setFrontmatterTags(md, ["Idea", "idea", "My Tag", "my-tag"])).toBe(
      "---\nkind: idea\ntags: [idea, my-tag]\n---\n# T\n",
    );
  });

  it("merges with existing LLM tags when the caller composes them", () => {
    const md = "---\ntags: [idea, seedling]\n---\n# T\n";
    const merged = [...getFrontmatterTags(md), "work"];
    expect(setFrontmatterTags(md, merged)).toBe(
      "---\ntags: [idea, seedling, work]\n---\n# T\n",
    );
  });

  it("replaces a block-list tags field with the inline form (no orphans)", () => {
    const md = "---\ntags:\n  - idea\n---\n# T\n";
    expect(setFrontmatterTags(md, ["idea", "work"])).toBe(
      "---\ntags: [idea, work]\n---\n# T\n",
    );
  });

  it("creates a frontmatter block for an unfrontmattered note", () => {
    expect(setFrontmatterTags("# T\n\nbody\n", ["a", "b"])).toBe(
      "---\ntags: [a, b]\n---\n# T\n\nbody\n",
    );
  });

  it("writes an empty array when every tag normalizes away", () => {
    expect(setFrontmatterTags("---\nkind: idea\n---\n# T\n", ["🚀", "---"])).toBe(
      "---\nkind: idea\ntags: []\n---\n# T\n",
    );
  });

  it("round-trips through getFrontmatterTags", () => {
    const md = setFrontmatterTags("---\nkind: idea\n---\n# T\n", ["Work", "in progress"]);
    expect(getFrontmatterTags(md)).toEqual(["work", "in-progress"]);
  });
});

// ── re-export parity (writer.ts still exposes the moved helpers) ──────────────

describe("re-exported helpers remain importable from ./frontmatter", () => {
  it("splitFrontmatter round-trips byte-for-byte", () => {
    const md = "---\nkind: idea\n---\n\n# T\n\nbody\n";
    const { header, body } = splitFrontmatter(md);
    expect(header + body).toBe(md);
  });

  it("extractFrontmatterField reads a scalar", () => {
    expect(extractFrontmatterField("---\nkind: photo\n---\n# T\n", "kind")).toBe("photo");
  });

  it("rewriteFrontmatterField still throws when the field is absent", () => {
    expect(() => rewriteFrontmatterField("---\nkind: idea\n---\n# T\n", "x", "y")).toThrow(
      "not present",
    );
  });
});

describe("preserveFrontmatterFields", () => {
  const original = [
    "---",
    "name: Ada Lovelace",
    "email: ada@example.com",
    'phone: ""',
    "empty:",
    "assistant: Charles",
    "tags: [person]",
    "---",
    "# Ada",
  ].join("\n");

  it("carries over fields the enriched output does not set", () => {
    const out = preserveFrontmatterFields("---\nname: Ada Lovelace\n---\n# Ada v2\n", original);
    expect(out).toContain("email: ada@example.com");
    expect(out).toContain("assistant: Charles");
    expect(out).toContain("tags: [person]");
    expect(out).toContain("# Ada v2");
  });

  it("lets the enriched output win where it sets a value", () => {
    const out = preserveFrontmatterFields(
      "---\nemail: new@example.com\n---\n# Ada\n",
      original,
    );
    expect(out).toContain("email: new@example.com");
    expect(out).not.toContain("ada@example.com");
  });

  it("treats an empty or quoted-empty value as absent on both sides", () => {
    // The person prompt emits `email: ""` for anything it couldn't read.
    const out = preserveFrontmatterFields('---\nemail: ""\n---\n# Ada\n', original);
    expect(out).toContain("email: ada@example.com");
    // `phone: ""` and `empty:` in the ORIGINAL carry nothing worth restoring.
    expect(out).not.toContain("phone:");
    expect(out).not.toContain("empty:");
  });

  it("skips excluded fields entirely", () => {
    const out = preserveFrontmatterFields("---\nname: Ada\n---\n# Ada\n", original, [
      "email",
      "assistant",
    ]);
    expect(out).not.toContain("email:");
    expect(out).not.toContain("assistant:");
  });

  it("leaves the enriched markdown untouched when the original has no frontmatter", () => {
    const enriched = "---\nname: Ada\n---\n# Ada\n";
    expect(preserveFrontmatterFields(enriched, "# just a body\n")).toBe(enriched);
  });

  it("carries over keys containing spaces or dots (Obsidian Properties allows both)", () => {
    const spacedOriginal = [
      "---",
      "name: Ada Lovelace",
      "date created: 2026-01-01",
      "Read status: unread",
      "pdf.page: 12",
      "---",
      "# Ada",
    ].join("\n");
    const out = preserveFrontmatterFields("---\nname: Ada Lovelace\n---\n# Ada v2\n", spacedOriginal);
    expect(out).toContain("date created: 2026-01-01");
    expect(out).toContain("Read status: unread");
    expect(out).toContain("pdf.page: 12");
  });
});

// ── Strict YAML validity of preserved values ────────────────────────────────
//
// carnet's own parser is deliberately tolerant, so it happily reads back a line
// it just corrupted — these assertions go through a real YAML parser instead.
// `yaml` resolves from the workspace root (apps/mdcrm depends on it); it is a
// test-only import and nothing in apps/mobile ships it.

describe("preserveFrontmatterFields — YAML validity", () => {
  const parseStrict = (markdown: string): Record<string, unknown> => {
    const { header } = splitFrontmatter(markdown);
    const inner = header.split("\n").slice(1, -2).join("\n");
    return parseYaml(inner) as Record<string, unknown>;
  };

  it("keeps a quoted value containing a colon parseable, and byte-identical", () => {
    // Re-serializing this as a bare scalar yields `note: Met at 3: the cafe` —
    // an unescaped `: ` mid-value, which fails the WHOLE block in Obsidian and
    // empties the note's entire Properties pane.
    const original = '---\nname: Ada\nnote: "Met at 3: the cafe"\n---\n# Ada\n';
    const out = preserveFrontmatterFields("---\nname: Ada\n---\n# Ada v2\n", original);
    expect(out).toContain('note: "Met at 3: the cafe"');
    expect(parseStrict(out)).toEqual({ name: "Ada", note: "Met at 3: the cafe" });
  });

  it("keeps a value starting with '#' from being parsed as a comment", () => {
    const original = '---\nname: Ada\nquip: "#1 fan"\n---\n# Ada\n';
    const out = preserveFrontmatterFields("---\nname: Ada\n---\n# Ada v2\n", original);
    expect(parseStrict(out).quip).toBe("#1 fan");
  });

  it("keeps other indicator-led and multi-word values intact", () => {
    const original = [
      "---",
      "name: Ada",
      'anchor: "*star"',
      'ratio: "50% done"',
      'handle: "@ada"',
      'brace: "{not a map}"',
      "---",
      "# Ada",
    ].join("\n");
    const out = preserveFrontmatterFields("---\nname: Ada\n---\n# Ada v2\n", original);
    expect(parseStrict(out)).toEqual({
      name: "Ada",
      anchor: "*star",
      ratio: "50% done",
      handle: "@ada",
      brace: "{not a map}",
    });
  });

  it("carries a block-form value across as block form", () => {
    // Obsidian writes `aliases` and `cssclasses` this way by default.
    const original = "---\nname: Ada\naliases:\n  - Countess\n  - A.L.\n---\n# Ada\n";
    const out = preserveFrontmatterFields("---\nname: Ada\n---\n# Ada v2\n", original);
    expect(parseStrict(out).aliases).toEqual(["Countess", "A.L."]);
  });

  it("replaces an empty enriched field rather than duplicating the key", () => {
    const original = "---\nemail: ada@example.com\n---\n# Ada\n";
    const out = preserveFrontmatterFields('---\nemail: ""\n---\n# Ada v2\n', original);
    expect(out.match(/^email:/gm)).toHaveLength(1);
    expect(parseStrict(out).email).toBe("ada@example.com");
  });
});

// ── isSynthesisNote ───────────────────────────────────────────────────────────

describe("isSynthesisNote", () => {
  const captured =
    "---\ncreated: 2026-09-27\ntags: [note, errands]\n---\n# Weekend errands\n\n- [ ] call the dentist\n";

  it("identifies buildSynthesisNote's real output", () => {
    expect(
      isSynthesisNote(buildSynthesisNote("what about coffee", "You wrote about it.", [], "2026-09-27")),
    ).toBe(true);
  });

  it("does not mistake a captured note for one", () => {
    expect(isSynthesisNote(captured)).toBe(false);
  });

  it("is false with no frontmatter at all", () => {
    expect(isSynthesisNote("# just a heading\n")).toBe(false);
  });

  it("still identifies it by question: after the user retags it in Obsidian", () => {
    const retagged = buildSynthesisNote("q", "a", [], "2026-09-27").replace(
      "tags: [synthesis]",
      "tags: [research]",
    );
    expect(isSynthesisNote(retagged)).toBe(true);
  });

  it("still identifies it by the synthesis tag (normalized) if question: was deleted", () => {
    expect(isSynthesisNote("---\ncreated: 2026-09-27\ntags: [#Synthesis]\n---\n# q\n")).toBe(true);
  });

  it("ignores a question: line in the body — only frontmatter counts", () => {
    expect(isSynthesisNote(`${captured}\nquestion: what to buy\n`)).toBe(false);
  });
});
