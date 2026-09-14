// @vitest-environment jsdom
//
// Screen smoke test for the capture flow, Idea mode (pattern: see
// TagBrowserScreen.test.tsx). Native capture surfaces (voice, card scanner)
// are mocked out; the flow under test is the screen's own wiring: the
// distraction-free input, draft restore/autosave, the metadata sheet, the
// save-first Send path, and the degraded-enrichment state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";

// Native speech stack — irrelevant here; the ref API must exist.
vi.mock("../voice/VoiceButton", async () => {
  const { forwardRef } = await import("react");
  return {
    VoiceButton: forwardRef(() => null),
  };
});

// expo-camera OCR modal.
vi.mock("../components/CardScannerModal", () => ({
  CardScannerModal: () => null,
}));

vi.mock("../lib/settings", () => ({
  getSettings: vi.fn(async () => ({ previewBeforeSave: false })),
}));

vi.mock("../lib/storage", () => ({
  recordCapture: vi.fn(async () => {}),
  removeFromHistoryByFilepath: vi.fn(async () => {}),
}));

vi.mock("../lib/dispatcher", () => ({
  enrichIdea: vi.fn(),
  enrichJournal: vi.fn(),
  enrichPerson: vi.fn(),
  isPermanentError: vi.fn(() => false),
  isNotConfiguredError: vi.fn(() => false),
  isInsecureTransportError: vi.fn(() => false),
  promoteIdea: vi.fn(),
}));

vi.mock("../lib/writer", () => ({
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
  writeIdea: vi.fn(),
  appendJournal: vi.fn(),
  writePerson: vi.fn(),
  writeBinary: vi.fn(),
  injectAttachments: vi.fn((md: string) => md),
  injectPlaces: vi.fn((md: string, places: { name: string; coords: { lat: number; lon: number } }[]) =>
    places.length === 0
      ? md
      : `${md}\n\n## Places\n\n${places
          .map((pl) => `[${pl.name}](geo:${pl.coords.lat},${pl.coords.lon})`)
          .join("\n\n")}\n`,
  ),
  extFromMime: vi.fn(() => "jpg"),
  // Must honour readNote's real async contract: the saved-screen Re-enrich
  // reads the note for its conflict baseline and chains off the promise.
  readNote: vi.fn(async () => "---\nstatus: pending-enrich\n---\nmy idea\n"),
  updateNoteIfUnchanged: vi.fn(),
  getModificationTime: vi.fn(async () => 1),
  rewriteFrontmatterField: vi.fn((md: string) => md),
  extractNameFromMarkdown: vi.fn(() => ({ firstName: "A", lastName: "B" })),
}));

vi.mock("../lib/ideaSaveFirst", () => ({
  writeRawIdea: vi.fn(async () => ({
    filepath: "file:///v/Ideas/my-idea.md",
    slug: "my-idea",
    mtime: 111,
    markdown: "---\nstatus: pending-enrich\n---\nmy idea\n",
  })),
  rewriteRawIdea: vi.fn(async () => ({
    filepath: "file:///v/Ideas/my-idea.md",
    mtime: 222,
    markdown: "---\nstatus: pending-enrich\n---\nmy edited idea\n",
  })),
  enrichIdeaInPlace: vi.fn(async () => ({
    kind: "updated",
    markdown: "---\n---\n# My Idea\n\nmy idea\n",
  })),
}));

// Place resolution is network/native-backed; unit-tested in mapsLink.test.ts
// and location.test.ts. Here we only care that resolved places reach the save.
vi.mock("../lib/mapsLink", () => ({ resolveMapsLink: vi.fn() }));
vi.mock("../lib/location", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/location")>();
  return { ...actual, resolvePlaceName: vi.fn() };
});

vi.mock("../lib/attachments", () => ({
  pickAttachment: vi.fn(async () => null),
}));

vi.mock("../lib/attachmentPersistence", () => ({
  persistAttachments: vi.fn(async () => []),
}));

vi.mock("../lib/captureDraft", () => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
}));

vi.mock("../lib/queue", () => ({
  enqueue: vi.fn(async () => {}),
  drainQueue: vi.fn(async () => {}),
  getQueueDepth: vi.fn(async () => 0),
}));

vi.mock("../lib/vault", () => ({
  getTagIndex: vi.fn(async () => ({ builtAt: 1, tags: [] })),
  upsertNoteInIndex: vi.fn(async () => {}),
}));

import CaptureScreen from "./CaptureScreen";
import { loadDraft, saveDraft, clearDraft } from "../lib/captureDraft";
import { writeRawIdea, rewriteRawIdea, enrichIdeaInPlace } from "../lib/ideaSaveFirst";
import { getSettings } from "../lib/settings";
import { enrichIdea, enrichJournal, enrichPerson } from "../lib/dispatcher";
import { recordCapture, removeFromHistoryByFilepath } from "../lib/storage";
import { enqueue } from "../lib/queue";
import { persistAttachments } from "../lib/attachmentPersistence";
import { clearDraft as clearDraftMock } from "../lib/captureDraft";
import { upsertNoteInIndex } from "../lib/vault";
import { appendJournal } from "../lib/writer";
import { resolvePlaceName } from "../lib/location";

type ScreenProps = Parameters<typeof CaptureScreen>[0];

function makeNavigation() {
  return {
    setOptions: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
  };
}

function renderScreen(mode: "idea" | "journal" | "person" = "idea") {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <CaptureScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={
          { key: "c", name: "Capture", params: { mode } } as ScreenProps["route"]
        }
      />
    </PaperProvider>,
  );
  return { navigation };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockReset();
  vi.mocked(getSettings).mockResolvedValue({ previewBeforeSave: false } as Awaited<ReturnType<typeof getSettings>>);
});

afterEach(cleanup);

describe("CaptureScreen (idea)", () => {
  it("starts distraction-free: input + disabled Send, metadata behind '+'", async () => {
    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    expect(input).toBeTruthy();
    expect(screen.getByText("0 chars")).toBeTruthy();
    // No tag/location/attachment chrome docked in the writing surface.
    expect(screen.queryByText("Tags & details")).toBeNull();
    // Send exists but is disabled with no text — clicking must be a no-op.
    fireEvent.click(screen.getByText("Send"));
    expect(writeRawIdea).not.toHaveBeenCalled();
  });

  it("restores a persisted draft into the input", async () => {
    vi.mocked(loadDraft).mockResolvedValueOnce({
      text: "half a thought",
      transcript: "",
      ocrText: "",
      savedAt: 1,
    });
    renderScreen();
    expect(await screen.findByDisplayValue("half a thought")).toBeTruthy();
  });

  it("autosaves the draft while typing (debounced)", async () => {
    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "typing away" } });
    await waitFor(
      () =>
        expect(saveDraft).toHaveBeenCalledWith(
          "idea",
          expect.objectContaining({ text: "typing away" }),
          "default",
        ),
      { timeout: 2000 },
    );
  });

  it("keeps a Work form's draft and completed history in Work after profile lookup", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      previewBeforeSave: false,
      captureFolderPath: "file:///work",
      vaultProfiles: [
        { id: "default", name: "Personal", rootUri: "file:///personal", createdAt: 0 },
        { id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 },
      ],
      activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "work-only thought" } });
    await waitFor(() =>
      expect(saveDraft).toHaveBeenCalledWith(
        "idea",
        expect.objectContaining({ text: "work-only thought" }),
        "work",
      ),
    );
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(recordCapture).toHaveBeenCalledWith(expect.anything(), "work");
    expect(clearDraft).toHaveBeenCalledWith("idea", "work");
  });

  it("opens the Tags & details sheet from the '+' button", async () => {
    renderScreen();
    await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.click(
      screen.getByLabelText("Add tags, location, or attachments"),
    );
    expect(await screen.findByText("Tags & details")).toBeTruthy();
    expect(screen.getByText("Image")).toBeTruthy();
    expect(screen.getByText("File")).toBeTruthy();
  });

  it("save-first Send: writes the raw note, records it, upserts the index, clears the draft, and closes on enrichment success", async () => {
    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(writeRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ text: "my idea" }),
      expect.anything(),
      expect.anything(),
    );
    expect(recordCapture).toHaveBeenCalledWith(
      expect.objectContaining({ filepath: "file:///v/Ideas/my-idea.md" }),
      "default",
    );
    // Raw write upsert + enriched upsert.
    expect(upsertNoteInIndex).toHaveBeenCalledTimes(2);
    expect(clearDraft).toHaveBeenCalledWith("idea", "default");
  });

  it("permanent enrichment failure keeps the note and offers Re-enrich in plain language", async () => {
    vi.mocked(enrichIdeaInPlace).mockResolvedValueOnce({
      kind: "failed",
      transient: false,
      reason: "model exploded",
    });
    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    expect(await screen.findByText("Saved to vault")).toBeTruthy();
    expect(
      screen.getByText(/Your note is safe in the vault/),
    ).toBeTruthy();
    expect(screen.getByText("Re-enrich")).toBeTruthy();
    // The screen stays open for the user to decide — no auto-dismiss.
    expect(navigation.goBack).not.toHaveBeenCalled();
    // The raw note was still written and recorded before the failure.
    expect(writeRawIdea).toHaveBeenCalled();
    expect(recordCapture).toHaveBeenCalled();
  });

  it("submitting-phase label names the configured backend, not a hardcoded OmniRoute", async () => {
    // Blocking-preview path (previewBeforeSave: true) calls enrichIdea
    // directly, which is where the "submitting" phase is actually visible —
    // the default save-first path resolves too fast in tests to observe it.
    vi.mocked(getSettings).mockResolvedValueOnce({
      previewBeforeSave: true,
      activeProviderId: "relais",
    } as Awaited<ReturnType<typeof getSettings>>);
    let resolveEnrich!: (v: { markdown: string; model: string }) => void;
    vi.mocked(enrichIdea).mockReturnValueOnce(
      new Promise((res) => {
        resolveEnrich = res;
      }),
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    expect(
      await screen.findByText("Local LLM is structuring the note…"),
    ).toBeTruthy();
    expect(screen.queryByText("OmniRoute is structuring the note…")).toBeNull();

    resolveEnrich({ markdown: "# My Idea\n\nbody\n", model: "local-model" });
  });
});

// ── Edit during "submitting" — the non-blocking escape hatch ──────────────────

/** A promise the test resolves by hand, so the enrichment can be held in
 * flight while the Edit affordance is exercised. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("CaptureScreen — Edit during enrichment", () => {
  it("idea: restores the draft and ignores the enrichment that lands afterwards", async () => {
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    // The raw note is already on disk; the input was cleared by save-first.
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalled());
    fireEvent.click(await screen.findByText("Edit"));

    // Back to an editable draft carrying the user's original text.
    expect(await screen.findByDisplayValue("my idea")).toBeTruthy();

    // The abandoned call lands late — it must not steer the screen.
    enrich.resolve({ kind: "updated", markdown: "# Enriched\n" });
    await waitFor(() => expect(screen.getByDisplayValue("my idea")).toBeTruthy());
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved to vault")).toBeNull();
  });

  it("idea: resubmitting after Edit overwrites the same file instead of writing a twin", async () => {
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Edit"));

    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalled());
    expect(rewriteRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "my edited idea",
        filepath: "file:///v/Ideas/my-idea.md",
      }),
      expect.anything(),
    );
    // The whole point: no second raw write, so no orphaned -2.md.
    expect(writeRawIdea).toHaveBeenCalledTimes(1);
  });

  it("idea: a resubmit after Edit keeps the attachments the first submit already wrote", async () => {
    // `pending` is cleared the moment the raw note lands, so the resubmit's
    // persistAttachments() has nothing to return — without the preserved refs
    // the rewritten note drops its embeds and orphans the binaries on disk.
    const ref = { kind: "image" as const, rel: "../Photos/sketch.png", filename: "sketch.png" };
    vi.mocked(persistAttachments).mockResolvedValueOnce([ref]).mockResolvedValue([]);
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalledTimes(1));
    expect(vi.mocked(writeRawIdea).mock.calls[0][0].attachments).toEqual([ref]);

    fireEvent.click(await screen.findByText("Edit"));
    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() =>
      expect(rewriteRawIdea).toHaveBeenCalledWith(
        expect.objectContaining({ text: "my edited idea" }),
        expect.anything(),
      ),
    );
    const resubmit = vi
      .mocked(rewriteRawIdea)
      .mock.calls.find((c) => c[0].text === "my edited idea");
    expect(resubmit?.[0].attachments).toEqual([ref]);
  });

  it("idea: Edit bumps the raw note's mtime so the in-flight enrichment can't land", async () => {
    // Edit itself touches no file, so the enrichment fired before it would find
    // a matching mtime and write the result the user walked away from. Writing
    // the same raw draft back invalidates that call's baseline instead.
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(enrichIdeaInPlace).toHaveBeenCalled());
    expect(rewriteRawIdea).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText("Edit"));

    // Same file, same content — the write exists only to move the mtime, and it
    // has to happen while the enrichment is still in flight to be of any use.
    await waitFor(() =>
      expect(rewriteRawIdea).toHaveBeenCalledWith(
        expect.objectContaining({ filepath: "file:///v/Ideas/my-idea.md", text: "my idea" }),
        expect.anything(),
      ),
    );
  });

  it("idea: Edit during a saved-screen Re-enrich does NOT rewrite the note", async () => {
    // Re-enrich publishes a SYNTHETIC rawWriteRef (no write happens — it only
    // hands Edit the already-known filepath) and a draft holding the ORIGINAL
    // raw text. Bumping the mtime there would overwrite whatever is on disk
    // now — the enriched note, or a newer Syncthing-synced one — with a raw
    // stub. Real data loss, so the bump must be skipped in this path.
    vi.mocked(enrichIdeaInPlace).mockResolvedValueOnce({
      kind: "failed",
      transient: false,
      reason: "no api key",
    });
    const reEnrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      reEnrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    // A permanent failure keeps the raw note and offers Re-enrich.
    fireEvent.click(await screen.findByText("Re-enrich"));
    fireEvent.click(await screen.findByText("Edit"));
    await screen.findByDisplayValue("my idea");

    expect(rewriteRawIdea).not.toHaveBeenCalled();
  });

  it("idea: an Edit-and-resubmit cycle keeps the note's original created time", async () => {
    // buildRawIdeaMarkdown defaults `now` to new Date(), so any rewrite that
    // doesn't pass one restamps `created` — the capture moment did not change
    // just because the text was edited.
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalledTimes(1));
    const created = vi.mocked(writeRawIdea).mock.calls[0][1];
    expect(created).toBeInstanceOf(Date);

    fireEvent.click(await screen.findByText("Edit"));
    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() =>
      expect(rewriteRawIdea).toHaveBeenCalledWith(
        expect.objectContaining({ text: "my edited idea" }),
        expect.anything(),
      ),
    );
    // Every rewrite in the cycle — the Edit-time mtime bump and the resubmit —
    // carries the first write's timestamp.
    for (const call of vi.mocked(rewriteRawIdea).mock.calls) {
      expect(call[1]).toBe(created);
    }
  });

  it("idea: an attachment still staged at Edit is embedded once, not twice", async () => {
    // persistAttachments memoizes by PickedAttachment identity, so a resubmit
    // can legitimately return the same ref the first submit preserved — the
    // merge has to collapse them or the note gets a doubled embed.
    const ref = { kind: "image" as const, rel: "../Photos/sketch.png", filename: "sketch.png" };
    vi.mocked(persistAttachments).mockResolvedValue([ref]);
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValueOnce(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByText("Edit"));
    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() =>
      expect(rewriteRawIdea).toHaveBeenCalledWith(
        expect.objectContaining({ text: "my edited idea" }),
        expect.anything(),
      ),
    );
    const resubmit = vi
      .mocked(rewriteRawIdea)
      .mock.calls.find((c) => c[0].text === "my edited idea");
    expect(resubmit?.[0].attachments).toEqual([ref]);
  });

  it("journal: keeps the transcript and ignores the late enrichment", async () => {
    const enrich = deferred<{ markdown: string; model: string }>();
    vi.mocked(enrichJournal).mockReturnValueOnce(enrich.promise);

    renderScreen("journal");
    const input = await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.change(input, { target: { value: "walked the dog" } });
    fireEvent.click(screen.getByText("Send"));

    fireEvent.click(await screen.findByText("Edit"));
    expect(await screen.findByDisplayValue("walked the dog")).toBeTruthy();

    enrich.resolve({ markdown: "# Journal\n", model: "m" });
    await waitFor(() => expect(screen.getByDisplayValue("walked the dog")).toBeTruthy());
    // No preview card — the abandoned result never reached the UI.
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("person: keeps the card text and ignores the late enrichment", async () => {
    const enrich = deferred<{ markdown: string; model: string }>();
    vi.mocked(enrichPerson).mockReturnValueOnce(enrich.promise);

    renderScreen("person");
    const input = await screen.findByPlaceholderText("Card text — scan or type");
    fireEvent.change(input, { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByText("Send"));

    fireEvent.click(await screen.findByText("Edit"));
    expect(await screen.findByDisplayValue("Ada Lovelace")).toBeTruthy();

    enrich.resolve({ markdown: "# Ada\n", model: "m" });
    await waitFor(() => expect(screen.getByDisplayValue("Ada Lovelace")).toBeTruthy());
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("journal: a late enrichment FAILURE is also swallowed after Edit", async () => {
    // Without the guard, handleCaptureError would queue the capture and wipe
    // the transcript the user just returned to editing.
    let reject!: (e: Error) => void;
    vi.mocked(enrichJournal).mockReturnValueOnce(
      new Promise((_res, rej) => {
        reject = rej;
      }),
    );

    renderScreen("journal");
    const input = await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.change(input, { target: { value: "walked the dog" } });
    fireEvent.click(screen.getByText("Send"));
    fireEvent.click(await screen.findByText("Edit"));

    reject(new Error("network down"));
    await waitFor(() => expect(screen.getByDisplayValue("walked the dog")).toBeTruthy());
    expect(screen.queryByText("Offline — capture queued.")).toBeNull();
  });
});

describe("CaptureScreen — Edit race conditions", () => {
  it("a stale enrichment from the FIRST submit cannot drive the screen after a resubmit", async () => {
    // The bug a boolean abort flag has: the second submit clears the flag, which
    // un-cancels call #1, whose late resolution then closed the screen.
    const first = deferred<{ kind: "updated"; markdown: string }>();
    const second = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace)
      .mockReturnValueOnce(first.promise as ReturnType<typeof enrichIdeaInPlace>)
      .mockReturnValueOnce(second.promise as ReturnType<typeof enrichIdeaInPlace>);

    const { navigation } = renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(writeRawIdea).toHaveBeenCalled());

    fireEvent.click(await screen.findByText("Edit"));
    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalled());

    // Submit #1's abandoned call finally lands, while #2 is still in flight.
    first.resolve({ kind: "updated", markdown: "# Stale\n" });
    await waitFor(() => expect(screen.getByText(/structuring the note/)).toBeTruthy());
    expect(navigation.goBack).not.toHaveBeenCalled();

    // Submit #2 still owns the screen and completes normally.
    second.resolve({ kind: "updated", markdown: "# Fresh\n" });
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
  });

  it("Edit tapped BEFORE the raw write resolves still routes the resubmit to rewriteRawIdea", async () => {
    // editingFilepath comes from the write's own result, so Edit has to wait for
    // it — otherwise the resubmit writes a second file and orphans the first.
    const write = deferred<{
      filepath: string;
      slug: string;
      mtime: number;
      markdown: string;
    }>();
    vi.mocked(writeRawIdea).mockReturnValueOnce(
      write.promise as ReturnType<typeof writeRawIdea>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    // Tap Edit while the write is still in flight.
    fireEvent.click(await screen.findByText("Edit"));
    write.resolve({
      filepath: "file:///v/Ideas/my-idea.md",
      slug: "my-idea",
      mtime: 111,
      markdown: "---\nstatus: pending-enrich\n---\nmy idea\n",
    });

    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalled());
    expect(rewriteRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ filepath: "file:///v/Ideas/my-idea.md" }),
      expect.anything(),
    );
    expect(writeRawIdea).toHaveBeenCalledTimes(1);
  });

  it("the interrupted write's own continuation does not clear the restored draft", async () => {
    const write = deferred<{
      filepath: string;
      slug: string;
      mtime: number;
      markdown: string;
    }>();
    vi.mocked(writeRawIdea).mockReturnValueOnce(
      write.promise as ReturnType<typeof writeRawIdea>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    fireEvent.click(await screen.findByText("Edit"));

    write.resolve({
      filepath: "file:///v/Ideas/my-idea.md",
      slug: "my-idea",
      mtime: 111,
      markdown: "---\nstatus: pending-enrich\n---\nmy idea\n",
    });

    // The superseded write must not run its post-write bookkeeping.
    expect(await screen.findByDisplayValue("my idea")).toBeTruthy();
    await waitFor(() => expect(recordCapture).not.toHaveBeenCalled());
  });
});

describe("CaptureScreen — Edit during a multi-await continuation", () => {
  it("Edit landing between the raw write and recordCapture still routes the resubmit to rewriteRawIdea", async () => {
    // recordCapture resolves AFTER the Edit tap: the continuation resumes and
    // would clear editingFilepath, undoing the tap and orphaning a duplicate.
    const record = deferred<void>();
    vi.mocked(recordCapture).mockReturnValueOnce(record.promise);

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(recordCapture).toHaveBeenCalled());

    fireEvent.click(await screen.findByText("Edit"));
    await screen.findByDisplayValue("my idea");
    record.resolve();

    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalled());
    expect(rewriteRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ filepath: "file:///v/Ideas/my-idea.md" }),
      expect.anything(),
    );
    expect(writeRawIdea).toHaveBeenCalledTimes(1);
  });

  it("Edit landing mid-handleCaptureError does not wipe the restored draft or the saved draft file", async () => {
    // handleCaptureError runs with the Edit button still on screen and clears
    // every input once the enqueue lands — including the draft the user just
    // went back to editing, while the un-edited capture stays queued.
    const queued = deferred<void>();
    vi.mocked(enrichJournal).mockRejectedValueOnce(new Error("network down"));
    vi.mocked(enqueue).mockReturnValueOnce(queued.promise);

    renderScreen("journal");
    const input = await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.change(input, { target: { value: "walked the dog" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());

    fireEvent.click(await screen.findByText("Edit"));
    queued.resolve();

    await waitFor(() => expect(screen.getByDisplayValue("walked the dog")).toBeTruthy());
    expect(screen.queryByText("Offline — capture queued.")).toBeNull();
    expect(clearDraftMock).not.toHaveBeenCalled();
  });

  it("Edit landing during persistAttachments writes no note at all, so the resubmit writes exactly one", async () => {
    // The earliest await in the save-first path, upstream of rawWriteRef being
    // published: an unguarded resume here writes note A anyway, and the
    // resubmit then writes note B — two files for one capture.
    const persisted = deferred<never[]>();
    vi.mocked(persistAttachments).mockReturnValueOnce(
      persisted.promise as ReturnType<typeof persistAttachments>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(persistAttachments).toHaveBeenCalled());

    fireEvent.click(await screen.findByText("Edit"));
    persisted.resolve([]);

    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(writeRawIdea).toHaveBeenCalled());
    // Nothing reached disk before the Edit, so this is a fresh capture — one
    // write total, and no rewrite of a file that was never created.
    expect(writeRawIdea).toHaveBeenCalledTimes(1);
    expect(writeRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ text: "my edited idea" }),
      expect.anything(),
      expect.anything(),
    );
    expect(rewriteRawIdea).not.toHaveBeenCalled();
  });

  it("double-tapping Edit runs the handler once, so a stale copy can't revert a newer submit", async () => {
    // Both taps land while the raw write is still in flight, so without an
    // in-flight guard BOTH continue past their awaits: two mtime-bump rewrites,
    // and the second handler's trailing setPhase("input") can fire after the
    // resubmit the first one enabled — quietly dropping a capture out of its
    // in-flight state.
    const write = deferred<{
      filepath: string;
      slug: string;
      mtime: number;
      markdown: string;
    }>();
    vi.mocked(writeRawIdea).mockReturnValueOnce(
      write.promise as ReturnType<typeof writeRawIdea>,
    );
    const enrich = deferred<{ kind: "updated"; markdown: string }>();
    vi.mocked(enrichIdeaInPlace).mockReturnValue(
      enrich.promise as ReturnType<typeof enrichIdeaInPlace>,
    );

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));

    const editButton = await screen.findByText("Edit");
    fireEvent.click(editButton);
    fireEvent.click(editButton);

    write.resolve({
      filepath: "file:///v/Ideas/my-idea.md",
      slug: "my-idea",
      mtime: 111,
      markdown: "---\nstatus: pending-enrich\n---\nmy idea\n",
    });

    const reopened = await screen.findByDisplayValue("my idea");
    await waitFor(() => expect(rewriteRawIdea).toHaveBeenCalledTimes(1));

    // The resubmit owns the screen from here; no stale Edit may pull it back.
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText(/structuring the note/)).toBeTruthy());
    await Promise.resolve();
    expect(screen.getByText(/structuring the note/)).toBeTruthy();
  });

  it("a resumed submit waits for the interrupted recordCapture before rewriting history", async () => {
    // recordCapture and removeFromHistoryByFilepath are both read-modify-write
    // cycles over one AsyncStorage array. Interleaved, one side's write is lost:
    // either a duplicate row or the stale-titled one resurrected.
    const record = deferred<void>();
    vi.mocked(recordCapture).mockReturnValueOnce(record.promise);

    renderScreen();
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "my idea" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(recordCapture).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByText("Edit"));
    const reopened = await screen.findByDisplayValue("my idea");
    fireEvent.change(reopened, { target: { value: "my edited idea" } });
    fireEvent.click(screen.getByText("Send"));

    // The resubmit has already rewritten the note on disk, so it is past the
    // point where the unguarded version reached the history.
    await waitFor(() =>
      expect(rewriteRawIdea).toHaveBeenCalledWith(
        expect.objectContaining({ text: "my edited idea" }),
        expect.anything(),
      ),
    );
    expect(removeFromHistoryByFilepath).not.toHaveBeenCalled();

    record.resolve();
    await waitFor(() =>
      expect(removeFromHistoryByFilepath).toHaveBeenCalledWith("file:///v/Ideas/my-idea.md", "default"),
    );
    await waitFor(() => expect(recordCapture).toHaveBeenCalledTimes(2));
  });
});

describe("CaptureScreen (journal) — places", () => {
  // vi.clearAllMocks() keeps implementations, so a mockResolvedValue set here
  // would outlive the test — put the module default back explicitly.
  afterEach(() => {
    vi.mocked(getSettings).mockResolvedValue({
      previewBeforeSave: false,
    } as unknown as Awaited<ReturnType<typeof getSettings>>);
  });

  /** Type a place name into the meta sheet's Places field and press Add. */
  async function addPlace(name: string, lat: number, lon: number): Promise<void> {
    vi.mocked(resolvePlaceName).mockResolvedValueOnce({
      kind: "ok",
      place: name,
      coords: { lat, lon },
    });
    fireEvent.change(screen.getByPlaceholderText("Rud-Alpe, or https://maps.app.goo.gl/…"), {
      target: { value: name },
    });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(screen.getByText(name)).toBeTruthy());
  }

  it("shows the Places field for Journal captures only", async () => {
    renderScreen("journal");
    await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.click(screen.getByLabelText("Add tags, location, or attachments"));
    expect(await screen.findByText("Tags & details")).toBeTruthy();
    expect(screen.getByPlaceholderText("Rud-Alpe, or https://maps.app.goo.gl/…")).toBeTruthy();
  });

  it("shows no Places field for Idea captures", async () => {
    renderScreen("idea");
    await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.click(screen.getByLabelText("Add tags, location, or attachments"));
    expect(await screen.findByText("Tags & details")).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("Rud-Alpe, or https://maps.app.goo.gl/…"),
    ).toBeNull();
  });

  it("writes both added places into the saved journal entry body", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      previewBeforeSave: true,
    } as unknown as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(enrichJournal).mockResolvedValue({
      markdown: "# Travel day\n\nThree stops.\n",
      model: "test-model",
    } as unknown as Awaited<ReturnType<typeof enrichJournal>>);
    vi.mocked(appendJournal).mockResolvedValue({
      filepath: "file:///v/Journal/2026-08-11.md",
      markdown: "<day-file>",
    } as unknown as Awaited<ReturnType<typeof appendJournal>>);

    renderScreen("journal");
    const transcript = await screen.findByPlaceholderText("Transcript — speak or type");
    fireEvent.change(transcript, { target: { value: "three stops today" } });

    fireEvent.click(screen.getByLabelText("Add tags, location, or attachments"));
    await screen.findByText("Tags & details");
    await addPlace("Rud-Alpe", 47.2011, 10.1166);
    await addPlace("Lech", 47.2063, 10.1435);
    fireEvent.click(screen.getByText("Done"));

    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(appendJournal).toHaveBeenCalled());
    const body = vi.mocked(appendJournal).mock.calls[0][1];
    expect(body).toContain("## Places");
    expect(body).toContain("[Rud-Alpe](geo:47.2011,10.1166)");
    expect(body).toContain("[Lech](geo:47.2063,10.1435)");
  });
});
