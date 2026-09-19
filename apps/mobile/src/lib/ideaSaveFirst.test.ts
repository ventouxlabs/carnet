import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory expo-file-system mock WITH modificationTime tracking ───────────
// Mirrors writer.test.ts's store, but each write bumps a monotonic clock so the
// mtime conflict guard (getModificationTime / updateNoteIfUnchanged) is testable
// and external edits can be simulated by bumping a file's mtime directly.

interface FileEntry {
  content: string;
  mtime: number;
}

const _files: Map<string, FileEntry> = new Map();
let _clock = 1000;

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    llmProviders: [
      {
        id: "omniroute",
        label: "OmniRoute",
        baseUrl: "",
        model: "",
        visionModel: "",
        preset: "omniroute",
      },
      {
        id: "relais",
        label: "Relais (local)",
        baseUrl: "http://127.0.0.1:8080",
        model: "",
        visionModel: "",
        preset: "relais",
      },
    ],
    activeProviderId: "omniroute",
    omniRouteApiKey: "",
    localLlmApiKey: "",
    captureFolderPath: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    useExistingTagsForAutoTag: true,
    richEditorEnabled: false,
    previewBeforeSave: false,
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "",
  }),
  getPromptOverrides: vi.fn().mockResolvedValue({}),
  DEFAULT_OMNIROUTE_MODEL: "openrouter/openai/gpt-4o-mini",
}));

// dispatcher.ts (imported transitively via ideaSaveFirst.ts) now resolves the
// active provider's API key via providerKeys.ts, which does real SecureStore
// IO — mock it so this suite doesn't need the native expo-secure-store
// binding (which can't load under Node + vitest).
vi.mock("./providerKeys", () => ({
  getKey: vi.fn().mockResolvedValue(""),
  setKey: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("./vaultTagHint", () => ({
  getVaultTagStrings: vi.fn(async () => []),
}));

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/",
  EncodingType: { UTF8: "utf8", Base64: "base64" },
  getInfoAsync: vi.fn(async (uri: string) => {
    const entry = _files.get(uri);
    if (entry) {
      return {
        exists: true,
        uri,
        isDirectory: false,
        size: entry.content.length,
        modificationTime: entry.mtime,
      };
    }
    // Model directories: a path is a directory iff some tracked file lives under it.
    const dirPrefix = uri.replace(/\/$/, "") + "/";
    const isDir = [..._files.keys()].some((u) => u.startsWith(dirPrefix));
    return { exists: isDir, uri, isDirectory: isDir, size: 0, modificationTime: 0 };
  }),
  makeDirectoryAsync: vi.fn(async () => {}),
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
    _files.set(uri, { content, mtime: ++_clock });
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
}));

// ── Mock llmClient (dispatcher imports enrichIdea + error classifiers from it) ─

const enrichIdeaMock = vi.fn();
const isPermanentErrorMock = vi.fn().mockReturnValue(false);
const isNotConfiguredErrorMock = vi.fn().mockReturnValue(false);
const isInsecureTransportErrorMock = vi.fn().mockReturnValue(false);

vi.mock("./llmClient", () => ({
  enrichIdea: (...args: unknown[]) => enrichIdeaMock(...args),
  isPermanentError: (...args: unknown[]) => isPermanentErrorMock(...args),
  isNotConfiguredError: (...args: unknown[]) => isNotConfiguredErrorMock(...args),
  isInsecureTransportError: (...args: unknown[]) => isInsecureTransportErrorMock(...args),
  enrichJournal: vi.fn(),
  enrichPerson: vi.fn(),
  enrichSharedImage: vi.fn(),
  enrichSharedLink: vi.fn(),
  promoteIdea: vi.fn(),
  ocrCardViaVision: vi.fn(),
  listModels: vi.fn(),
  healthCheck: vi.fn(),
  DEFAULT_LOCAL_LLM_URL: "http://127.0.0.1:8080",
  LlmClientError: class LlmClientError extends Error {},
}));

import {
  applyEnrichedIdea,
  buildRawIdeaMarkdown,
  deriveRawIdeaSlug,
  enrichIdeaInPlace,
  PENDING_ENRICH_STATUS,
  rewriteRawIdea,
  usesSaveFirst,
  writeRawIdea,
} from "./ideaSaveFirst";
import { getModificationTime, updateNoteIfUnchanged, readNote } from "./writer";
import { extractFrontmatterField } from "./frontmatter";
import { getVaultTagStrings } from "./vaultTagHint";

function clearFiles(): void {
  _files.clear();
  _clock = 1000;
}

beforeEach(() => {
  clearFiles();
  enrichIdeaMock.mockReset();
  vi.mocked(getVaultTagStrings).mockReset().mockResolvedValue([]);
  isPermanentErrorMock.mockReturnValue(false);
  isNotConfiguredErrorMock.mockReturnValue(false);
  isInsecureTransportErrorMock.mockReturnValue(false);
});

// ── usesSaveFirst (drives the CaptureScreen branch) ──────────────────────────

describe("usesSaveFirst", () => {
  it("is save-first by default (previewBeforeSave off)", () => {
    expect(usesSaveFirst(false)).toBe(true);
  });

  it("restores the blocking preview flow when previewBeforeSave is on", () => {
    // Required test 4: previewBeforeSave=on reproduces the old blocking flow
    // (the raw note is NOT written up front — the caller enriches then previews).
    expect(usesSaveFirst(true)).toBe(false);
  });
});

// ── deriveRawIdeaSlug ─────────────────────────────────────────────────────────

describe("deriveRawIdeaSlug", () => {
  it("slugs from the raw text's first non-empty line (not an LLM title)", () => {
    expect(deriveRawIdeaSlug("Build a kite\n\nmore detail")).toBe("build-a-kite");
  });

  it("falls back to 'idea' for text that slugifies to nothing", () => {
    expect(deriveRawIdeaSlug("🚀")).toBe("idea");
  });
});

// ── buildRawIdeaMarkdown ──────────────────────────────────────────────────────

describe("buildRawIdeaMarkdown", () => {
  const NOW = new Date("2026-07-04T12:00:00.000Z");

  it("writes deterministic client-side frontmatter + the raw text as body", () => {
    const md = buildRawIdeaMarkdown({ text: "My raw idea", tags: [] }, NOW);
    expect(md).toContain(`status: ${PENDING_ENRICH_STATUS}`);
    expect(md).toContain("created: 2026-07-04T12:00:00.000Z");
    expect(md).toContain("My raw idea");
  });

  it("injects user tags and location deterministically", () => {
    const md = buildRawIdeaMarkdown(
      { text: "idea", tags: ["work", "urgent"], location: "38.90000,-77.00000" },
      NOW,
    );
    expect(md).toContain("tags: [work, urgent]");
    expect(md).toContain("location: 38.90000,-77.00000");
  });
});

// ── writeRawIdea — the save-first write lands immediately ─────────────────────

describe("writeRawIdea (save-first write)", () => {
  it("writes the raw note to disk before any enrichment (required test 1)", async () => {
    const { filepath, slug, mtime } = await writeRawIdea({
      text: "Ship the save-first path",
      tags: ["b4"],
    });
    // File is on disk immediately — no enrichment has run.
    expect(_files.has(filepath)).toBe(true);
    expect(slug).toBe("ship-the-save-first-path");
    expect(mtime).not.toBeNull();
    const content = _files.get(filepath)!.content;
    expect(content).toContain(`status: ${PENDING_ENRICH_STATUS}`);
    expect(content).toContain("Ship the save-first path");
    expect(content).toContain("tags: [b4]");
  });
});

// ── applyEnrichedIdea — in-place update, no rename, guarded ───────────────────

describe("applyEnrichedIdea (in-place enriched update)", () => {
  it("updates the SAME file, keeps the filename, preserves user tags + location (required test 2)", async () => {
    const { filepath, mtime } = await writeRawIdea({
      text: "Kite idea",
      tags: ["hobby"],
      location: "40.00000,-74.00000",
    });

    const enriched =
      "---\ncreated: 2026-07-04\nstatus: seedling\ntags: [kites]\n---\n# Building a Box Kite\n\nStructured body.\n";
    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: mtime,
      enrichedMarkdown: enriched,
      tags: ["hobby"],
      location: "40.00000,-74.00000",
    });

    expect(status).toBe("updated");
    // Same file — no rename to the polished title.
    expect(filepath).toMatch(/Ideas\/kite-idea\.md$/);
    const content = _files.get(filepath)!.content;
    // Enriched body replaced the raw body.
    expect(content).toContain("# Building a Box Kite");
    expect(content).not.toContain(`status: ${PENDING_ENRICH_STATUS}`);
    // User tags merged with the LLM's, user location preserved.
    expect(content).toContain("hobby");
    expect(content).toContain("kites");
    expect(content).toContain("location: 40.00000,-74.00000");
  });

  it("keeps the user's version and reports conflict when mtime changed (required test 3)", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "Race me", tags: [] });

    // Simulate an external touch (a synced workstation edit) between the raw
    // write and the enriched overwrite: content + mtime both change.
    _files.set(filepath, { content: "# Workstation edit\n", mtime: mtime! + 5 });

    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: mtime,
      enrichedMarkdown: "# Enriched clobber\n",
      tags: [],
    });

    expect(status).toBe("conflict");
    // The enriched write was skipped — the user's version survived, no clobber.
    expect(_files.get(filepath)!.content).toBe("# Workstation edit\n");
  });
});

// ── updateNoteIfUnchanged — the raw mtime guard primitive ────────────────────

describe("updateNoteIfUnchanged (mtime guard)", () => {
  it("writes when the mtime still matches the baseline", async () => {
    const { filepath } = await writeRawIdea({ text: "guard me", tags: [] });
    const baseline = await getModificationTime(filepath);
    const res = await updateNoteIfUnchanged(filepath, "# Updated\n", baseline);
    expect(res.ok).toBe(true);
    expect(await readNote(filepath)).toBe("# Updated\n");
  });

  it("skips the write and reports conflict when the file changed under it", async () => {
    const { filepath } = await writeRawIdea({ text: "guard me", tags: [] });
    const baseline = await getModificationTime(filepath);
    // External edit bumps mtime.
    _files.set(filepath, { content: "# Theirs\n", mtime: (baseline ?? 0) + 9 });
    const res = await updateNoteIfUnchanged(filepath, "# Mine\n", baseline);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("conflict");
    expect(await readNote(filepath)).toBe("# Theirs\n");
  });

  it("proceeds when the baseline is null and no content snapshot was given", async () => {
    const { filepath } = await writeRawIdea({ text: "no baseline", tags: [] });
    const res = await updateNoteIfUnchanged(filepath, "# Forced\n", null);
    expect(res.ok).toBe(true);
    expect(await readNote(filepath)).toBe("# Forced\n");
  });

  it("falls back to comparing content when there is no mtime baseline", async () => {
    const { filepath, markdown } = await writeRawIdea({ text: "saf note", tags: [] });
    const res = await updateNoteIfUnchanged(filepath, "# Enriched\n", null, markdown);
    expect(res.ok).toBe(true);
    expect(await readNote(filepath)).toBe("# Enriched\n");
  });

  it("reports conflict on a content mismatch with no mtime baseline", async () => {
    const { filepath, markdown } = await writeRawIdea({ text: "saf note", tags: [] });
    // A workstation edit lands during the enrich window. On SAF there is no
    // mtime to notice it — only these bytes.
    _files.set(filepath, { content: "# Workstation edit\n", mtime: 1 });
    const res = await updateNoteIfUnchanged(filepath, "# Enriched\n", null, markdown);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("conflict");
    expect(await readNote(filepath)).toBe("# Workstation edit\n");
  });
});

// ── applyEnrichedIdea over a mtime-less (SAF) vault ──────────────────────────

describe("applyEnrichedIdea (content guard, no mtime)", () => {
  it("keeps the user's version when the note changed during enrichment", async () => {
    // The save-first invariant on the vault people actually run: SAF reports no
    // mtime, so before the content baseline existed this overwrote the edit.
    const { filepath, markdown } = await writeRawIdea({ text: "Race me", tags: [] });
    _files.set(filepath, { content: "# Workstation edit\n", mtime: 1 });

    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: null,
      expectedContent: markdown,
      enrichedMarkdown: "# Enriched clobber\n",
      tags: [],
    });

    expect(status).toBe("conflict");
    expect(_files.get(filepath)!.content).toBe("# Workstation edit\n");
  });

  it("still applies the enrichment when the note is untouched", async () => {
    const { filepath, markdown } = await writeRawIdea({ text: "Race me", tags: [] });

    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: null,
      expectedContent: markdown,
      enrichedMarkdown: "# Enriched\n\nStructured.\n",
      tags: [],
    });

    expect(status).toBe("updated");
    expect(_files.get(filepath)!.content).toContain("# Enriched");
  });
});

// ── enrichIdeaInPlace — full async enrichment, ordering + failure classes ─────

describe("enrichIdeaInPlace", () => {
  it("only runs enrichment after the raw note is already on disk", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "ordering", tags: [] });
    let fileExistedAtEnrichTime = false;
    enrichIdeaMock.mockImplementation(async () => {
      fileExistedAtEnrichTime = _files.has(filepath);
      return { markdown: "# Enriched\n\nbody\n", model: "test" };
    });

    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "ordering",
      tags: [],
    });

    expect(fileExistedAtEnrichTime).toBe(true);
    expect(outcome.kind).toBe("updated");
    expect(_files.get(filepath)!.content).toContain("# Enriched");
  });

  it("uses the raw note's captured profile tags after the active profile changes", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "personal capture", tags: [] });
    vi.mocked(getVaultTagStrings).mockImplementation(async (profileIdOrLimit?: string | number) =>
      typeof profileIdOrLimit === "string" && profileIdOrLimit === "personal"
        ? ["personal-only"]
        : ["work-secret"],
    );
    enrichIdeaMock.mockResolvedValue({ markdown: "# Enriched\n", model: "test" });

    await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "personal capture",
      tags: [],
      vaultContext: { profileId: "personal", rootUri: "file:///personal" },
    });

    expect(getVaultTagStrings).toHaveBeenCalledWith("personal");
    expect(enrichIdeaMock.mock.calls[0]?.[0]).toBe("personal capture");
    expect(enrichIdeaMock.mock.calls[0]?.[3]).toEqual(["personal-only"]);
  });

  it("classifies a network failure as transient (caller should queue)", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "offline", tags: [] });
    enrichIdeaMock.mockRejectedValue(new Error("network down"));
    // Neither permanent nor not-configured → transient.
    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "offline",
      tags: [],
    });
    expect(outcome).toEqual({ kind: "failed", transient: true, reason: "network down" });
    // Raw note untouched — still pending-enrich, nothing lost.
    expect(_files.get(filepath)!.content).toContain(`status: ${PENDING_ENRICH_STATUS}`);
  });

  it("classifies a permanent (4xx) failure as non-transient", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "badreq", tags: [] });
    enrichIdeaMock.mockRejectedValue(new Error("HTTP 400"));
    isPermanentErrorMock.mockReturnValue(true);
    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "badreq",
      tags: [],
    });
    expect(outcome).toEqual({ kind: "failed", transient: false, reason: "HTTP 400" });
  });

  it("classifies an insecure-transport failure as non-transient (Settings, not a queued retry)", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "insecure", tags: [] });
    enrichIdeaMock.mockRejectedValue(new Error("Insecure URL: use https:// for remote hosts"));
    // Neither permanent (no HTTP status) nor not-configured — only the new
    // predicate separates it from a plain network blip.
    isInsecureTransportErrorMock.mockReturnValue(true);
    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "insecure",
      tags: [],
    });
    expect(outcome).toEqual({
      kind: "failed",
      transient: false,
      reason: "Insecure URL: use https:// for remote hosts",
    });
    // Save-first contract: the raw note is still on disk, still pending-enrich.
    expect(_files.get(filepath)!.content).toContain(`status: ${PENDING_ENRICH_STATUS}`);
  });

  it("reports conflict (keeps user version) when the note changed during enrichment", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "conflict", tags: [] });
    enrichIdeaMock.mockImplementation(async () => {
      // The workstation edit syncs in while enrichment is in flight.
      _files.set(filepath, { content: "# Theirs\n", mtime: mtime! + 3 });
      return { markdown: "# Mine\n", model: "test" };
    });
    const outcome = await enrichIdeaInPlace({
      filepath,
      expectedMtime: mtime,
      text: "conflict",
      tags: [],
    });
    expect(outcome.kind).toBe("conflict");
    expect(_files.get(filepath)!.content).toBe("# Theirs\n");
  });
});

// ── rewriteRawIdea (edit-then-resubmit during the enrich window) ──────────────

describe("rewriteRawIdea", () => {
  it("overwrites the SAME file rather than creating a collision-suffixed twin", async () => {
    const first = await writeRawIdea({ text: "Build a kite", tags: [] });
    const before = [..._files.keys()].filter((u) => u.endsWith(".md"));
    expect(before).toHaveLength(1);

    const out = await rewriteRawIdea({
      filepath: first.filepath,
      text: "Build a kite that actually flies",
      tags: [],
    });

    expect(out.filepath).toBe(first.filepath);
    const after = [..._files.keys()].filter((u) => u.endsWith(".md"));
    expect(after).toEqual(before);
    expect(_files.get(first.filepath)!.content).toContain("Build a kite that actually flies");
  });

  it("returns a bumped mtime so the follow-up enrich guard uses a fresh baseline", async () => {
    const first = await writeRawIdea({ text: "baseline", tags: [] });
    const out = await rewriteRawIdea({ filepath: first.filepath, text: "edited", tags: [] });
    expect(out.mtime).not.toBeNull();
    expect(out.mtime!).toBeGreaterThan(first.mtime!);
    expect(await getModificationTime(first.filepath)).toBe(out.mtime);
  });

  it("keeps the pending-enrich stamp and re-merges tags/location on the edit", async () => {
    const first = await writeRawIdea({ text: "trip notes", tags: ["travel"] });
    const out = await rewriteRawIdea({
      filepath: first.filepath,
      text: "trip notes, revised",
      tags: ["travel", "alps"],
      location: "47.20114,10.11660",
    });
    expect(out.markdown).toContain(`status: ${PENDING_ENRICH_STATUS}`);
    expect(out.markdown).toContain("alps");
    expect(out.markdown).toContain("location: 47.20114,10.11660");
    expect(await readNote(first.filepath)).toBe(out.markdown);
  });

  it("ignores the slug the edited text would have produced", async () => {
    // A slug-derived rewrite would land in a totally different filename here.
    const first = await writeRawIdea({ text: "Alpha", tags: [] });
    await rewriteRawIdea({ filepath: first.filepath, text: "Omega", tags: [] });
    expect([..._files.keys()].filter((u) => u.endsWith(".md"))).toEqual([first.filepath]);
    expect(first.filepath).toContain("alpha");
  });
});

// ── rev — the raw note's revision token ──────────────────────────────────────

describe("rev (raw revision token)", () => {
  const NOW = new Date("2026-07-04T12:00:00.000Z");

  it("changes on every build, even for byte-identical input", () => {
    const input = { text: "Build a kite", tags: [] };
    const a = buildRawIdeaMarkdown(input, NOW);
    const b = buildRawIdeaMarkdown(input, NOW);
    expect(extractFrontmatterField(a, "rev")).not.toBeNull();
    expect(extractFrontmatterField(a, "rev")).not.toBe(extractFrontmatterField(b, "rev"));
    expect(a).not.toBe(b);
  });

  it("is the ONLY thing that differs when the draft is unchanged", () => {
    const input = { text: "Build a kite", tags: ["hobby"] };
    const a = buildRawIdeaMarkdown(input, NOW, "rev-a");
    const b = buildRawIdeaMarkdown(input, NOW, "rev-b");
    expect(a.replace("rev-a", "X")).toBe(b.replace("rev-b", "X"));
  });

  it("Edit on an UNEDITED draft still invalidates the in-flight enrichment on a SAF vault", async () => {
    // SAF vaults report no mtime, so updateNoteIfUnchanged falls back to
    // comparing raw bytes — and before `rev`, re-writing the same unedited
    // draft produced byte-identical content, so the enrichment the user walked
    // away from saw no conflict and landed anyway.
    const { filepath, markdown } = await writeRawIdea({ text: "Build a kite", tags: [] }, NOW);

    // Edit tapped with nothing typed yet: same text, same pinned `created`.
    await rewriteRawIdea({ filepath, text: "Build a kite", tags: [] }, NOW);

    // The abandoned enrichment finishes and tries to write with its pre-Edit
    // baseline. `expectedMtime: null` is what SAF always reports.
    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: null,
      expectedContent: markdown,
      enrichedMarkdown: "---\nstatus: seedling\n---\n# Polished Kite\n\nEnriched.\n",
      tags: [],
    });

    expect(status).toBe("conflict");
    const onDisk = await readNote(filepath);
    expect(onDisk).not.toContain("# Polished Kite");
    expect(onDisk).toContain(`status: ${PENDING_ENRICH_STATUS}`);
  });

  it("does not survive a successful enrichment", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "Kite idea", tags: [] });
    expect(_files.get(filepath)!.content).toContain("rev: ");

    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: mtime,
      enrichedMarkdown: "---\ncreated: 2026-07-04\nstatus: seedling\n---\n# Kite\n",
      tags: [],
    });

    expect(status).toBe("updated");
    // The model's frontmatter replaces the raw block wholesale — no cleanup
    // step is needed for `rev`, exactly as with `status: pending-enrich`.
    const content = _files.get(filepath)!.content;
    expect(content).not.toContain("rev: ");
    expect(content).not.toContain(PENDING_ENRICH_STATUS);
  });

  it("is never carried onto an enriched note by frontmatter preservation", async () => {
    // The re-enrich path preserves the source note's own fields; `rev` and
    // `status` are the two that must NOT come along.
    const { filepath, mtime, markdown } = await writeRawIdea({ text: "Kite idea", tags: [] });
    const { status } = await applyEnrichedIdea({
      filepath,
      expectedMtime: mtime,
      preserveFrontmatterFrom: markdown,
      enrichedMarkdown: "---\ncreated: 2026-07-04\nstatus: seedling\n---\n# Kite\n",
      tags: [],
    });
    expect(status).toBe("updated");
    const content = _files.get(filepath)!.content;
    expect(content).not.toContain("rev: ");
    expect(content).not.toContain(PENDING_ENRICH_STATUS);
  });
});

// ── Generic frontmatter preservation on the Idea re-enrich path ───────────────

describe("applyEnrichedIdea — frontmatter preservation", () => {
  it("keeps a hand-added field the model's output knows nothing about", async () => {
    const { filepath, mtime } = await writeRawIdea({ text: "Kite idea", tags: [] });
    const savedNote =
      "---\ncreated: 2026-07-04\nstatus: seedling\nproject: kites\ntags: [idea]\n---\n# Kite\n";

    await applyEnrichedIdea({
      filepath,
      expectedMtime: mtime,
      preserveFrontmatterFrom: savedNote,
      enrichedMarkdown: "---\ncreated: 2026-07-05\nstatus: seedling\ntags: [idea]\n---\n# Kite v2\n",
      tags: [],
    });

    const content = _files.get(filepath)!.content;
    expect(content).toContain("project: kites");
    expect(content).toContain("# Kite v2");
    // The model's own values still win.
    expect(content).toContain("created: 2026-07-05");
  });
});
