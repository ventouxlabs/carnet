/**
 * Fixture-driven bug reproduction harness.
 *
 * Lets an agent reproduce a known bug class from a real-shaped vault note or
 * canned OmniRoute response in one command, without spinning up Expo:
 *
 *   npm -w @carnet/mobile exec vitest run test/fixtures/repro.test.ts
 *
 * Fixtures live in ./vault (real-shaped notes: Idea, Idea w/ unicode title,
 * Journal same-day pair, Person, a v0.11.0 Idea with its photo embed above
 * the frontmatter) and ./omniroute (canned chat-completion
 * JSON: well-formed, malformed frontmatter, oversized). Each `describe`
 * below documents which historical bug class it reproduces and asserts the
 * current (fixed) behavior — a regression turns the matching test red.
 *
 * The expo-file-system/legacy mock mirrors writer.test.ts's in-memory store
 * so this file can run standalone; it is intentionally duplicated rather
 * than shared, so a fixture-only agent invocation never has to resolve a
 * cross-file mock helper.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

function readVaultFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, "vault", name), "utf8");
}

function readOmniRouteFixture(name: string): {
  model?: string;
  choices?: Array<{ message: { content: string } }>;
} {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, "omniroute", name), "utf8"),
  );
}

// ── Mock expo-file-system/legacy (same in-memory store shape as writer.test.ts) ──

interface FileEntry {
  content: string;
  modificationTime?: number;
}

const _files: Map<string, FileEntry> = new Map();

vi.mock("../../src/lib/settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    omniRouteUrl: "",
    omniRouteApiKey: "",
    omniRouteModel: "",
    captureFolderPath: "",
  }),
}));

vi.mock("expo-file-system/legacy", () => {
  return {
    documentDirectory: "file:///data/",
    EncodingType: { UTF8: "utf8", Base64: "base64" },
    getInfoAsync: vi.fn(async (uri: string) => {
      const entry = _files.get(uri);
      if (entry) {
        return {
          exists: true,
          uri,
          isDirectory: false,
          modificationTime: entry.modificationTime,
        };
      }
      const dirPrefix = uri.replace(/\/$/, "") + "/";
      const isDir = [..._files.keys()].some((u) => u.startsWith(dirPrefix));
      return { exists: isDir, uri, isDirectory: isDir };
    }),
    makeDirectoryAsync: vi.fn(async () => {
      // no-op — directories are implicit from tracked file prefixes
    }),
    readDirectoryAsync: vi.fn(async (parentUri: string) => {
      const prefix = parentUri.replace(/\/$/, "") + "/";
      const out: string[] = [];
      for (const uri of _files.keys()) {
        if (uri.startsWith(prefix)) {
          const rest = uri.slice(prefix.length);
          if (!rest.includes("/")) out.push(rest);
        }
      }
      return out;
    }),
    readAsStringAsync: vi.fn(async (uri: string) => {
      const entry = _files.get(uri);
      if (!entry) throw new Error(`File not found: ${uri}`);
      return entry.content;
    }),
    writeAsStringAsync: vi.fn(async (uri: string, content: string) => {
      // Monotonic fake clock: each write bumps modificationTime by 1 so the
      // conflict-guard fixture can distinguish "before" from "after".
      const prevTime = _files.get(uri)?.modificationTime ?? 0;
      _files.set(uri, { content, modificationTime: prevTime + 1 });
    }),
    deleteAsync: vi.fn(async (uri: string) => {
      _files.delete(uri);
    }),
    StorageAccessFramework: {
      readDirectoryAsync: vi.fn(),
      makeDirectoryAsync: vi.fn(),
      createFileAsync: vi.fn(),
      readAsStringAsync: vi.fn(),
      writeAsStringAsync: vi.fn(),
    },
  };
});

import {
  appendJournal,
  extractNameFromMarkdown,
  getModificationTime,
  personFilename,
  readNote,
  slugify,
  updateNoteIfUnchanged,
  writeIdea,
  writeNote,
  writePerson,
} from "../../src/lib/writer";
import { extractFrontmatterField, getFrontmatterTags, splitFrontmatter } from "../../src/lib/frontmatter";
import { repairEmbedsAboveFrontmatter } from "../../src/lib/legacyEmbedRepair";
import { sanitizeAndNormalize } from "../../src/lib/enrichSanitize";
import { extractChecklistLines } from "../../src/lib/checklist";
import { keepsUserLines } from "../../src/lib/noteLineGuard";

beforeEach(() => {
  _files.clear();
});

// ── Bug class 1: unicode slugs ────────────────────────────────────────────────
// TODO.md: "Slugify Unicode edge cases — ASCII-only slugifier drops non-Latin
// characters ... you get 'untitled'." A non-Latin H1 must fold to "" (not
// throw, not silently write a blank-name file) so callers can apply their
// "untitled" fallback before calling writeIdea.

describe("repro: unicode slugs (idea-unicode-title.md)", () => {
  it("slugify() folds a non-Latin H1 to empty string, never a blank/invalid filename", () => {
    const md = readVaultFixture("idea-unicode-title.md");
    const h1 = md.match(/^#\s+(.+)$/m)?.[1] ?? "";
    expect(h1).toBe("日本語のアイデア");
    expect(slugify(h1)).toBe("");
  });

  it("writeIdea falls back to a caller-supplied 'untitled' slug when slugify() is empty", async () => {
    const md = readVaultFixture("idea-unicode-title.md");
    const h1 = md.match(/^#\s+(.+)$/m)?.[1] ?? "";
    const slug = slugify(h1) || "untitled";
    const { filepath } = await writeIdea(slug, md);
    expect(filepath).toBe("file:///data/carnet/Ideas/untitled.md");
    expect(await readNote(filepath)).toBe(md);
  });
});

// ── Bug class 2: filename collision ───────────────────────────────────────────
// TODO.md (closed item): "writer.ts appends -2, -3 etc. on slug collision."
// Writing the same slug twice must NOT overwrite the first file.

describe("repro: filename collision (idea-simple.md written twice)", () => {
  it("bumps the second same-slug idea to -2 instead of overwriting the first", async () => {
    const md = readVaultFixture("idea-simple.md");
    const first = await writeIdea("fixtures-repro", md);
    const second = await writeIdea("fixtures-repro", md);

    expect(first.filepath).toBe("file:///data/carnet/Ideas/fixtures-repro.md");
    expect(second.filepath).toBe(
      "file:///data/carnet/Ideas/fixtures-repro-2.md",
    );
    // Both copies survive — the first was not clobbered.
    expect(await readNote(first.filepath)).toBe(md);
    expect(await readNote(second.filepath)).toBe(md);
  });

  it("also bumps person notes for a repeat capture of the same contact", async () => {
    const md = readVaultFixture("person-card.md");
    const { firstName, lastName } = extractNameFromMarkdown(md);
    expect(personFilename(`${firstName} ${lastName}`)).toBe(
      "Priya-Natarajan",
    );
    const first = await writePerson(firstName, lastName, md);
    const second = await writePerson(firstName, lastName, md);
    expect(first.filepath).toBe(
      "file:///data/carnet/People/Priya-Natarajan.md",
    );
    expect(second.filepath).toBe(
      "file:///data/carnet/People/Priya-Natarajan-2.md",
    );
  });
});

// ── Bug class 3: same-day journal append ──────────────────────────────────────
// TODO.md (closed item): each appended same-day entry must be distinguishable
// (a heading per capture) and tags/location from the second capture must NOT
// clobber or duplicate the first entry's frontmatter tags.

describe("repro: same-day journal append (journal-entry-1.md + journal-entry-2.md)", () => {
  it("merges two same-day captures into one day file with unioned tags and both bodies", async () => {
    const entry1 = readVaultFixture("journal-entry-1.md");
    const entry2 = readVaultFixture("journal-entry-2.md");

    const first = await appendJournal("2026-07-03", entry1);
    expect(first.filepath).toBe("file:///data/carnet/Journal/2026-07-03.md");

    const second = await appendJournal("2026-07-03", entry2);
    // Same file — appended in place, not a second -2 file.
    expect(second.filepath).toBe(first.filepath);

    const finalMarkdown = second.markdown;
    expect(getFrontmatterTags(finalMarkdown)).toEqual([
      "standup",
      "walk",
      "thinking",
    ]);
    // Latest same-day capture's location wins (scalar field, documented in writer.ts).
    expect(finalMarkdown).toContain("location: Riverside path");
    // Both entry bodies survive, each under its own heading.
    expect(finalMarkdown).toContain("Kicked off the day with a quick standup.");
    expect(finalMarkdown).toContain("Afternoon walk.");
    expect(finalMarkdown).toMatch(/## \d{2}:\d{2}/);

    expect(await readNote(first.filepath)).toBe(finalMarkdown);
  });
});

// ── Bug class 4: mtime conflict guard ─────────────────────────────────────────
// TODO.md (closed item, B4): a save-first overwrite must be skipped — not
// silently clobbered — when the on-disk file changed since the caller last
// read its mtime (e.g. a Syncthing/workstation edit landed in between).

describe("repro: mtime conflict guard (idea-simple.md, simulated concurrent edit)", () => {
  it("skips the overwrite and reports a conflict when the file changed underneath", async () => {
    const md = readVaultFixture("idea-simple.md");
    const { filepath } = await writeIdea("conflict-guard-demo", md);
    const staleMtime = await getModificationTime(filepath);
    expect(staleMtime).not.toBeNull();

    // Simulate a concurrent external edit (e.g. Syncthing delivering a
    // workstation change) landing between the caller's read and its write.
    _files.set(filepath, {
      content: "concurrently edited content",
      modificationTime: (staleMtime ?? 0) + 5,
    });

    const result = await updateNoteIfUnchanged(
      filepath,
      "the caller's overwrite, which must NOT land",
      staleMtime,
    );
    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(await readNote(filepath)).toBe("concurrently edited content");
  });

  it("proceeds when the mtime is unchanged", async () => {
    const md = readVaultFixture("idea-simple.md");
    const { filepath } = await writeIdea("conflict-guard-demo-2", md);
    const mtime = await getModificationTime(filepath);

    const result = await updateNoteIfUnchanged(filepath, "updated content", mtime);
    expect(result).toEqual({ ok: true });
    expect(await readNote(filepath)).toBe("updated content");
  });
});

// ── OmniRoute response fixtures: well-formed / malformed / oversized ────────────
// Reproduces the enrichment-response validation gate (enrichSanitize.ts) that
// executeChat() runs on every OmniRoute reply before it can reach the vault.

describe("repro: OmniRoute canned responses", () => {
  it("well-formed response normalizes cleanly (non-null, canonical key order)", () => {
    const { choices } = readOmniRouteFixture("idea-wellformed.json");
    const content = choices?.[0]?.message.content ?? "";
    const normalized = sanitizeAndNormalize(content, "idea");
    expect(normalized).not.toBeNull();
    expect(normalized).toMatch(/^---\ncreated:.*\nstatus:.*\ntags:.*\n---/s);
  });

  it("malformed frontmatter (missing required 'status') fails normalization", () => {
    const { choices } = readOmniRouteFixture("idea-malformed-frontmatter.json");
    const content = choices?.[0]?.message.content ?? "";
    const normalized = sanitizeAndNormalize(content, "idea");
    expect(normalized).toBeNull();
  });

  it("oversized response body still normalizes without throwing or truncating", () => {
    const { choices } = readOmniRouteFixture("idea-oversized.json");
    const content = choices?.[0]?.message.content ?? "";
    expect(content.length).toBeGreaterThan(20_000);
    const normalized = sanitizeAndNormalize(content, "idea");
    expect(normalized).not.toBeNull();
    // Body length survives byte-for-byte past the frontmatter re-serialization.
    expect(normalized?.length).toBeGreaterThanOrEqual(content.length);
  });
});

// ── Note capture: a task list survives with every line intact ────────────────
// note-capture-mode PRD acceptance criteria 2-4. Pins sanitize/normalize
// (noteType "note") → writeNote → the todo scan against a canned reply. It
// does NOT prove a real model obeys "do not expand" — that half is on-device.

describe("repro: note capture keeps every line (note-tasklist.json)", () => {
  it("normalizes as a note, lands in Notes/, keeps every input line, and exposes the actions as todos", async () => {
    const fixture = readOmniRouteFixture("note-tasklist.json") as ReturnType<
      typeof readOmniRouteFixture
    > & { input: string };
    const content = fixture.choices?.[0]?.message.content ?? "";

    const normalized = sanitizeAndNormalize(content, "note");
    expect(normalized).not.toBeNull();
    expect(normalized).toMatch(/^---\ncreated: 2026-09-27\ntags: \[note, errands, weekend\]\n---\n/);

    const { filepath } = await writeNote("weekend-errands", normalized ?? "");
    expect(filepath).toBe("file:///data/carnet/Notes/weekend-errands.md");
    const written = await readNote(filepath);

    // Line by line, in order, one-for-one — the same check dispatcher.enrichNote
    // enforces. A whole-document toContain would also pass a reply that kept
    // every line and then added prose, or reordered them.
    expect(keepsUserLines(fixture.input, written)).toBe(true);
    // A context line is never turned into a task.
    expect(written).not.toContain("- [ ] the car is in the east lot");
    expect(extractChecklistLines(written).map((t) => t.text)).toEqual([
      "call the dentist",
      "buy stamps",
      "renew passport",
    ]);
  });
});

// v0.11.0's injectImageEmbed put a photo embed ABOVE the frontmatter of a raw
// Idea with no H1, and the tag/location merges then prepended a second block.
// The note's status was unreadable, so "Finish enrichment" was never offered.
// finishEnrichment.ts reads every note through this repair.

describe("repro: v0.11.0 embed above the frontmatter (idea-v0110-embed-above-frontmatter.md)", () => {
  it("reads back as one pending note with its tags, location, photo and text", () => {
    const onDisk = readVaultFixture("idea-v0110-embed-above-frontmatter.md");
    // The bug: the first block is the merges' leftovers, so no status.
    expect(extractFrontmatterField(onDisk, "status")).toBeNull();

    const repaired = repairEmbedsAboveFrontmatter(onDisk);
    expect(extractFrontmatterField(repaired, "status")).toBe("pending-enrich");
    expect(extractFrontmatterField(repaired, "rev")).toBe("9f2c1a7e");
    expect(extractFrontmatterField(repaired, "location")).toBe("48.85660,2.35220");
    expect(getFrontmatterTags(repaired)).toEqual(["garden", "weekend"]);
    expect(splitFrontmatter(repaired).body).toBe(
      "![](../Photos/receipt-0920.jpg)\n\nthe ferns need water\n- [ ] buy compost\n",
    );
  });
});
