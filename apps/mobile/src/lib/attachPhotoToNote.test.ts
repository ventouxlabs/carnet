// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./writer", () => ({
  getModificationTime: vi.fn(async () => 1000),
  readNote: vi.fn(async () => ""),
  updateNoteIfUnchanged: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./vaultImageInsert", () => ({
  writeCapturedVaultImage: vi.fn(async () => ({
    rel: "../Photos/photo.jpg",
    dataUri: null,
  })),
}));

import { attachPhotoToNote } from "./attachPhotoToNote";
import { getModificationTime, readNote, updateNoteIfUnchanged } from "./writer";
import { writeCapturedVaultImage } from "./vaultImageInsert";

const mockMtime = vi.mocked(getModificationTime);
const mockReadNote = vi.mocked(readNote);
const mockUpdateNote = vi.mocked(updateNoteIfUnchanged);
const mockWriteImage = vi.mocked(writeCapturedVaultImage);

const NOTE = "---\ncreated: 2026-08-13\n---\n# Walk\n\nSaw the heron again.\n";

const INPUT = { filepath: "f.md", base64: "AAAA", mime: "image/jpeg" };

beforeEach(() => {
  vi.clearAllMocks();
  mockMtime.mockResolvedValue(1000);
  mockReadNote.mockResolvedValue(NOTE);
  mockUpdateNote.mockResolvedValue({ ok: true });
  mockWriteImage.mockResolvedValue({ rel: "../Photos/photo.jpg", dataUri: null });
});

describe("attachPhotoToNote", () => {
  it("appends the embed to the end of the body, frontmatter byte-intact", async () => {
    const out = await attachPhotoToNote(INPUT);

    expect(out).toEqual({
      kind: "attached",
      rel: "../Photos/photo.jpg",
      nextBody: `${NOTE.trimEnd()}\n\n![](../Photos/photo.jpg)\n`,
    });
    const written = mockUpdateNote.mock.calls[0][1];
    expect(written.startsWith("---\ncreated: 2026-08-13\n---\n")).toBe(true);
    expect(written.endsWith("![](../Photos/photo.jpg)\n")).toBe(true);
    expect(written).toContain("Saw the heron again.");
  });

  it("separates the embed cleanly on a note with no trailing newline", async () => {
    mockReadNote.mockResolvedValue("# Walk\n\nno trailing newline");
    await attachPhotoToNote(INPUT);
    expect(mockUpdateNote.mock.calls[0][1]).toBe(
      "# Walk\n\nno trailing newline\n\n![](../Photos/photo.jpg)\n",
    );
  });

  it("keeps existing attachments and adds the new one after them", async () => {
    mockReadNote.mockResolvedValue("# Walk\n\n![](../Photos/first.jpg)\n\nprose\n");
    await attachPhotoToNote(INPUT);
    const written = mockUpdateNote.mock.calls[0][1];
    expect(written).toContain("![](../Photos/first.jpg)");
    expect(written.endsWith("![](../Photos/photo.jpg)\n")).toBe(true);
  });

  // ── The guard ──────────────────────────────────────────────────────────────

  it("captures the mtime baseline BEFORE the image write, not after", async () => {
    // A baseline taken after the image write would match whatever an
    // interleaved write produced, collapsing the guarded span to nothing.
    const order: string[] = [];
    mockMtime.mockImplementation(async () => {
      order.push("mtime");
      return 1000;
    });
    mockWriteImage.mockImplementation(async () => {
      order.push("write-image");
      return { rel: "../Photos/photo.jpg", dataUri: null };
    });

    await attachPhotoToNote(INPUT);

    expect(order).toEqual(["mtime", "write-image"]);
  });

  it("keeps the user's on-disk version when a write lands inside the guarded span", async () => {
    // THE test. A simulated disk rather than a canned `{ ok: false }`, so the
    // whole chain is exercised: baseline → image write → re-read → guarded
    // write. Note the scope: this covers a write that lands in the short
    // write-image → overwrite span, NOT the user's framing time (which is
    // upstream of this function — see the mid-camera test above). An unguarded
    // overwrite discards it: the #133 defect class.
    let disk = NOTE;
    let mtime = 1000;
    const USER_EDIT = "---\ncreated: 2026-08-13\n---\n# Walk\n\nEDITED IN OBSIDIAN.\n";

    mockMtime.mockImplementation(async () => mtime);
    mockReadNote.mockImplementation(async () => disk);
    mockUpdateNote.mockImplementation(async (_fp, markdown, expected) => {
      if (expected !== null && expected !== mtime) {
        return { ok: false, reason: "conflict" as const };
      }
      disk = markdown;
      mtime += 1;
      return { ok: true };
    });
    // Obsidian saves while the image is being written to the vault — i.e.
    // after the baseline was taken.
    mockWriteImage.mockImplementation(async () => {
      disk = USER_EDIT;
      mtime = 2000;
      return { rel: "../Photos/photo.jpg", dataUri: null };
    });

    const out = await attachPhotoToNote(INPUT);

    expect(out.kind).toBe("failed");
    expect(out).toMatchObject({
      reason: expect.stringMatching(/written to from somewhere else/i),
    });
    // The user's edit survived byte-for-byte; no embed was spliced in over it.
    expect(disk).toBe(USER_EDIT);
    expect(disk).not.toContain("![](../Photos/photo.jpg)");
  });

  it("writes through when nothing touched the note during the flight", async () => {
    // Same simulated disk as the guard test — proves the guard is not simply
    // refusing every write.
    let disk = NOTE;
    const mtime = 1000;
    mockMtime.mockImplementation(async () => mtime);
    mockReadNote.mockImplementation(async () => disk);
    mockUpdateNote.mockImplementation(async (_fp, markdown, expected) => {
      if (expected !== null && expected !== mtime) {
        return { ok: false, reason: "conflict" as const };
      }
      disk = markdown;
      return { ok: true };
    });

    const out = await attachPhotoToNote(INPUT);

    expect(out.kind).toBe("attached");
    expect(disk).toBe(`${NOTE.trimEnd()}\n\n![](../Photos/photo.jpg)\n`);
  });

  it("appends to the file's CURRENT content, never a caller-held snapshot", async () => {
    // Everything appended must derive from the fresh read; a stale screen copy
    // written back would silently revert an edit made since screen load.
    mockReadNote.mockResolvedValue("# Walk\n\nEDITED IN OBSIDIAN.\n");

    await attachPhotoToNote(INPUT);

    const written = mockUpdateNote.mock.calls[0][1];
    expect(written).toContain("EDITED IN OBSIDIAN.");
  });

  it("keeps BOTH an edit made while the camera was open and the new photo", async () => {
    // The framing window sits upstream of this function, so such an edit is
    // never a conflict: it is already on disk when the baseline is taken, the
    // fresh read picks it up, and the embed is appended to it. Documents the
    // real behavior — the attach succeeds, nothing is lost either way.
    let disk = NOTE;
    const EDITED = "---\ncreated: 2026-08-13\n---\n# Walk\n\nEDITED WHILE FRAMING.\n";
    disk = EDITED;
    mockReadNote.mockImplementation(async () => disk);
    mockUpdateNote.mockImplementation(async (_fp, markdown) => {
      disk = markdown;
      return { ok: true };
    });

    const out = await attachPhotoToNote(INPUT);

    expect(out.kind).toBe("attached");
    expect(disk).toContain("EDITED WHILE FRAMING.");
    expect(disk).toContain("![](../Photos/photo.jpg)");
  });

  it("re-reads the note AFTER the image write, so late edits are seen", async () => {
    const order: string[] = [];
    mockWriteImage.mockImplementation(async () => {
      order.push("write-image");
      return { rel: "../Photos/photo.jpg", dataUri: null };
    });
    mockReadNote.mockImplementation(async () => {
      order.push("read");
      return NOTE;
    });

    await attachPhotoToNote(INPUT);

    expect(order).toEqual(["write-image", "read"]);
  });

  // ── Never throws ───────────────────────────────────────────────────────────

  it("returns failed (never throws) when the image write rejects", async () => {
    mockWriteImage.mockRejectedValue(new Error("Photos are capped at 200 MB"));
    const out = await attachPhotoToNote(INPUT);
    expect(out).toEqual({ kind: "failed", reason: "Photos are capped at 200 MB" });
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("returns failed when the note is unreadable, rather than appending blind", async () => {
    mockReadNote.mockRejectedValue(new Error("gone"));
    const out = await attachPhotoToNote(INPUT);
    expect(out.kind).toBe("failed");
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });

  it("returns failed when the guarded write itself rejects", async () => {
    mockUpdateNote.mockRejectedValue(new Error("disk full"));
    expect(await attachPhotoToNote(INPUT)).toEqual({
      kind: "failed",
      reason: "disk full",
    });
  });
});
