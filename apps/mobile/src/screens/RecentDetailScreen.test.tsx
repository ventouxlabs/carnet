// @vitest-environment jsdom
//
// Screen smoke test for the content-first note detail (pattern: see
// TagBrowserScreen.test.tsx). The writer mock delegates its frontmatter
// helpers to the REAL pure ../lib/frontmatter module (writer only
// re-exports them), so the stamp row and body rendering exercise real
// parsing; file I/O and the WYSIWYG/audio/karakeep stacks are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { CaptureEntry } from "../lib/storage";

const NOTE_MD =
  "---\ncreated: 2026-07-08T11:55:46.000Z\nstatus: pending-enrich\ntags: [qa-test]\n---\n# Draft Survival Test\n\nHello body text.\n";

vi.mock("../lib/writer", async () => {
  const fm = await import("../lib/frontmatter");
  return {
    // Real pure helpers (writer re-exports these from ./frontmatter).
    extractFrontmatterField: fm.extractFrontmatterField,
    stripFrontmatter: fm.stripFrontmatter,
    splitFrontmatter: fm.splitFrontmatter,
    // Writer-defined pure helpers, faked minimally: no paired binaries in
    // the fixture note.
    listPairedBinaries: vi.fn(() => []),
    stripPairedBinaryLinks: vi.fn((md: string) => md),
    resolvePairedUri: vi.fn(async () => null),
    readPairedBinaryFromNote: vi.fn(async () => {
      throw new Error("no binary");
    }),
    readPairedBinaryUri: vi.fn(async () => {
      throw new Error("no binary");
    }),
    // I/O surface.
    readNote: vi.fn(async () => NOTE_MD),
    updateNote: vi.fn(async () => {}),
    updateNoteIfUnchanged: vi.fn(async () => ({ ok: true })),
    getModificationTime: vi.fn(async () => 1),
    moveToArchive: vi.fn(async () => {}),
    writeBinary: vi.fn(),
    slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
    extFromMime: vi.fn(() => "jpg"),
    upsertSection: vi.fn((md: string) => md),
    injectImageEmbed: vi.fn((md: string) => md),
  };
});

// relatedNotes is pure — imported real; the index feed below controls it.
vi.mock("../lib/vault", async () => {
  const fm = await import("../lib/frontmatter");
  const NOTE_SUBDIRS = ["Ideas", "Journal", "Notes", "People"];
  return {
    getTagIndex: vi.fn(async () => ({ builtAt: 1, tags: [] })),
    invalidateNoteIndex: vi.fn(async () => {}),
    tagsForNote: (md: string) => fm.getFrontmatterTags(md),
    // Restates vault.ts's real subdirForUri (parent-segment match, SAF-decoded)
    // rather than importing it — vault.ts pulls AsyncStorage at import time.
    subdirForUri: (uri: string) => {
      let decoded = uri;
      try {
        decoded = decodeURIComponent(uri);
      } catch {
        /* keep raw */
      }
      const segments = decoded.split("/").filter(Boolean);
      const parent = segments[segments.length - 2];
      return NOTE_SUBDIRS.includes(parent ?? "") ? parent : null;
    },
    // null index → the Related card stays hidden in existing tests.
    loadCachedNoteIndex: vi.fn(async () => null),
    resolveNoteEntry: vi.fn(async () => null),
    upsertNoteInIndex: vi.fn(async () => {}),
  };
});

vi.mock("../lib/storage", () => ({
  removeFromHistory: vi.fn(async () => {}),
  removeFromHistoryByFilepath: vi.fn(async () => {}),
  updateCaptureTitle: vi.fn(async () => {}),
  updateCaptureTitleByFilepath: vi.fn(async () => {}),
}));

vi.mock("../lib/settings", () => ({
  getSettings: vi.fn(async () => ({
    richEditorEnabled: true,
    karakeepUrl: "",
  })),
}));

vi.mock("../lib/karakeep", () => ({
  attachTags: vi.fn(),
  createTextBookmark: vi.fn(),
  updateTextBookmark: vi.fn(),
  KarakeepError: class KarakeepError extends Error {},
}));
vi.mock("../lib/karakeepExport", () => ({ pushNoteAttachments: vi.fn() }));
vi.mock("../lib/karakeepInlineImages", () => ({
  rewriteImageEmbedsToAssetUrls: vi.fn((md: string) => md),
}));
vi.mock("../lib/karakeepAssetSync", () => ({ clearPushedAssets: vi.fn() }));
// pendingSync pulls AsyncStorage's native binding — never load the real one.
vi.mock("../lib/pendingSync", () => ({ enqueuePendingExport: vi.fn() }));

vi.mock("../lib/dispatcher", () => ({
  enrichSharedImage: vi.fn(),
  transcribeAudio: vi.fn(),
  // Real constant (not a mock target) — RecentDetailScreen imports it to
  // read the Phase 3 fallback marker back out of a note's frontmatter.
  FALLBACK_PROVIDER_FIELD: "fallback",
}));
vi.mock("../lib/attachments", () => ({ pickAttachment: vi.fn() }));
vi.mock("../lib/attachPhotoToNote", () => ({ attachPhotoToNote: vi.fn() }));
// expo-camera is a native module; the modal's own behavior is covered in
// PhotoAttachModal.test.tsx. Here it is a dispatch stub for the wiring.
vi.mock("../components/PhotoAttachModal", async () => {
  const { Button } = await import("react-native-paper");
  return {
    PhotoAttachModal: ({
      visible,
      onCaptured,
    }: {
      visible: boolean;
      onCaptured: (b: string, m: string, n?: string) => void;
    }) =>
      visible ? (
        <Button onPress={() => onCaptured("AAAA", "image/jpeg", undefined)}>
          fake-shutter
        </Button>
      ) : null,
  };
});

// Fully mocked, not importActual: the real module pulls the enrichment chain
// into a renderer-less environment. The two predicates are trivially restated
// here; their real behavior is covered in lib/finishEnrichment.test.ts.
vi.mock("../lib/finishEnrichment", () => ({
  isPendingEnrich: (body: string) => body.includes("status: pending-enrich"),
  isReEnrichableMode: (mode: string) => ["idea", "person"].includes(mode),
  finishPendingEnrichment: vi.fn(async () => ({
    kind: "updated",
    markdown: "---\n---\n# Finished\n\nFinished body.\n",
  })),
  reEnrichNoteInPlace: vi.fn(async () => ({
    kind: "updated",
    markdown: "---\n---\n# Re-enriched\n\nRe-enriched body.\n",
  })),
}));

// Fully mocked for the same reason as finishEnrichment above: only the
// exported entry points RecentDetailScreen calls need a double here; the real
// parse/splice logic is covered in noteReprocess.test.ts / enhanceProse.test.ts.
vi.mock("../lib/noteReprocess", () => ({
  reEnrichNote: vi.fn(async () => ({
    kind: "updated",
    nextBody: "---\n---\n# Image Re-enriched\n\nImage re-enriched body.\n",
  })),
  transcribeNote: vi.fn(async () => ({
    kind: "updated",
    nextBody: "---\n---\n# Transcribed\n\nTranscribed body.\n",
  })),
}));
vi.mock("../lib/enhanceProse", () => ({
  enhanceNoteProse: vi.fn(async () => ({
    kind: "updated",
    nextBody: "---\n---\n# Enhanced\n\nEnhanced body.\n",
    providerLabel: "TestModel",
  })),
}));

// react-native-markdown-display ships raw JSX in .js files, which vite
// can't parse once the package is inlined. Markdown → native rendering
// isn't what this smoke test covers; a passthrough keeps the body text
// findable.
vi.mock("react-native-markdown-display", async () => {
  const { Text } = await import("react-native");
  return {
    default: ({ children }: { children?: unknown }) => (
      <Text>{String(children ?? "")}</Text>
    ),
  };
});

// WebView-backed editor and native AV — out of smoke-test scope.
vi.mock("../components/WysiwygEditor", async () => {
  const { forwardRef } = await import("react");
  return { WysiwygEditor: forwardRef(() => null) };
});
vi.mock("expo-av", () => ({
  Audio: { Sound: { createAsync: vi.fn() } },
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(),
}));

import RecentDetailScreen from "./RecentDetailScreen";
import { readNote, updateNote } from "../lib/writer";
import { finishPendingEnrichment, reEnrichNoteInPlace } from "../lib/finishEnrichment";
import { removeFromHistory, updateCaptureTitleByFilepath } from "../lib/storage";
import { attachPhotoToNote } from "../lib/attachPhotoToNote";
import { reEnrichNote, transcribeNote } from "../lib/noteReprocess";
import { enhanceNoteProse } from "../lib/enhanceProse";

type ScreenProps = Parameters<typeof RecentDetailScreen>[0];

import { loadCachedNoteIndex, resolveNoteEntry, upsertNoteInIndex } from "../lib/vault";

const ENTRY: CaptureEntry = {
  id: "r1",
  mode: "idea",
  title: "Draft Survival Test",
  filepath: "file:///v/Ideas/draft-survival-test.md",
  createdAt: 1_751_975_746_000,
};

function makeNavigation() {
  return {
    setOptions: vi.fn(),
    navigate: vi.fn(),
    push: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    dispatch: vi.fn(),
  };
}

function renderScreen(entry: CaptureEntry = ENTRY) {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <RecentDetailScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={
          {
            key: "d",
            name: "RecentDetail",
            params: { entry },
          } as ScreenProps["route"]
        }
      />
    </PaperProvider>,
  );
  return { navigation };
}

/** Mount the ⋮ the screen installed into the navigation header (which lives
 * outside this tree) and open the actions sheet through it. */
function openActionsSheet(navigation: ReturnType<typeof makeNavigation>): void {
  const withHeader = navigation.setOptions.mock.calls
    .map(([opts]) => opts)
    .filter((o) => typeof o.headerRight === "function")
    .at(-1);
  render(<PaperProvider theme={carnetLight}>{withHeader.headerRight()}</PaperProvider>);
  fireEvent.click(screen.getByLabelText("More actions"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("RecentDetailScreen", () => {
  it("renders content-first: body + stamp row, no raw file path in the reading flow", async () => {
    renderScreen();
    expect(await screen.findByText(/Hello body text\./)).toBeTruthy();
    // Stamp row from real frontmatter parsing.
    expect(screen.getByText("Idea")).toBeTruthy();
    expect(screen.getByText("#qa-test")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    // The path lives in File info, not on the reading surface.
    expect(screen.queryByText(ENTRY.filepath)).toBeNull();
    // Single primary action.
    expect(screen.getByLabelText("Edit note")).toBeTruthy();
  });

  it("renders the Related card from the cached index and opens a hit with push (Back-able)", async () => {
    const relatedEntry = {
      uri: "file:///v/Ideas/other-qa-note.md",
      subdir: "Ideas" as const,
      title: "Other QA note",
      createdOrDate: 5,
      tags: ["qa-test"],
      mode: "idea" as const,
      excerpt: "",
    };
    vi.mocked(loadCachedNoteIndex).mockResolvedValue({
      builtAt: 1,
      notes: [relatedEntry],
    } as Awaited<ReturnType<typeof loadCachedNoteIndex>>);
    const target = {
      id: "r2",
      mode: "idea" as const,
      title: "Other QA note",
      filepath: relatedEntry.uri,
      createdAt: 1,
    };
    vi.mocked(resolveNoteEntry).mockResolvedValue(target);

    const { navigation } = renderScreen();
    // Shares the #qa-test tag with the open note → scores → card renders.
    expect(await screen.findByText("Related")).toBeTruthy();
    fireEvent.click(screen.getByText("Other QA note"));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("RecentDetail", {
        entry: target,
      }),
    );
  });

  it("link-plus persists a [[wikilink]] under ## Related and confirms via snackbar", async () => {
    const relatedEntry = {
      uri: "file:///v/Ideas/other-qa-note.md",
      subdir: "Ideas" as const,
      title: "Other QA note",
      createdOrDate: 5,
      tags: ["qa-test"],
      mode: "idea" as const,
      excerpt: "",
    };
    vi.mocked(loadCachedNoteIndex).mockResolvedValue({
      builtAt: 1,
      notes: [relatedEntry],
    } as Awaited<ReturnType<typeof loadCachedNoteIndex>>);

    renderScreen();
    await screen.findByText("Related");
    fireEvent.click(
      screen.getByLabelText("Link Other QA note into this note"),
    );

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    const written = vi.mocked(updateNote).mock.calls[0][1];
    expect(written).toContain("## Related");
    expect(written).toContain("- [[Other QA note]]");
    expect(
      await screen.findByText("Linked [[Other QA note]] under Related"),
    ).toBeTruthy();
  });

  it("tag stamp opens pre-filtered Search", async () => {
    const { navigation } = renderScreen();
    fireEvent.click(await screen.findByLabelText("Search notes tagged qa-test"));
    expect(navigation.navigate).toHaveBeenCalledWith("Search", { tag: "qa-test" });
  });

  it("header overflow opens the actions sheet; File info reveals the path; Delete asks first", async () => {
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);

    // The ⋮ lives in the navigation header (outside this tree) — render the
    // headerRight the screen installed and drive it; state flows back into
    // the screen's Portal because the closure shares the component instance.
    const withHeader = navigation.setOptions.mock.calls
      .map(([opts]) => opts)
      .filter((o) => typeof o.headerRight === "function")
      .at(-1);
    expect(withHeader).toBeTruthy();
    render(<PaperProvider theme={carnetLight}>{withHeader.headerRight()}</PaperProvider>);
    fireEvent.click(screen.getByLabelText("More actions"));

    expect(await screen.findByText("File info")).toBeTruthy();
    // Idea notes: no re-enrich/transcribe rows, Karakeep unconfigured.
    expect(screen.queryByText("Re-enrich")).toBeNull();
    expect(screen.queryByText("Transcribe")).toBeNull();
    expect(screen.queryByText("Send to Karakeep")).toBeNull();

    fireEvent.click(screen.getByText("File info"));
    expect(await screen.findByText(ENTRY.filepath)).toBeTruthy();

    // Reopen the sheet; Delete routes through the confirm dialog.
    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(await screen.findByText("Delete"));
    expect(await screen.findByText("Move to Archive?")).toBeTruthy();
  });

  it("Attach photo opens the camera modal and a shot dispatches to attachPhotoToNote", async () => {
    vi.mocked(attachPhotoToNote).mockResolvedValue({
      kind: "attached",
      rel: "../Photos/photo.jpg",
      nextBody: `${NOTE_MD.trimEnd()}\n\n![](../Photos/photo.jpg)\n`,
    });
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);

    const withHeader = navigation.setOptions.mock.calls
      .map(([opts]) => opts)
      .filter((o) => typeof o.headerRight === "function")
      .at(-1);
    render(<PaperProvider theme={carnetLight}>{withHeader.headerRight()}</PaperProvider>);
    fireEvent.click(screen.getByLabelText("More actions"));

    fireEvent.click(await screen.findByText("Attach photo"));
    fireEvent.click(await screen.findByText("fake-shutter"));

    await waitFor(() =>
      expect(attachPhotoToNote).toHaveBeenCalledWith({
        filepath: ENTRY.filepath,
        base64: "AAAA",
        mime: "image/jpeg",
        basename: undefined,
      }),
    );
    // The refreshed body comes back from the lib module, not a local splice.
    expect(await screen.findByText("Photo attached.")).toBeTruthy();
  });

  it("surfaces a refused attach in the banner slot", async () => {
    vi.mocked(attachPhotoToNote).mockResolvedValue({
      kind: "failed",
      reason: "The note was written to from somewhere else.",
    });
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);

    const withHeader = navigation.setOptions.mock.calls
      .map(([opts]) => opts)
      .filter((o) => typeof o.headerRight === "function")
      .at(-1);
    render(<PaperProvider theme={carnetLight}>{withHeader.headerRight()}</PaperProvider>);
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(await screen.findByText("Attach photo"));
    fireEvent.click(await screen.findByText("fake-shutter"));

    expect(
      await screen.findByText(
        /Attach photo failed: The note was written to from somewhere else\./,
      ),
    ).toBeTruthy();
  });

  it("missing file shows the dedicated state and Remove from list works", async () => {
    vi.mocked(readNote).mockRejectedValueOnce(new Error("gone"));
    const { navigation } = renderScreen();
    expect(await screen.findByText("Note not found")).toBeTruthy();
    // No Edit FAB in the missing state.
    expect(screen.queryByLabelText("Edit note")).toBeNull();

    fireEvent.click(screen.getByText("Remove from list"));
    await waitFor(() => expect(removeFromHistory).toHaveBeenCalledWith("r1"));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
  });

  // #114. handleDelete catches everything and always reaches goBack(), but
  // handleRemoveFromHistory had no try/catch: a rejection skipped goBack() AND
  // left the shared deletingRef latched true, so BOTH destructive actions were
  // dead for the rest of the screen's life with no feedback.
  it("a failing Remove from list does not permanently latch the screen (#114)", async () => {
    vi.mocked(readNote).mockRejectedValueOnce(new Error("gone"));
    vi.mocked(removeFromHistory).mockRejectedValueOnce(new Error("disk full"));
    const { navigation } = renderScreen();
    expect(await screen.findByText("Note not found")).toBeTruthy();

    // First attempt fails.
    fireEvent.click(screen.getByText("Remove from list"));
    await waitFor(() => expect(removeFromHistory).toHaveBeenCalledTimes(1));

    // The guard must have been released: a retry actually re-invokes it.
    // Without the finally-reset this second click is swallowed by the latch.
    fireEvent.click(screen.getByText("Remove from list"));
    await waitFor(() => expect(removeFromHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
  });

  it("still guards against a double-tap while a removal is in flight (#114)", async () => {
    vi.mocked(readNote).mockRejectedValueOnce(new Error("gone"));
    let release!: () => void;
    vi.mocked(removeFromHistory).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = () => resolve(); }),
    );
    renderScreen();
    expect(await screen.findByText("Note not found")).toBeTruthy();

    fireEvent.click(screen.getByText("Remove from list"));
    fireEvent.click(screen.getByText("Remove from list"));
    await waitFor(() => expect(removeFromHistory).toHaveBeenCalledTimes(1));
    release();
  });
});

// ── Generalized re-enrich (mode-gated, not pending-gated) ────────────────────

const ENRICHED_MD =
  "---\ncreated: 2026-07-08T11:55:46.000Z\nstatus: seedling\ntags: [qa-test]\n---\n# Draft Survival Test\n\nHello body text.\n";

describe("RecentDetailScreen — re-enrich family", () => {
  // clearAllMocks clears calls, not implementations — restate the default note
  // so a test that swaps in ENRICHED_MD can't leak into the next one.
  beforeEach(() => {
    vi.mocked(readNote).mockResolvedValue(NOTE_MD);
  });

  it("offers Re-enrich on a normally-enriched Idea note (was unreachable before)", async () => {
    vi.mocked(readNote).mockResolvedValue(ENRICHED_MD);
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);

    expect(await screen.findByText("Re-enrich")).toBeTruthy();
    // Mutually exclusive: the pending-specific row must not also render.
    expect(screen.queryByText("Finish enrichment")).toBeNull();
  });

  it("re-enriches with the note's CURRENT body and mode, and shows the result", async () => {
    vi.mocked(readNote).mockResolvedValue(ENRICHED_MD);
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Re-enrich"));

    await waitFor(() =>
      expect(reEnrichNoteInPlace).toHaveBeenCalledWith({
        body: ENRICHED_MD,
        filepath: ENTRY.filepath,
        mode: "idea",
      }),
    );
    expect(await screen.findByText(/Re-enriched body\./)).toBeTruthy();
  });

  it("refreshes the note index and the recents title so other surfaces aren't left stale", async () => {
    // Enrichment rewrites title and tags, but Home cards, the tag browser and
    // search all read the cached index + capture history — not this screen's
    // state. Without this the note stayed stale everywhere until a full rescan.
    vi.mocked(readNote).mockResolvedValue(ENRICHED_MD);
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Re-enrich"));

    await waitFor(() =>
      expect(upsertNoteInIndex).toHaveBeenCalledWith(
        ENTRY.filepath,
        "---\n---\n# Re-enriched\n\nRe-enriched body.\n",
      ),
    );
    await waitFor(() =>
      expect(updateCaptureTitleByFilepath).toHaveBeenCalledWith(ENTRY.filepath, "Re-enriched"),
    );
  });

  it("leaves the index and recents title alone when re-enrichment fails", async () => {
    vi.mocked(readNote).mockResolvedValue(ENRICHED_MD);
    vi.mocked(reEnrichNoteInPlace).mockResolvedValueOnce({
      kind: "failed",
      reason: "nope",
    });
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Re-enrich"));

    await screen.findByText(/nope/);
    expect(upsertNoteInIndex).not.toHaveBeenCalled();
    expect(updateCaptureTitleByFilepath).not.toHaveBeenCalled();
  });

  it("a pending note still shows Finish enrichment, and only that", async () => {
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);

    expect(await screen.findByText("Finish enrichment")).toBeTruthy();
    expect(screen.queryByText("Re-enrich")).toBeNull();
  });

  it("does not offer Re-enrich for a journal note — its day file holds many entries", async () => {
    vi.mocked(readNote).mockResolvedValue(ENRICHED_MD);
    const { navigation } = renderScreen({ ...ENTRY, mode: "journal" });
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);

    expect(await screen.findByText("File info")).toBeTruthy();
    expect(screen.queryByText("Re-enrich")).toBeNull();
  });

  it("does not offer Re-enrich for a mode with no text enrichment path", async () => {
    vi.mocked(readNote).mockResolvedValue(ENRICHED_MD);
    const { navigation } = renderScreen({ ...ENTRY, mode: "audio" });
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);

    expect(await screen.findByText("File info")).toBeTruthy();
    expect(screen.queryByText("Re-enrich")).toBeNull();
  });

  it("does not offer Re-enrich for a synthesis note in Notes/, even though its mode reports idea", async () => {
    // inferNoteMode falls back to "idea" for Notes/ (no CaptureMode variant
    // exists for it yet), so isReEnrichableMode(entry.mode) alone would wrongly
    // pass. Re-enrich on a synthesis note would run the idea prompt over a
    // computed answer and overwrite it — must be gated by the uri, not mode.
    vi.mocked(readNote).mockResolvedValue(ENRICHED_MD);
    const { navigation } = renderScreen({
      ...ENTRY,
      mode: "idea",
      filepath: "file:///v/Notes/synth.md",
    });
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);

    expect(await screen.findByText("File info")).toBeTruthy();
    expect(screen.queryByText("Re-enrich")).toBeNull();
  });

  it("surfaces a failed re-enrich as a banner instead of replacing the body", async () => {
    vi.mocked(readNote).mockResolvedValue(ENRICHED_MD);
    vi.mocked(reEnrichNoteInPlace).mockResolvedValueOnce({
      kind: "failed",
      reason: "model exploded",
    });
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Re-enrich"));

    expect(await screen.findByText(/model exploded/)).toBeTruthy();
    expect(screen.getByText(/Hello body text\./)).toBeTruthy();
  });
});

// ── Busy-latch release on rejection (regression) ────────────────────────────
//
// handleReEnrich/handleFinishEnrichment/handleGeneralReEnrich/handleTranscribe/
// handleEnhance each set a ref + busy-state flag, await their lib call, and
// clear both — same shape handleDelete/handleRemoveFromHistory had before
// #114. Today the callees swallow every failure into an outcome union, so
// this can't latch in practice, but the try/finally exists for the same
// reason handleDelete's does: a future uncaught rejection must release the
// guard instead of pinning `actionsBusy` (disabling the whole actions sheet)
// with no feedback. Mocking the lib call to REJECT bypasses the callee's own
// internal catch to exercise that finally directly. The handler itself still
// has no catch (only finally, per the wrapping this fix adds), so the
// rejection surfaces as an unhandled promise rejection — expected and
// swallowed via the process listener below, not a bug in the fix.
/** Re-click the already-rendered ⋮ header. Unlike openActionsSheet, this does
 * NOT render a fresh header tree — calling openActionsSheet a second time in
 * the same test piles up duplicate "More actions" buttons (one per render),
 * which breaks getByLabelText. */
function reopenActionsSheet(): void {
  const buttons = screen.getAllByLabelText("More actions");
  fireEvent.click(buttons[buttons.length - 1]);
}

describe("RecentDetailScreen — busy-latch release on rejection (regression)", () => {
  let unhandled: unknown[];
  let onUnhandledRejection: (err: unknown) => void;

  beforeEach(() => {
    vi.mocked(readNote).mockResolvedValue(NOTE_MD);
    unhandled = [];
    onUnhandledRejection = (err: unknown) => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });

  const SHARED_IMAGE_MD =
    "---\ncreated: 2026-07-08T11:55:46.000Z\nkind: shared-image\ntags: [qa-test]\n---\n# Photo Note\n\n![](../Photos/photo.jpg)\n";
  const SHARED_AUDIO_MD =
    "---\ncreated: 2026-07-08T11:55:46.000Z\nkind: shared-audio\ntags: [qa-test]\n---\n# Audio Note\n\n[audio](../Audio/note.m4a)\n";

  it("a failing Re-enrich (image) does not permanently latch the actions sheet", async () => {
    vi.mocked(readNote).mockResolvedValue(SHARED_IMAGE_MD);
    vi.mocked(reEnrichNote).mockRejectedValueOnce(new Error("boom"));
    const { navigation } = renderScreen();
    await screen.findByText(/Photo Note/);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Re-enrich"));
    await waitFor(() => expect(reEnrichNote).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unhandled).toHaveLength(1));

    // The guard must have been released: a retry actually re-invokes it.
    // Without the finally-reset this second click is swallowed by the latch.
    reopenActionsSheet();
    fireEvent.click(await screen.findByText("Re-enrich"));
    await waitFor(() => expect(reEnrichNote).toHaveBeenCalledTimes(2));
  });

  it("a failing Finish enrichment does not permanently latch the actions sheet", async () => {
    vi.mocked(finishPendingEnrichment).mockRejectedValueOnce(new Error("boom"));
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Finish enrichment"));
    await waitFor(() => expect(finishPendingEnrichment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unhandled).toHaveLength(1));

    reopenActionsSheet();
    fireEvent.click(await screen.findByText("Finish enrichment"));
    await waitFor(() => expect(finishPendingEnrichment).toHaveBeenCalledTimes(2));
  });

  it("a failing general Re-enrich does not permanently latch the actions sheet", async () => {
    vi.mocked(readNote).mockResolvedValue(
      "---\ncreated: 2026-07-08T11:55:46.000Z\nstatus: seedling\ntags: [qa-test]\n---\n# Draft Survival Test\n\nHello body text.\n",
    );
    vi.mocked(reEnrichNoteInPlace).mockRejectedValueOnce(new Error("boom"));
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Re-enrich"));
    await waitFor(() => expect(reEnrichNoteInPlace).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unhandled).toHaveLength(1));

    reopenActionsSheet();
    fireEvent.click(await screen.findByText("Re-enrich"));
    await waitFor(() => expect(reEnrichNoteInPlace).toHaveBeenCalledTimes(2));
  });

  it("a failing Transcribe does not permanently latch the actions sheet", async () => {
    vi.mocked(readNote).mockResolvedValue(SHARED_AUDIO_MD);
    vi.mocked(transcribeNote).mockRejectedValueOnce(new Error("boom"));
    const { navigation } = renderScreen();
    await screen.findByText(/Audio Note/);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Transcribe"));
    await waitFor(() => expect(transcribeNote).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unhandled).toHaveLength(1));

    reopenActionsSheet();
    fireEvent.click(await screen.findByText("Transcribe"));
    await waitFor(() => expect(transcribeNote).toHaveBeenCalledTimes(2));
  });

  it("a failing Enhance does not permanently latch the actions sheet", async () => {
    vi.mocked(enhanceNoteProse).mockRejectedValueOnce(new Error("boom"));
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Enhance"));
    await waitFor(() => expect(enhanceNoteProse).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unhandled).toHaveLength(1));

    reopenActionsSheet();
    fireEvent.click(await screen.findByText("Enhance"));
    await waitFor(() => expect(enhanceNoteProse).toHaveBeenCalledTimes(2));
  });

  it("a failing Attach photo does not permanently latch the actions sheet", async () => {
    vi.mocked(attachPhotoToNote).mockRejectedValueOnce(new Error("boom"));
    const { navigation } = renderScreen();
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Attach photo"));
    fireEvent.click(await screen.findByText("fake-shutter"));
    await waitFor(() => expect(attachPhotoToNote).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unhandled).toHaveLength(1));

    // The camera modal stays open after a shot (no auto-dismiss in
    // handleAttachPhoto), so the retry re-fires the same shutter button
    // rather than reopening the sheet + modal.
    fireEvent.click(await screen.findByText("fake-shutter"));
    await waitFor(() => expect(attachPhotoToNote).toHaveBeenCalledTimes(2));
  });
});
