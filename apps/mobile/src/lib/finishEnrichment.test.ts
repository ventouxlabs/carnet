// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./writer", () => ({
  getModificationTime: vi.fn(async () => 1000),
  readNote: vi.fn(async () => {
    throw new Error("not stubbed");
  }),
  // Stand-in for the real listPairedBinaries (unit-tested in writer.test.ts),
  // matching its `../{subdir}/{name}` convention and de-dup behaviour — the
  // real module can't be imported here (see the importActual note below).
  listPairedBinaries: vi.fn((body: string) => {
    const out: { subdir: string; filename: string; rel: string }[] = [];
    const seen = new Set<string>();
    for (const m of body.matchAll(/\.\.\/(Photos|Audio|Files)\/([^/\s)]+)/g)) {
      const rel = `../${m[1]}/${m[2]}`;
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push({ subdir: m[1], filename: m[2], rel });
    }
    return out;
  }),
}));
// Fully mocked, not importActual: the real module reaches expo-modules-core,
// which needs a React Native runtime (`__DEV__`). Same approach as
// enhanceProse.test.ts's dispatcher mock.
vi.mock("./ideaSaveFirst", () => ({
  enrichIdeaInPlace: vi.fn(),
  PENDING_ENRICH_STATUS: "pending-enrich",
}));
vi.mock("./personInPlace", () => ({
  enrichPersonInPlace: vi.fn(),
}));

import {
  finishPendingEnrichment,
  isPendingEnrich,
  isReEnrichableMode,
  reEnrichNoteInPlace,
} from "./finishEnrichment";
import { getModificationTime, readNote } from "./writer";
import { enrichIdeaInPlace } from "./ideaSaveFirst";
import { enrichPersonInPlace } from "./personInPlace";

const mockMtime = vi.mocked(getModificationTime);
const mockReadNote = vi.mocked(readNote);
const mockEnrich = vi.mocked(enrichIdeaInPlace);
const mockPerson = vi.mocked(enrichPersonInPlace);

const PENDING = `---
created: 2026-08-08T13:54:22.852Z
status: pending-enrich
tags: [travel]
location: 47.20114,10.11660
---
Stroudsburg Pennsylvania and the Pocono Mountains region.
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockMtime.mockResolvedValue(1000);
  mockReadNote.mockResolvedValue(PENDING);
  mockEnrich.mockResolvedValue({ kind: "updated", markdown: "# Enriched\n\nbody\n" });
  mockPerson.mockResolvedValue({ kind: "updated", markdown: "# Person\n" });
});

describe("isPendingEnrich", () => {
  it("detects a raw save-first capture", () => {
    expect(isPendingEnrich(PENDING)).toBe(true);
  });

  it("is false for an enriched note", () => {
    expect(isPendingEnrich("---\nstatus: seedling\n---\nbody")).toBe(false);
  });

  it("is false for a note with no frontmatter at all", () => {
    expect(isPendingEnrich("just prose")).toBe(false);
  });
});

describe("finishPendingEnrichment", () => {
  it("enriches the raw text and returns the new markdown", async () => {
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out).toEqual({ kind: "updated", markdown: "# Enriched\n\nbody\n" });
    // The user's raw text is what goes to the model — not the frontmatter.
    const arg = mockEnrich.mock.calls[0][0];
    expect(arg.text).toBe("Stroudsburg Pennsylvania and the Pocono Mountains region.");
    expect(arg.text).not.toContain("status:");
  });

  it("preserves the tags and location the user set at capture", async () => {
    await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    const arg = mockEnrich.mock.calls[0][0];
    expect(arg.tags).toEqual(["travel"]);
    expect(arg.location).toBe("47.20114,10.11660");
  });

  it("preserves the attachments the raw note already embeds", async () => {
    // A save-first raw note embeds its binaries before enrichment runs, so the
    // enriched overwrite has to be handed them back or they are dropped.
    const pendingWithImage = PENDING.replace(
      "Stroudsburg",
      "![](../Photos/sketch.png)\n\nStroudsburg",
    );
    mockReadNote.mockResolvedValue(pendingWithImage);
    await finishPendingEnrichment({ body: pendingWithImage, filepath: "f.md" });
    expect(mockEnrich.mock.calls[0][0].attachments).toEqual([
      { kind: "image", rel: "../Photos/sketch.png", filename: "sketch.png" },
    ]);
  });

  it("captures the mtime baseline BEFORE the model call", async () => {
    // Same ordering enhanceProse.ts uses: a baseline taken after the call would
    // match whatever a mid-flight edit produced, making the guard useless.
    const order: string[] = [];
    mockMtime.mockImplementation(async () => {
      order.push("mtime");
      return 1000;
    });
    mockEnrich.mockImplementation(async () => {
      order.push("enrich");
      return { kind: "updated", markdown: "x" };
    });
    await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(order).toEqual(["mtime", "enrich"]);
  });

  it("hands the on-disk note to both in-place paths so their frontmatter survives", async () => {
    // The prompts are fed the BODY only, so every frontmatter field (a Person
    // note's email/phone/company, an Idea's hand-added field) is invisible to
    // the model and comes back missing unless the source note goes along.
    const onDisk = ENRICHED.replace("---\n", "---\nemail: ada@example.com\n");
    mockReadNote.mockResolvedValue(onDisk);
    await reEnrichNoteInPlace({ body: ENRICHED, filepath: "p.md", mode: "person" });
    expect(mockPerson.mock.calls[0][0].preserveFrontmatterFrom).toBe(onDisk);
    await reEnrichNoteInPlace({ body: ENRICHED, filepath: "f.md", mode: "idea" });
    expect(mockEnrich.mock.calls[0][0].preserveFrontmatterFrom).toBe(onDisk);
  });

  it("prefers the file's CURRENT content over the caller's snapshot", async () => {
    mockReadNote.mockResolvedValue(
      PENDING.replace("Stroudsburg Pennsylvania", "EDITED ON DISK"),
    );
    await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(mockEnrich.mock.calls[0][0].text).toContain("EDITED ON DISK");
  });

  it("refuses a note that is not awaiting enrichment", async () => {
    mockReadNote.mockResolvedValue("---\nstatus: seedling\n---\nbody");
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out.kind).toBe("failed");
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("surfaces a mid-flight conflict as a reason rather than clobbering", async () => {
    // This is the exact state the feature exists for: the queued drain already
    // conflicted once and dropped its row. A second conflict must not overwrite.
    mockEnrich.mockResolvedValue({ kind: "conflict" });
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/changed while/i);
  });

  it("never throws — a failed enrichment comes back as a reason", async () => {
    mockEnrich.mockResolvedValue({ kind: "failed", transient: true, reason: "network down" });
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out).toEqual({ kind: "failed", reason: "network down" });
  });

  it("never throws when the mtime read itself blows up", async () => {
    mockMtime.mockRejectedValue(new Error("SAF exploded"));
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out.kind).toBe("failed");
  });

  it("refuses a pending note whose body is empty", async () => {
    mockReadNote.mockResolvedValue("---\nstatus: pending-enrich\n---\n\n");
    const out = await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(out.kind).toBe("failed");
    expect(mockEnrich).not.toHaveBeenCalled();
  });
});

const ENRICHED = `---
created: 2026-08-08T13:54:22.852Z
status: seedling
tags: [travel]
location: 47.20114,10.11660
---
Stroudsburg Pennsylvania and the Pocono Mountains region.
`;

/** Same note, plus the two embed shapes injectAttachments emits: an image
 * under the H1 and a `## Files` link. */
const WITH_ATTACHMENTS = `---
created: 2026-08-08T13:54:22.852Z
status: seedling
tags: [travel]
location: 47.20114,10.11660
---
# Pocono notes

![](../Photos/sketch.png)

Stroudsburg Pennsylvania and the Pocono Mountains region.

## Files

[spec.pdf](../Files/spec.pdf)
`;

describe("isReEnrichableMode", () => {
  it("accepts the one-note-per-file text modes", () => {
    expect(isReEnrichableMode("idea")).toBe(true);
    expect(isReEnrichableMode("person")).toBe(true);
  });

  it("rejects journal — its day file holds many entries, not one note", () => {
    expect(isReEnrichableMode("journal")).toBe(false);
  });

  it("rejects the binary-backed modes, which reprocess via their own paths", () => {
    expect(isReEnrichableMode("photo")).toBe(false);
    expect(isReEnrichableMode("audio")).toBe(false);
  });
});

describe("reEnrichNoteInPlace", () => {
  beforeEach(() => {
    mockReadNote.mockResolvedValue(ENRICHED);
  });

  it("re-enriches an already-enriched Idea — no pending gate", async () => {
    // finishPendingEnrichment refuses this exact note; this function must not.
    const out = await reEnrichNoteInPlace({ body: ENRICHED, filepath: "f.md", mode: "idea" });
    expect(out).toEqual({ kind: "updated", markdown: "# Enriched\n\nbody\n" });
    const arg = mockEnrich.mock.calls[0][0];
    expect(arg.text).toBe("Stroudsburg Pennsylvania and the Pocono Mountains region.");
    expect(arg.tags).toEqual(["travel"]);
    expect(arg.location).toBe("47.20114,10.11660");
  });

  it("refuses a journal note without reading or writing anything", async () => {
    // A day file holds many `## HH:MM` entries; a whole-file overwrite would
    // collapse them into one enrichment of the concatenated text.
    const out = await reEnrichNoteInPlace({ body: ENRICHED, filepath: "j.md", mode: "journal" });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/whole day's entries/i);
    expect(mockMtime).not.toHaveBeenCalled();
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockPerson).not.toHaveBeenCalled();
  });

  it("dispatches a person note to enrichPersonInPlace", async () => {
    const out = await reEnrichNoteInPlace({ body: ENRICHED, filepath: "p.md", mode: "person" });
    expect(out).toEqual({ kind: "updated", markdown: "# Person\n" });
    expect(mockPerson).toHaveBeenCalledWith({
      filepath: "p.md",
      expectedMtime: 1000,
      expectedContent: ENRICHED,
      ocrResult: "Stroudsburg Pennsylvania and the Pocono Mountains region.",
      context: "",
      preserveFrontmatterFrom: ENRICHED,
      tags: ["travel"],
      location: "47.20114,10.11660",
      attachments: [],
    });
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("carries the note's existing attachments back into the Idea enrichment", async () => {
    // Regression: the enriched write replaces the whole file, so an attachment
    // not handed to applyEnrichedIdea is stripped from the note and its binary
    // is orphaned on disk. The body's embeds are the only record of them.
    mockReadNote.mockResolvedValue(WITH_ATTACHMENTS);
    await reEnrichNoteInPlace({ body: WITH_ATTACHMENTS, filepath: "f.md", mode: "idea" });
    expect(mockEnrich.mock.calls[0][0].attachments).toEqual([
      { kind: "image", rel: "../Photos/sketch.png", filename: "sketch.png" },
      { kind: "file", rel: "../Files/spec.pdf", filename: "spec.pdf" },
    ]);
  });

  it("carries the note's existing attachments back into the Person enrichment", async () => {
    // A Person note's card photo lives in exactly such an embed.
    mockReadNote.mockResolvedValue(WITH_ATTACHMENTS);
    await reEnrichNoteInPlace({ body: WITH_ATTACHMENTS, filepath: "p.md", mode: "person" });
    expect(mockPerson.mock.calls[0][0].attachments).toEqual([
      { kind: "image", rel: "../Photos/sketch.png", filename: "sketch.png" },
      { kind: "file", rel: "../Files/spec.pdf", filename: "spec.pdf" },
    ]);
  });

  it("refuses an unsupported mode without touching the file", async () => {
    const out = await reEnrichNoteInPlace({ body: ENRICHED, filepath: "ph.md", mode: "photo" });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/cannot be re-enriched/i);
    expect(mockMtime).not.toHaveBeenCalled();
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("captures the mtime baseline BEFORE the model call", async () => {
    const order: string[] = [];
    mockMtime.mockImplementation(async () => {
      order.push("mtime");
      return 1000;
    });
    mockPerson.mockImplementation(async () => {
      order.push("enrich");
      return { kind: "updated", markdown: "x" };
    });
    await reEnrichNoteInPlace({ body: ENRICHED, filepath: "p.md", mode: "person" });
    expect(order).toEqual(["mtime", "enrich"]);
  });

  it("prefers the file's CURRENT content over the caller's snapshot", async () => {
    mockReadNote.mockResolvedValue(ENRICHED.replace("Stroudsburg Pennsylvania", "EDITED ON DISK"));
    await reEnrichNoteInPlace({ body: ENRICHED, filepath: "f.md", mode: "idea" });
    expect(mockEnrich.mock.calls[0][0].text).toContain("EDITED ON DISK");
  });

  it("falls back to the caller's snapshot when the file is unreadable", async () => {
    mockReadNote.mockRejectedValue(new Error("gone"));
    const out = await reEnrichNoteInPlace({ body: ENRICHED, filepath: "f.md", mode: "idea" });
    expect(out.kind).toBe("updated");
    expect(mockEnrich.mock.calls[0][0].text).toContain("Stroudsburg Pennsylvania");
  });

  it("refuses a note whose body is empty", async () => {
    mockReadNote.mockResolvedValue("---\nstatus: seedling\n---\n\n");
    const out = await reEnrichNoteInPlace({ body: "", filepath: "f.md", mode: "idea" });
    expect(out.kind).toBe("failed");
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("surfaces a mid-flight conflict as a reason rather than clobbering", async () => {
    mockPerson.mockResolvedValue({ kind: "conflict" });
    const out = await reEnrichNoteInPlace({ body: ENRICHED, filepath: "p.md", mode: "person" });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/changed while/i);
  });

  it("never throws — a failed enrichment comes back as a reason", async () => {
    mockPerson.mockResolvedValue({ kind: "failed", transient: true, reason: "network down" });
    const out = await reEnrichNoteInPlace({ body: ENRICHED, filepath: "p.md", mode: "person" });
    expect(out).toEqual({ kind: "failed", reason: "network down" });
  });

  it("never throws when the mtime read itself blows up", async () => {
    mockMtime.mockRejectedValue(new Error("SAF exploded"));
    const out = await reEnrichNoteInPlace({ body: ENRICHED, filepath: "f.md", mode: "idea" });
    expect(out.kind).toBe("failed");
  });
});
