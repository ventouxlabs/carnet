import { describe, expect, it } from "vitest";
import {
  buildPreviewSubtitle,
  buildMetaSummary,
  buildCapturePreviewResponse,
  computeCanSubmit,
  saveFirstTitle,
} from "./captureDisplay";
import type { PickedAttachment } from "./attachments";

describe("buildPreviewSubtitle", () => {
  it("builds the Ideas filename + model for idea mode", () => {
    expect(
      buildPreviewSubtitle({
        mode: "idea",
        pendingIdea: { slug: "my-idea" },
        pendingJournal: null,
        pendingPerson: null,
        omniModel: "gpt-4",
      }),
    ).toBe("Ideas/my-idea.md • gpt-4");
  });

  it("builds the Journal filename for journal mode", () => {
    expect(
      buildPreviewSubtitle({
        mode: "journal",
        pendingIdea: null,
        pendingJournal: { date: "2026-07-30" },
        pendingPerson: null,
        omniModel: null,
      }),
    ).toBe("Journal/2026-07-30.md");
  });

  it("builds the People filename for person mode", () => {
    expect(
      buildPreviewSubtitle({
        mode: "person",
        pendingIdea: null,
        pendingJournal: null,
        pendingPerson: { firstName: "Jane", lastName: "Doe" },
        omniModel: "claude",
      }),
    ).toBe("People/Jane-Doe.md • claude");
  });

  it("returns an empty-filename subtitle when the mode's pending object isn't set yet", () => {
    expect(
      buildPreviewSubtitle({
        mode: "idea",
        pendingIdea: null,
        pendingJournal: null,
        pendingPerson: null,
        omniModel: null,
      }),
    ).toBe("");
  });
});

function picked(overrides: Partial<PickedAttachment> = {}): PickedAttachment {
  return {
    base64: "AAAA",
    mime: "image/png",
    filename: "sketch.png",
    kind: "image",
    ...overrides,
  } as PickedAttachment;
}

describe("buildMetaSummary", () => {
  it("returns an empty string when nothing is staged", () => {
    expect(buildMetaSummary([], [], null)).toBe("");
  });

  it("pluralizes tag/attachment counts and joins with a middle dot", () => {
    expect(buildMetaSummary(["a", "b"], [picked(), picked()], "1,2")).toBe(
      "2 tags · 2 attachments · location",
    );
  });

  it("keeps singular wording at count 1", () => {
    expect(buildMetaSummary(["a"], [picked()], null)).toBe("1 tag · 1 attachment");
  });
});

describe("buildCapturePreviewResponse", () => {
  it("builds an ok-status response without a filepath by default", () => {
    expect(buildCapturePreviewResponse("# Hi")).toEqual({
      type: "capture_response",
      request_id: "",
      status: "ok",
      preview_markdown: "# Hi",
      filepath: undefined,
    });
  });

  it("includes the filepath when provided (promote after a saved note)", () => {
    expect(buildCapturePreviewResponse("# Hi", "file:///v/Ideas/hi.md")).toEqual({
      type: "capture_response",
      request_id: "",
      status: "ok",
      preview_markdown: "# Hi",
      filepath: "file:///v/Ideas/hi.md",
    });
  });
});

describe("computeCanSubmit", () => {
  it("is false outside the input phase regardless of content", () => {
    expect(
      computeCanSubmit({ phase: "submitting", mode: "idea", text: "hello", transcript: "", ocrText: "" }),
    ).toBe(false);
    expect(
      computeCanSubmit({ phase: "preview", mode: "idea", text: "hello", transcript: "", ocrText: "" }),
    ).toBe(false);
  });

  it("idea requires non-blank text", () => {
    expect(
      computeCanSubmit({ phase: "input", mode: "idea", text: "", transcript: "", ocrText: "" }),
    ).toBe(false);
    expect(
      computeCanSubmit({ phase: "input", mode: "idea", text: "   ", transcript: "", ocrText: "" }),
    ).toBe(false);
    expect(
      computeCanSubmit({ phase: "input", mode: "idea", text: "hi", transcript: "", ocrText: "" }),
    ).toBe(true);
  });

  it("journal accepts either transcript or text", () => {
    expect(
      computeCanSubmit({ phase: "input", mode: "journal", text: "", transcript: "", ocrText: "" }),
    ).toBe(false);
    expect(
      computeCanSubmit({ phase: "input", mode: "journal", text: "notes", transcript: "", ocrText: "" }),
    ).toBe(true);
    expect(
      computeCanSubmit({ phase: "input", mode: "journal", text: "", transcript: "spoken", ocrText: "" }),
    ).toBe(true);
  });

  it("person accepts either ocrText or text", () => {
    expect(
      computeCanSubmit({ phase: "input", mode: "person", text: "", transcript: "", ocrText: "" }),
    ).toBe(false);
    expect(
      computeCanSubmit({ phase: "input", mode: "person", text: "context", transcript: "", ocrText: "" }),
    ).toBe(true);
    expect(
      computeCanSubmit({ phase: "input", mode: "person", text: "", transcript: "", ocrText: "scanned" }),
    ).toBe(true);
  });
});

describe("computeCanSubmit — note", () => {
  it("needs non-blank text, like idea; stray OCR text never enables it", () => {
    expect(computeCanSubmit({ phase: "input", mode: "note", text: "", transcript: "", ocrText: "" })).toBe(false);
    expect(computeCanSubmit({ phase: "input", mode: "note", text: "   ", transcript: "", ocrText: "" })).toBe(false);
    expect(computeCanSubmit({ phase: "input", mode: "note", text: "- [ ] x", transcript: "", ocrText: "" })).toBe(true);
    // Under the Contact rule this was true.
    expect(computeCanSubmit({ phase: "input", mode: "note", text: "", transcript: "", ocrText: "scanned" })).toBe(false);
  });
});

describe("saveFirstTitle", () => {
  it("uses the text's first line, else the mode's own name", () => {
    expect(saveFirstTitle("Weekend errands\n- [ ] x", "note")).toBe("Weekend errands");
    expect(saveFirstTitle("", "note")).toBe("Note");
    expect(saveFirstTitle("", "idea")).toBe("Idea");
    expect(saveFirstTitle("")).toBe("Idea");
  });
});
