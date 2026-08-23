// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./writer", () => ({
  readPairedBinaryFromNote: vi.fn(),
  updateNote: vi.fn(async () => {}),
  // Real-shape pure splicers so the assertions on the written body are meaningful.
  injectImageEmbed: vi.fn(
    (md: string, rel: string) => `![](${rel})\n\n${md}`,
  ),
  upsertSection: vi.fn(
    (md: string, heading: string, body: string) => `${md}\n\n## ${heading}\n\n${body}\n`,
  ),
}));
vi.mock("./dispatcher", () => ({
  enrichSharedImage: vi.fn(),
  transcribeAudio: vi.fn(),
}));

import { findPairedLink, reEnrichNote, transcribeNote } from "./noteReprocess";
import { readPairedBinaryFromNote, updateNote } from "./writer";
import { enrichSharedImage, transcribeAudio } from "./dispatcher";

const mockRead = vi.mocked(readPairedBinaryFromNote);
const mockUpdateNote = vi.mocked(updateNote);
const mockEnrich = vi.mocked(enrichSharedImage);
const mockTranscribe = vi.mocked(transcribeAudio);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("findPairedLink", () => {
  it("extracts the filename for the requested subdir", () => {
    const body = "# T\n\n![](../Photos/pic-01.jpg)\n";
    expect(findPairedLink(body, "Photos")).toBe("pic-01.jpg");
    expect(findPairedLink(body, "Audio")).toBeNull();
  });

  it("captures only up to the next slash (the filename class rejects '/')", () => {
    // Faithful to writer's link regex: the capture stops at the slash, so a
    // crafted `../Photos/../secret` yields just `..`, never the traversal tail.
    expect(findPairedLink("[x](../Photos/../secret)", "Photos")).toBe("..");
  });

  it("returns null when the subdir link is absent", () => {
    expect(findPairedLink("# no binaries here\n", "Photos")).toBeNull();
  });
});

describe("reEnrichNote", () => {
  it("re-enriches, re-injects the image embed, writes, and returns the new body", async () => {
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockResolvedValue({ markdown: "# Fresh\n\nNew text.\n" } as never);
    const body = "# Old\n\n![](../Photos/pic.jpg)\n";
    const out = await reEnrichNote({ body, filepath: "f.md" });
    expect(mockEnrich).toHaveBeenCalledWith({
      base64: "AAA",
      mimeType: "image/jpeg",
      context: "",
    });
    expect(out).toEqual({
      kind: "updated",
      nextBody: "![](../Photos/pic.jpg)\n\n# Fresh\n\nNew text.\n",
    });
    expect(mockUpdateNote).toHaveBeenCalledWith("f.md", out.kind === "updated" && out.nextBody);
  });

  it("fails cleanly when there is no paired image (no read, no write)", async () => {
    const out = await reEnrichNote({ body: "# No image\n", filepath: "f.md" });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") throw new Error("unreachable");
    expect(out.reason).toMatch(/No paired image/);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("surfaces an enrichment error as failed", async () => {
    mockRead.mockResolvedValue({ base64: "AAA", mime: "image/jpeg" });
    mockEnrich.mockRejectedValue(new Error("LLM down"));
    const out = await reEnrichNote({
      body: "# T\n\n![](../Photos/p.jpg)\n",
      filepath: "f.md",
    });
    expect(out).toEqual({ kind: "failed", reason: "LLM down" });
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });
});

describe("transcribeNote", () => {
  it("transcribes, upserts a Transcript section, writes, and returns the new body", async () => {
    mockRead.mockResolvedValue({ base64: "BBB", mime: "audio/m4a" });
    mockTranscribe.mockResolvedValue({ text: "hello world", model: "on-device" });
    const body = "# Voice\n\n[audio](../Audio/rec.m4a)\n";
    const out = await transcribeNote({ body, filepath: "f.md" });
    expect(mockTranscribe).toHaveBeenCalledWith({
      base64: "BBB",
      mimeType: "audio/m4a",
      filename: "rec.m4a",
    });
    expect(out.kind).toBe("updated");
    if (out.kind !== "updated") throw new Error("unreachable");
    expect(out.nextBody).toContain("## Transcript");
    expect(out.nextBody).toContain("hello world");
    expect(mockUpdateNote).toHaveBeenCalledWith("f.md", out.nextBody);
  });

  it("fails cleanly when there is no paired audio", async () => {
    const out = await transcribeNote({ body: "# No audio\n", filepath: "f.md" });
    expect(out.kind).toBe("failed");
    if (out.kind !== "failed") throw new Error("unreachable");
    expect(out.reason).toMatch(/No paired audio/);
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });
});
