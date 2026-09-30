import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { keepsUserLines, withUserLines } from "./noteLineGuard";

const FM = "---\ncreated: 2026-09-29\ntags: [note, errands]\n---\n";

function fixture(name: string): { input: string; content: string } {
  const raw = JSON.parse(
    readFileSync(join(__dirname, "../../test/fixtures/omniroute", name), "utf8"),
  ) as { input: string; choices: Array<{ message: { content: string } }> };
  return { input: raw.input, content: raw.choices[0].message.content };
}

describe("keepsUserLines — compliant replies pass", () => {
  it("accepts the repro fixture: a new title from the first line, actions as checkboxes", () => {
    const { input, content } = fixture("note-tasklist.json");
    expect(keepsUserLines(input, content)).toBe(true);
  });

  it("allows a plain or bulleted line to become a checkbox", () => {
    const input = "call the dentist\n- buy stamps\n* post the letter\n+ fetch the car";
    const out = `${FM}# Errands\n\n- [ ] call the dentist\n- [ ] buy stamps\n- [ ] post the letter\n- [ ] fetch the car\n`;
    expect(keepsUserLines(input, out)).toBe(true);
  });

  it("allows a new title that is not one of the user's lines", () => {
    expect(keepsUserLines("call the dentist", `${FM}# Errands\n\n- [ ] call the dentist\n`)).toBe(true);
  });

  it("allows a new title while the same text is also kept as a line", () => {
    const input = "Weekend errands\ncall the dentist";
    const out = `${FM}# Weekend errands\n\nWeekend errands\n- [ ] call the dentist\n`;
    expect(keepsUserLines(input, out)).toBe(true);
  });

  it("passes a re-enrich whose note already has the same # Title", () => {
    const input = "# Weekend errands\n\n- [ ] call the dentist\n- [x] buy stamps";
    const out = `${FM}# Weekend errands\n\n- [ ] call the dentist\n- [x] buy stamps\n`;
    expect(keepsUserLines(input, out)).toBe(true);
  });

  it("ignores blank lines, trailing whitespace, CRLF and indentation", () => {
    const input = "call the dentist   \r\n\r\n  - buy stamps\r\n";
    const out = `${FM}# Errands\n\n\n- [ ] call the dentist\n\n- [ ] buy stamps  \n\n`;
    expect(keepsUserLines(input, out)).toBe(true);
  });

  it("treats a numbered list marker like any other marker", () => {
    const out = `${FM}# Errands\n\n- [ ] call the dentist\n- [ ] buy stamps\n`;
    expect(keepsUserLines("1. call the dentist\n2) buy stamps", out)).toBe(true);
  });

  it("reads * and + checkboxes as todos, with their ticked state", () => {
    expect(keepsUserLines("* [ ] buy stamps\n+ [x] post it", `${FM}# T\n\n- [ ] buy stamps\n- [x] post it\n`)).toBe(true);
    expect(keepsUserLines("* [x] post it", `${FM}# T\n\n- [ ] post it\n`)).toBe(false);
    expect(keepsUserLines("+ [ ] buy stamps", `${FM}# T\n\nbuy stamps\n`)).toBe(false);
  });

  it("treats - [X] and - [x] as the same checked state", () => {
    expect(keepsUserLines("- [X] buy stamps", `${FM}# Stamps\n\n- [x] buy stamps\n`)).toBe(true);
  });

  it("parses a reply with an empty or missing frontmatter block", () => {
    expect(keepsUserLines("call the dentist", "---\n---\n# Errands\n\n- [ ] call the dentist\n")).toBe(true);
    expect(keepsUserLines("call the dentist", "# Errands\n\n- [ ] call the dentist\n")).toBe(true);
  });
});

describe("keepsUserLines — expansions fail", () => {
  it("fails a dropped line", () => {
    expect(keepsUserLines("call the dentist\nbuy stamps", `${FM}# Errands\n\n- [ ] call the dentist\n`)).toBe(false);
  });

  it("fails a reworded line", () => {
    expect(
      keepsUserLines("call the dentist", `${FM}# Errands\n\n- [ ] Call the dentist to book a cleaning\n`),
    ).toBe(false);
  });

  it("fails an added prose line", () => {
    const out = `${FM}# Errands\n\nHere are your errands for the weekend.\n- [ ] call the dentist\n`;
    expect(keepsUserLines("call the dentist", out)).toBe(false);
  });

  it("fails an added task", () => {
    const out = `${FM}# Errands\n\n- [ ] call the dentist\n- [ ] floss daily\n`;
    expect(keepsUserLines("call the dentist", out)).toBe(false);
  });

  it("fails a duplicated line", () => {
    const out = `${FM}# Errands\n\n- [ ] call the dentist\n- [ ] call the dentist\n`;
    expect(keepsUserLines("call the dentist", out)).toBe(false);
  });

  it("fails reordered lines", () => {
    const out = `${FM}# Errands\n\n- [ ] buy stamps\n- [ ] call the dentist\n`;
    expect(keepsUserLines("call the dentist\nbuy stamps", out)).toBe(false);
  });

  it("fails an un-ticked done todo", () => {
    expect(keepsUserLines("- [x] buy stamps", `${FM}# Stamps\n\n- [ ] buy stamps\n`)).toBe(false);
    expect(keepsUserLines("- [x] buy stamps", `${FM}# Stamps\n\nbuy stamps\n`)).toBe(false);
  });

  it("fails an open todo that lost its checkbox — it would drop out of Todos", () => {
    expect(keepsUserLines("- [ ] buy stamps", `${FM}# Stamps\n\nbuy stamps\n`)).toBe(false);
    expect(keepsUserLines("- [ ] buy stamps", `${FM}# Stamps\n\n- buy stamps\n`)).toBe(false);
    expect(keepsUserLines("- [ ] buy stamps", `${FM}# buy stamps\n`)).toBe(false);
  });

  it("fails a - [ ] todo re-bulleted as * or 1. — Todos only collects - [ ] lines", () => {
    expect(keepsUserLines("- [ ] buy stamps", `${FM}# T\n\n* [ ] buy stamps\n`)).toBe(false);
    expect(keepsUserLines("- [x] buy stamps", `${FM}# T\n\n1. [x] buy stamps\n`)).toBe(false);
  });

  it("fails a heading turned into a todo", () => {
    const out = `${FM}- [ ] Errands\n- [ ] buy milk\n`;
    expect(keepsUserLines("# Errands\nbuy milk", out)).toBe(false);
  });

  it("fails a todo the model ticked on the user's behalf", () => {
    expect(keepsUserLines("- [ ] buy stamps", `${FM}# Stamps\n\n- [x] buy stamps\n`)).toBe(false);
    expect(keepsUserLines("buy stamps", `${FM}# Stamps\n\n- [x] buy stamps\n`)).toBe(false);
  });

  it("allows only one new heading — a second added heading is prose", () => {
    const out = `${FM}# Errands\n\n## Health\n- [ ] call the dentist\n`;
    expect(keepsUserLines("call the dentist", out)).toBe(false);
  });

  it("does not read the reply's frontmatter as body lines", () => {
    // `tags: [note, errands]` is not one of the user's lines, and must not be
    // required to be one either.
    expect(keepsUserLines("call the dentist", `${FM}- [ ] call the dentist\n`)).toBe(true);
  });
});

describe("withUserLines — the fallback", () => {
  it("keeps the model's frontmatter and title, and the user's lines verbatim", () => {
    const input = "call the dentist\n\nbuy stamps  ";
    const expanded = `${FM}# Errands\n\nYou should call the dentist soon.\n- [ ] buy stamps\n`;
    expect(withUserLines(input, expanded)).toBe(`${FM}# Errands\n\ncall the dentist\n\nbuy stamps\n`);
  });

  it("applies the injected sanitizer to the model's frontmatter and title only, never the user's lines", () => {
    const upper = (markdown: string) => markdown.toUpperCase();
    const expanded = "---\ntags: [note]\n---\n# Shopping\n\nA long expansion.\n";
    expect(withUserLines("buy milk <% x %>", expanded, upper)).toBe(
      "---\nTAGS: [NOTE]\n---\n# SHOPPING\n\nbuy milk <% x %>\n",
    );
  });

  it("uses the title in place of an identical first line rather than repeating it", () => {
    // Keeps an H1 in the file: injectImageEmbed puts an attachment under the
    // H1, and above the whole document (frontmatter included) when there is none.
    const input = "Weekend errands\n\ncall the dentist";
    const expanded = `${FM}# Weekend errands\n\nA busy weekend ahead.\n- [ ] call the dentist\n`;
    expect(withUserLines(input, expanded)).toBe(`${FM}# Weekend errands\n\ncall the dentist\n`);
  });

  it("never turns a first-line todo or bullet into the title", () => {
    // Swapping the title in for `- [ ] call the dentist` would delete the todo.
    expect(
      withUserLines("- [ ] call the dentist", `${FM}# call the dentist\n\nBook a cleaning.\n`),
    ).toBe(`${FM}# call the dentist\n\n- [ ] call the dentist\n`);
    expect(withUserLines("- buy milk", `${FM}# buy milk\n\nWhole milk.\n`)).toBe(
      `${FM}# buy milk\n\n- buy milk\n`,
    );
  });

  // B3 (enrichSanitize) leaves fence bodies alone, so a heading inside a fence
  // is unsanitized model text. Lifting it into the title would make it live.
  describe("takes only an H1 outside any code fence as the title", () => {
    const PAYLOAD = "# <img src=x onerror=alert(1)> [x](javascript:alert(2))";

    it.each([
      ["a ``` fence", `${FM}\`\`\`js\n${PAYLOAD}\n\`\`\`\nbuy milk\n`],
      ["an unclosed ``` fence", `${FM}buy milk\n\`\`\`\n${PAYLOAD}\n`],
      ["a ~~~ fence", `${FM}~~~\n${PAYLOAD}\n~~~\nbuy milk\n`],
      ["a longer fence closed only by a matching run", `${FM}\`\`\`\`\n\`\`\`\n${PAYLOAD}\n\`\`\`\`\nbuy milk\n`],
    ])("never lifts a heading out of %s", (_, reply) => {
      expect(withUserLines("buy milk", reply)).toBe(`${FM}buy milk\n`);
    });

    it("never lifts a heading out of a fence when the reply has no frontmatter", () => {
      const reply = `\`\`\`text\nignored\n\`\`\`\n\`\`\`js\n${PAYLOAD}\n\`\`\`\nbuy milk\n`;
      expect(withUserLines("buy milk", reply)).not.toContain("onerror");
    });

    it("skips a fenced H1 and takes the first H1 after the fence", () => {
      const reply = `${FM}\`\`\`\n${PAYLOAD}\n\`\`\`\n# Errands\n\nprose\n`;
      expect(withUserLines("buy milk", reply)).toBe(`${FM}# Errands\n\nbuy milk\n`);
    });

    it("does not take a ## heading as the title", () => {
      expect(withUserLines("buy milk", `${FM}## Shelf\n\nprose\n`)).toBe(`${FM}buy milk\n`);
    });
  });

  it("does not stack a second H1 on a note that already starts with one", () => {
    const input = "# Groceries\n- [ ] milk\n- [x] eggs";
    const expanded = `${FM}# Shopping list\n\n- [ ] milk\n- [ ] eggs\n- [ ] bread\n`;
    expect(withUserLines(input, expanded)).toBe(`${FM}# Groceries\n- [ ] milk\n- [x] eggs\n`);
  });

  it("writes the user's lines alone when the reply has no title", () => {
    expect(withUserLines("call the dentist", `${FM}Sure! Call the dentist.\n`)).toBe(
      `${FM}call the dentist\n`,
    );
  });

  it("opens with an empty frontmatter block when the reply has none", () => {
    // So the user's own text can never be read as the note's frontmatter
    // (below); dispatcher's #note merge then fills this block.
    expect(withUserLines("call the dentist", "# Errands\n\nCall them.\n")).toBe(
      "---\n---\n# Errands\n\ncall the dentist\n",
    );
  });

  it("never lets a user's own --- block become the note's frontmatter", () => {
    expect(withUserLines("---\nfoo: bar\n---\nbuy milk", "Sure, here you go.\n")).toBe(
      "---\n---\n---\nfoo: bar\n---\nbuy milk\n",
    );
  });

  it("writes LF line endings only, whatever the input or reply used", () => {
    expect(withUserLines("call the dentist\r\nbuy stamps\r\n", `${FM}# Errands\n\nprose\n`)).toBe(
      `${FM}# Errands\n\ncall the dentist\nbuy stamps\n`,
    );
    expect(withUserLines("buy milk", "---\r\ncreated: y\r\n---\r\n# T\r\n\r\nprose\r\n")).toBe(
      "---\ncreated: y\n---\n# T\n\nbuy milk\n",
    );
    // A lone CR is a line break too — it must not smuggle text into the title.
    expect(withUserLines("buy milk", `${FM}# T\rtags: [evil]\nextra\n`)).toBe(`${FM}# T\n\nbuy milk\n`);
  });

  it("never merges the closing fence into the body", () => {
    expect(withUserLines("call the dentist", "---\ntags: [note]\n---")).toBe(
      "---\ntags: [note]\n---\ncall the dentist\n",
    );
  });

  it("always satisfies keepsUserLines itself (property over the fixtures)", () => {
    const tasklist = fixture("note-tasklist.json");
    const inputs = [
      tasklist.input,
      "Weekend errands\ncall the dentist",
      "# Groceries\n- [ ] milk\n- [x] eggs",
      "## Monday\n- [ ] call the dentist\n## Tuesday\n- [X] buy stamps",
      "- [x] done already\nstill to do",
      "  indented line\n\n\nlast line  ",
      "one line",
      "- [ ] call the dentist\nbuy stamps",
      "- buy milk",
      "1. call the dentist\n2) buy stamps\n* [x] post it",
      "---\nfoo: bar\n---\nbuy milk",
      "call the dentist\r\nbuy stamps\r\n",
    ];
    const replies = [
      tasklist.content,
      `${FM}# call the dentist\n\nExpanded prose.\n`,
      `${FM}# buy milk\n\nExpanded prose.\n`,
      `${FM}# Weekend errands\n\nExpanded prose.\n`,
      `${FM}# Groceries\n\nExpanded prose.\n`,
      `${FM}# Something new\n\nExpanded prose.\n`,
      `${FM}No title, only prose.\n`,
      "# No frontmatter\n\nprose\n",
      "---\n---\n",
      "",
    ];
    for (const input of inputs) {
      for (const reply of replies) {
        expect({ input, reply, ok: keepsUserLines(input, withUserLines(input, reply)) }).toEqual({
          input,
          reply,
          ok: true,
        });
      }
    }
  });
});
