// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { planWysiwygSave } from "./wysiwygSave";

const HEADER = "---\ntags: [work]\n---\n";
const BODY = "# Note\n\nHello.\n";
const CURRENT = HEADER + BODY;

describe("planWysiwygSave", () => {
  it("keeps the header byte-exact and skips the write when nothing changed", () => {
    const plan = planWysiwygSave({
      header: HEADER,
      editedBody: BODY,
      editTags: ["work"],
      originalTags: ["work"],
      currentBody: CURRENT,
    });
    expect(plan.next).toBe(CURRENT);
    expect(plan.tagsChanged).toBe(false);
    expect(plan.shouldWrite).toBe(false);
  });

  it("writes when the body changed but the tags did not", () => {
    const plan = planWysiwygSave({
      header: HEADER,
      editedBody: "# Note\n\nEdited.\n",
      editTags: ["work"],
      originalTags: ["work"],
      currentBody: CURRENT,
    });
    expect(plan.tagsChanged).toBe(false);
    expect(plan.shouldWrite).toBe(true);
    expect(plan.next).toBe(HEADER + "# Note\n\nEdited.\n");
  });

  it("flags a tag change (and thus a write) when the tag set differs", () => {
    const plan = planWysiwygSave({
      header: HEADER,
      editedBody: BODY,
      editTags: ["work", "urgent"],
      originalTags: ["work"],
      currentBody: CURRENT,
    });
    expect(plan.tagsChanged).toBe(true);
    expect(plan.shouldWrite).toBe(true);
    expect(plan.next).toContain("urgent");
  });

  it("treats a tag-set reorder as unchanged (order-independent)", () => {
    const plan = planWysiwygSave({
      header: "---\ntags: [a, b]\n---\n",
      editedBody: BODY,
      editTags: ["b", "a"],
      originalTags: ["a", "b"],
      currentBody: "---\ntags: [a, b]\n---\n" + BODY,
    });
    expect(plan.tagsChanged).toBe(false);
    expect(plan.shouldWrite).toBe(false);
  });
});
