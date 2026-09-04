import { describe, it, expect } from "vitest";
import {
  extractChecklistLines,
  toggleChecklistLine,
  CHECKLIST_TEXT_MAX,
  ChecklistLine,
} from "./checklist";

describe("extractChecklistLines", () => {
  it("extracts unchecked items", () => {
    const markdown = "- [ ] Buy milk\n- [ ] Walk dog";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([
      { text: "Buy milk", checked: false },
      { text: "Walk dog", checked: false },
    ]);
  });

  it("extracts checked items", () => {
    const markdown = "- [x] Fix bug\n- [x] Deploy";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([
      { text: "Fix bug", checked: true },
      { text: "Deploy", checked: true },
    ]);
  });

  it("treats capital X as checked", () => {
    const markdown = "- [X] Important task\n- [ ] Next task";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([
      { text: "Important task", checked: true },
      { text: "Next task", checked: false },
    ]);
  });

  it("extracts indented/nested checklist items", () => {
    const markdown = "- Parent\n  - [ ] Nested unchecked\n    - [x] Deeply nested checked";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([
      { text: "Nested unchecked", checked: false },
      { text: "Deeply nested checked", checked: true },
    ]);
  });

  it("handles mixed checked and unchecked in order", () => {
    const markdown = "- [ ] First\n- [x] Second\n- [ ] Third\n- [x] Fourth";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([
      { text: "First", checked: false },
      { text: "Second", checked: true },
      { text: "Third", checked: false },
      { text: "Fourth", checked: true },
    ]);
  });

  it("trims whitespace from extracted text", () => {
    const markdown = "-   [ ]    Buy milk   \n\t-\t[x]\t\tWalk dog\t";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([
      { text: "Buy milk", checked: false },
      { text: "Walk dog", checked: true },
    ]);
  });

  it("caps long text at CHECKLIST_TEXT_MAX", () => {
    const longText = "a".repeat(500);
    const markdown = `- [ ] ${longText}`;
    const result = extractChecklistLines(markdown);
    expect(result[0].text.length).toBe(CHECKLIST_TEXT_MAX);
    expect(result[0].text).toBe("a".repeat(CHECKLIST_TEXT_MAX));
  });

  it("ignores text-only lines that look similar but aren't checkboxes", () => {
    const markdown = "Some text\n-[ ]No space after dash\n- [ no bracket\n- ( ) wrong brackets";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([]);
  });

  it("strips frontmatter before extracting", () => {
    const markdown =
      "---\ntitle: Test\ntags: [- [ ] fake]\n---\n- [ ] Real item\n- [x] Another";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([
      { text: "Real item", checked: false },
      { text: "Another", checked: true },
    ]);
  });

  it("returns empty array when no checklist items present", () => {
    const markdown = "Just some regular text\nwith no checklists";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([]);
  });

  it("ignores empty text after checkbox", () => {
    const markdown = "- [ ] \n- [ ]   \n- [x] Actual item";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([{ text: "Actual item", checked: true }]);
  });

  it("handles multiple spaces/tabs around checkbox syntax", () => {
    const markdown = "-  \t  [  x  ]  Text";
    const result = extractChecklistLines(markdown);
    expect(result.length).toBe(0); // The inner spaces break the pattern
  });

  it("extracts multiple items from same line separated by newlines", () => {
    const markdown =
      "---\nheader: value\n---\n- [ ] Item 1\n\n- [x] Item 2\n\n\n- [ ] Item 3";
    const result = extractChecklistLines(markdown);
    expect(result).toEqual<ChecklistLine[]>([
      { text: "Item 1", checked: false },
      { text: "Item 2", checked: true },
      { text: "Item 3", checked: false },
    ]);
  });
});

describe("toggleChecklistLine", () => {
  it("toggles unchecked to checked", () => {
    const markdown = "- [ ] Buy milk";
    const result = toggleChecklistLine(markdown, "Buy milk", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe("- [x] Buy milk");
    }
  });

  it("toggles checked to unchecked", () => {
    const markdown = "- [x] Buy milk";
    const result = toggleChecklistLine(markdown, "Buy milk", true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe("- [ ] Buy milk");
    }
  });

  it("toggles capital X to unchecked", () => {
    const markdown = "- [X] Important task";
    const result = toggleChecklistLine(markdown, "Important task", true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe("- [ ] Important task");
    }
  });

  it("toggles to capital X on check", () => {
    const markdown = "- [ ] Important task";
    const result = toggleChecklistLine(markdown, "Important task", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe("- [x] Important task");
    }
  });

  it("toggles indented items", () => {
    const markdown = "- Parent\n  - [ ] Nested task";
    const result = toggleChecklistLine(markdown, "Nested task", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe("- Parent\n  - [x] Nested task");
    }
  });

  it("leaves other items untouched when toggling", () => {
    const markdown = "- [ ] Item 1\n- [ ] Item 2\n- [x] Item 3";
    const result = toggleChecklistLine(markdown, "Item 2", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe("- [ ] Item 1\n- [x] Item 2\n- [x] Item 3");
    }
  });

  it("returns not_found when text doesn't exist", () => {
    const markdown = "- [ ] Item 1\n- [ ] Item 2";
    const result = toggleChecklistLine(markdown, "Nonexistent", false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns not_found when checked state doesn't match", () => {
    const markdown = "- [x] Item 1";
    const result = toggleChecklistLine(markdown, "Item 1", false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  it("returns ambiguous when multiple lines match text and state", () => {
    const markdown = "- [ ] Duplicate\n- [ ] Other\n- [ ] Duplicate";
    const result = toggleChecklistLine(markdown, "Duplicate", false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
    }
  });

  it("distinguishes between checked and unchecked duplicates", () => {
    const markdown = "- [ ] Duplicate\n- [x] Duplicate";
    const result = toggleChecklistLine(markdown, "Duplicate", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe("- [x] Duplicate\n- [x] Duplicate");
    }
  });

  it("trims text before matching", () => {
    const markdown = "-  [ ]  Buy milk  ";
    const result = toggleChecklistLine(markdown, "Buy milk", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toContain("[x]");
    }
  });

  it("caps text at CHECKLIST_TEXT_MAX when matching", () => {
    const longText = "a".repeat(400);
    const truncatedText = "a".repeat(CHECKLIST_TEXT_MAX);
    const markdown = `- [ ] ${longText}`;
    const result = toggleChecklistLine(markdown, truncatedText, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toContain("[x]");
    }
  });

  it("preserves leading whitespace/indentation when toggling", () => {
    const markdown = "    - [ ] Indented item";
    const result = toggleChecklistLine(markdown, "Indented item", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toMatch(/^\s{4}-\s\[x\]/);
    }
  });

  it("preserves trailing content after checkbox", () => {
    const markdown = "- [ ] Item with trailing content";
    const result = toggleChecklistLine(markdown, "Item with trailing content", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toContain("[x] Item with trailing content");
    }
  });

  it("handles multiline document with frontmatter-like text in body", () => {
    const markdown =
      "Regular line\n- [ ] Real item\nSome --- text\n- [x] Another item";
    const result = toggleChecklistLine(markdown, "Real item", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toContain("- [x] Real item");
      expect(result.markdown).toContain("- [x] Another item");
    }
  });

  it("only matches lines that are exactly the expected state", () => {
    const markdown = "- [ ] Task\n- [ ] Task\n- [x] Task";
    // Try to toggle first unchecked "Task" - should fail (ambiguous)
    const result = toggleChecklistLine(markdown, "Task", false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
    }
  });

  it("handles text with special regex characters", () => {
    const markdown = "- [ ] Item with [brackets] and (parens)";
    const result = toggleChecklistLine(markdown, "Item with [brackets] and (parens)", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toContain("[x]");
    }
  });

  it("preserves exact line structure including tabs and multiple spaces", () => {
    const markdown = "-\t[ ]\tItem with tabs";
    const result = toggleChecklistLine(markdown, "Item with tabs", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.markdown.split("\n");
      expect(lines[0]).toMatch(/-\t\[x\]\tItem with tabs/);
    }
  });
});

describe("extractChecklistLines and toggleChecklistLine regex consistency", () => {
  it("extracts same items that toggle can modify", () => {
    const markdown = "- [ ] First\n- [x] Second\n  - [ ] Nested";
    const extracted = extractChecklistLines(markdown);

    for (const item of extracted) {
      const result = toggleChecklistLine(markdown, item.text, item.checked);
      expect(result.ok).toBe(true);
    }
  });

  it("both handle capital X the same way", () => {
    const markdown = "- [X] Capital task";

    const extracted = extractChecklistLines(markdown);
    expect(extracted[0].checked).toBe(true);

    const result = toggleChecklistLine(markdown, "Capital task", true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe("- [ ] Capital task");
    }
  });

  it("frontmatter containing checkbox-like text is never a toggle target", () => {
    const markdown =
      "---\ntitle: Test Note\ntags: [- [ ] fake]\n---\n- [ ] Real item\n- [x] Another";
    const result = toggleChecklistLine(markdown, "Real item", false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe(
        "---\ntitle: Test Note\ntags: [- [ ] fake]\n---\n- [x] Real item\n- [x] Another",
      );
      // Verify frontmatter is preserved byte-for-byte and unchanged
      expect(result.markdown.split("\n").slice(0, 4).join("\n")).toBe(
        "---\ntitle: Test Note\ntags: [- [ ] fake]\n---",
      );
    }
  });

  it("fake checkbox-like text in frontmatter cannot be toggled", () => {
    const markdown = "---\ntags: [- [ ] not-a-real-item]\n---\n";
    const result = toggleChecklistLine(markdown, "not-a-real-item", false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });
});
