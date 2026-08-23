// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// Fully mocked rather than importActual: the real modules reach
// expo-modules-core, which needs a React Native runtime. Same approach as
// finishEnrichment.test.ts. injectAttachments is faked to the minimum shape
// the assertions need (writer.ts's real one is covered by writer.test.ts);
// mergeUserTags / upsertFrontmatterField are NOT mocked, so the tag and
// location assertions below exercise real frontmatter serialization.
vi.mock("./writer", () => ({
  updateNoteIfUnchanged: vi.fn(async () => ({ ok: true })),
  injectAttachments: vi.fn((md: string, atts: readonly { rel: string }[]) =>
    atts.reduce((acc, a) => `${acc}\n\n[](${a.rel})\n`, md),
  ),
}));
vi.mock("./dispatcher", () => ({
  enrichPerson: vi.fn(),
  isNotConfiguredError: vi.fn(() => false),
  isPermanentError: vi.fn(() => false),
  isInsecureTransportError: vi.fn(() => false),
}));

import { enrichPersonInPlace } from "./personInPlace";
import { updateNoteIfUnchanged } from "./writer";
import {
  enrichPerson,
  isInsecureTransportError,
  isNotConfiguredError,
  isPermanentError,
} from "./dispatcher";

const mockUpdate = vi.mocked(updateNoteIfUnchanged);
const mockPerson = vi.mocked(enrichPerson);
const mockNotConfigured = vi.mocked(isNotConfiguredError);
const mockPermanent = vi.mocked(isPermanentError);
const mockInsecure = vi.mocked(isInsecureTransportError);

/** What the model returns: its own frontmatter, no knowledge of the user's
 * tags/location/attachments. */
const MODEL_OUTPUT = "---\nkind: person\n---\n# Ada Lovelace\n\nAnalyst.\n";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({ ok: true });
  mockNotConfigured.mockReturnValue(false);
  mockPermanent.mockReturnValue(false);
  mockInsecure.mockReturnValue(false);
  mockPerson.mockResolvedValue({ markdown: MODEL_OUTPUT, model: "test" });
});

describe("enrichPersonInPlace", () => {
  it("overwrites the given filepath under the mtime guard", async () => {
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "Ada Lovelace, Analyst",
      context: "met at a conference",
      tags: [],
    });
    expect(out.kind).toBe("updated");
    expect(mockPerson).toHaveBeenCalledWith({
      ocrResult: "Ada Lovelace, Analyst",
      context: "met at a conference",
    });
    expect(mockUpdate).toHaveBeenCalledWith("p.md", expect.any(String), 2000, undefined);
  });

  it("forwards the content baseline so SAF notes get a conflict guard at all", async () => {
    // getModificationTime returns null for every content:// URI, so on the
    // normal Android/Syncthing vault the mtime argument is always null and the
    // snapshot is the ONLY baseline updateNoteIfUnchanged can compare.
    await enrichPersonInPlace({
      filepath: "content://tree/p.md",
      expectedMtime: null,
      expectedContent: "---\n---\n# Before\n",
      ocrResult: "x",
      context: "",
      tags: [],
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      "content://tree/p.md",
      expect.any(String),
      null,
      "---\n---\n# Before\n",
    );
  });

  it("re-merges the note's tags onto the model output instead of dropping them", async () => {
    // The regression this guards: the model's markdown replaces the file
    // wholesale, so anything not re-merged here is gone from the vault.
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      tags: ["conference", "2026"],
    });
    if (out.kind !== "updated") throw new Error(`expected updated, got ${out.kind}`);
    expect(out.markdown).toContain("conference");
    expect(out.markdown).toContain("2026");
    expect(mockUpdate.mock.calls[0][1]).toBe(out.markdown);
  });

  it("re-merges location onto the model output", async () => {
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      tags: [],
      location: "47.20114,10.11660",
    });
    if (out.kind !== "updated") throw new Error(`expected updated, got ${out.kind}`);
    expect(out.markdown).toContain("location: 47.20114,10.11660");
  });

  it("re-injects attachment embeds so paired binaries survive the overwrite", async () => {
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      tags: [],
      attachments: [
        { kind: "image", rel: "../Photos/card.jpg", filename: "card.jpg" },
      ],
    });
    if (out.kind !== "updated") throw new Error(`expected updated, got ${out.kind}`);
    expect(out.markdown).toContain("../Photos/card.jpg");
  });

  it("keeps the model's own body and heading", async () => {
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      tags: ["conference"],
    });
    if (out.kind !== "updated") throw new Error(`expected updated, got ${out.kind}`);
    expect(out.markdown).toContain("# Ada Lovelace");
    expect(out.markdown).toContain("Analyst.");
  });

  it("reports a conflict instead of clobbering a note edited mid-flight", async () => {
    mockUpdate.mockResolvedValue({ ok: false, reason: "conflict" });
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 999,
      ocrResult: "x",
      context: "",
      tags: [],
    });
    expect(out).toEqual({ kind: "conflict" });
  });

  it("classifies a network failure as transient and never throws", async () => {
    mockPerson.mockRejectedValue(new Error("network down"));
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      tags: [],
    });
    expect(out).toEqual({ kind: "failed", transient: true, reason: "network down" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("classifies a 4xx failure as permanent", async () => {
    mockPerson.mockRejectedValue(new Error("HTTP 400"));
    mockPermanent.mockReturnValue(true);
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      tags: [],
    });
    expect(out).toEqual({ kind: "failed", transient: false, reason: "HTTP 400" });
  });

  it("classifies an insecure-transport failure as non-transient (Settings, not a queued retry)", async () => {
    mockPerson.mockRejectedValue(new Error("Insecure URL: use https:// for remote hosts"));
    mockInsecure.mockReturnValue(true);
    const out = await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      tags: [],
    });
    expect(out).toEqual({
      kind: "failed",
      transient: false,
      reason: "Insecure URL: use https:// for remote hosts",
    });
    // Never throws, never rewrites the note — the existing capture stands.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("passes a null baseline straight through when there is no snapshot either", async () => {
    await enrichPersonInPlace({
      filepath: "content://p.md",
      expectedMtime: null,
      ocrResult: "x",
      context: "",
      tags: [],
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      "content://p.md",
      expect.any(String),
      null,
      undefined,
    );
  });
});

// ── Generic frontmatter preservation (contact fields survive a re-enrich) ─────

describe("enrichPersonInPlace — frontmatter preservation", () => {
  /** A real saved Person note: the prompt's full field set, plus a field the
   * user added by hand. The re-enrich prompt is fed the BODY only, so the model
   * sees none of this. */
  const SAVED_PERSON = [
    "---",
    "name: Ada Lovelace",
    "company: Analytical Engines Ltd",
    "title: Analyst",
    "email: ada@example.com",
    "phone: +44 20 7946 0000",
    "linkedin: linkedin.com/in/ada",
    "met: 2026-05-01",
    "where: Bletchley",
    "assistant: Charles",
    "tags: [person, networking]",
    "---",
    "# Ada Lovelace",
    "",
    "Analyst.",
  ].join("\n");

  const written = (): string => mockUpdate.mock.calls[0][1];

  it("keeps every contact field the model's output does not itself set", async () => {
    await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "Ada Lovelace, Analyst",
      context: "",
      preserveFrontmatterFrom: SAVED_PERSON,
      tags: [],
    });
    const md = written();
    expect(md).toContain("email: ada@example.com");
    expect(md).toContain("phone: +44 20 7946 0000");
    expect(md).toContain("company: Analytical Engines Ltd");
    expect(md).toContain("linkedin: linkedin.com/in/ada");
    expect(md).toContain("met: 2026-05-01");
    expect(md).toContain("where: Bletchley");
    // Not an allowlist: a field carnet has never heard of survives too.
    expect(md).toContain("assistant: Charles");
  });

  it("lets the model's own value win over the note's", async () => {
    mockPerson.mockResolvedValue({
      markdown: "---\ntitle: Countess of Lovelace\n---\n# Ada Lovelace\n",
      model: "test",
    });
    await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      preserveFrontmatterFrom: SAVED_PERSON,
      tags: [],
    });
    expect(written()).toContain("title: Countess of Lovelace");
    expect(written()).not.toContain("title: Analyst");
  });

  it("treats the prompt's empty placeholder as absent, not as a value", async () => {
    // buildPersonPrompt emits `email: ""` for anything it can't read off the
    // card — a presence-only test would let that blank the user's address.
    mockPerson.mockResolvedValue({
      markdown: '---\nname: Ada Lovelace\nemail: ""\nphone: ""\n---\n# Ada Lovelace\n',
      model: "test",
    });
    await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      preserveFrontmatterFrom: SAVED_PERSON,
      tags: [],
    });
    expect(written()).toContain("email: ada@example.com");
    expect(written()).toContain("phone: +44 20 7946 0000");
  });

  it("is inert when no source note is given", async () => {
    await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "x",
      context: "",
      tags: [],
    });
    expect(written()).not.toContain("email:");
  });
});

// ── tags belong to mergeUserTags, never to frontmatter preservation ──────────

describe("enrichPersonInPlace — tags are left to mergeUserTags", () => {
  /** The note on disk carries the tags from a PREVIOUS enrichment. */
  const SAVED_PERSON =
    "---\nname: Alice\nemail: alice@example.com\ntags: [person, networking]\n---\n# Alice\n";

  it("keeps the model's fresh tags when it emits them in block form", async () => {
    // Regression: block-form tags read as empty, so preservation treated the
    // field as "not provided" and overwrote the model's whole list with the
    // note's older one BEFORE mergeUserTags could merge them — `fintech` and
    // `conference-2026` silently vanished from the vault.
    mockPerson.mockResolvedValue({
      markdown: [
        "---",
        "name: Alice",
        "tags:",
        "  - person",
        "  - fintech",
        "  - conference-2026",
        "---",
        "# Alice",
      ].join("\n"),
      model: "test",
    });
    await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "Alice",
      context: "",
      preserveFrontmatterFrom: SAVED_PERSON,
      tags: ["alice-corp"],
    });
    const md = mockUpdate.mock.calls[0][1];
    expect(md).toContain("tags: [person, fintech, conference-2026, alice-corp]");
    // The contact field is still preserved — only `tags` is hands-off.
    expect(md).toContain("email: alice@example.com");
  });

  it("keeps the model's fresh tags when it emits them in flow form", async () => {
    mockPerson.mockResolvedValue({
      markdown: "---\nname: Alice\ntags: [person, fintech]\n---\n# Alice\n",
      model: "test",
    });
    await enrichPersonInPlace({
      filepath: "p.md",
      expectedMtime: 2000,
      ocrResult: "Alice",
      context: "",
      preserveFrontmatterFrom: SAVED_PERSON,
      tags: ["alice-corp"],
    });
    expect(mockUpdate.mock.calls[0][1]).toContain("tags: [person, fintech, alice-corp]");
  });
});
