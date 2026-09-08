import { describe, expect, it } from "vitest";
import {
  MAX_NOTES, PER_NOTE_CHARS, TOTAL_BUDGET_CHARS,
  orderCandidates, pickForRead, packBodies,
  resolveCitations, buildSynthesisNote,
} from "./retrospective";

const cand = (uri: string, title: string, fromBodyMatch = false) => ({ uri, title, fromBodyMatch });

describe("orderCandidates", () => {
  it("puts body matches first and dedupes by uri", () => {
    const out = orderCandidates(
      [cand("file:///v/Ideas/b.md", "B", true)],
      [cand("file:///v/Ideas/a.md", "A"), cand("file:///v/Ideas/b.md", "B")],
    );
    expect(out.map((c) => c.uri)).toEqual(["file:///v/Ideas/b.md", "file:///v/Ideas/a.md"]);
  });

  it("preserves indexed order among non-body matches", () => {
    const out = orderCandidates([], [cand("u1", "A"), cand("u2", "B"), cand("u3", "C")]);
    expect(out.map((c) => c.title)).toEqual(["A", "B", "C"]);
  });
});

describe("pickForRead", () => {
  it("caps at MAX_NOTES", () => {
    const many = Array.from({ length: MAX_NOTES + 5 }, (_, i) => cand(`u${i}`, `T${i}`));
    expect(pickForRead(many)).toHaveLength(MAX_NOTES);
  });
});

describe("packBodies", () => {
  it("truncates a note over PER_NOTE_CHARS and marks it truncated", () => {
    const picked = [cand("u1", "A")];
    const bodies = new Map([["u1", "x".repeat(PER_NOTE_CHARS + 100)]]);
    const [note] = packBodies(picked, bodies);
    expect(note.body).toHaveLength(PER_NOTE_CHARS);
    expect(note.truncated).toBe(true);
  });

  it("stops adding notes once TOTAL_BUDGET_CHARS is exhausted", () => {
    const picked = Array.from({ length: MAX_NOTES }, (_, i) => cand(`u${i}`, `T${i}`));
    const bodies = new Map(picked.map((c) => [c.uri, "y".repeat(PER_NOTE_CHARS)]));
    const out = packBodies(picked, bodies);
    const total = out.reduce((n, s) => n + s.body.length, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_BUDGET_CHARS);
    expect(out.length).toBeLessThan(MAX_NOTES); // the total cap binds before the count cap
  });

  it("skips a uri with no body read (unreadable note)", () => {
    expect(packBodies([cand("u1", "A")], new Map())).toEqual([]);
  });
});

const sel = (uri: string, title: string, body = "b") => ({ uri, title, body, truncated: false });

describe("resolveCitations", () => {
  const set = [sel("file:///v/Ideas/a.md", "Coffee roasting")];

  it("linkifies a citation that is in the retrieval set", () => {
    const out = resolveCitations("I wrote [[Coffee roasting]] about it.", set);
    expect(out.find((s) => s.linkUri)).toEqual({
      text: "Coffee roasting",
      linkUri: "file:///v/Ideas/a.md",
    });
  });

  it("leaves a citation NOT in the retrieval set as inert text", () => {
    const out = resolveCitations("See [[Invented note]].", set);
    expect(out.every((s) => s.linkUri === undefined)).toBe(true);
    expect(out.map((s) => s.text).join("")).toBe("See [[Invented note]].");
  });

  it("matches titles case-insensitively and ignores surrounding whitespace", () => {
    const out = resolveCitations("[[  coffee ROASTING  ]]", set);
    expect(out.find((s) => s.linkUri)?.linkUri).toBe("file:///v/Ideas/a.md");
  });
});

describe("buildSynthesisNote", () => {
  it("emits frontmatter, the answer, and a Sources list", () => {
    const md = buildSynthesisNote("what about coffee?", "You wrote a lot.", [
      sel("file:///v/Ideas/a.md", "Coffee roasting"),
    ], "2026-09-07");
    expect(md).toContain("tags: [synthesis]");
    expect(md).toContain('question: "what about coffee?"');
    expect(md).toContain("## Sources");
    expect(md).toContain("- [[Coffee roasting]]");
  });

  it("escapes a double quote in the question so frontmatter stays parseable", () => {
    const md = buildSynthesisNote('say "hi"', "a", [], "2026-09-07");
    expect(md).toContain('question: "say \\"hi\\""');
  });
});
