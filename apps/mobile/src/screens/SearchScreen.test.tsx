// @vitest-environment jsdom
//
// Screen smoke test for the browse-mode omnibox (pattern: see
// TagBrowserScreen.test.tsx). searchNotes is faked query-agnostic — the
// filtering behavior under test here is the SCREEN's own wiring: the
// collapsible filter pills, active-filter dismiss stamps, tag-param
// seeding, and AND-narrowing by tag.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { NoteIndexEntry } from "../lib/vault";

vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(cb, [cb]);
    },
  };
});

const NOTES: NoteIndexEntry[] = [
  {
    uri: "file:///v/Ideas/first.md",
    subdir: "Ideas",
    title: "First idea",
    createdOrDate: 1_700_000_000_000,
    tags: ["qa-test"],
    mode: "idea",
    excerpt: "the first excerpt",
    status: "pending-enrich",
  },
  {
    uri: "file:///v/Journal/2026-07-08.md",
    subdir: "Journal",
    title: "A journal day",
    createdOrDate: 1_700_000_100_000,
    tags: ["sports"],
    mode: "journal",
    excerpt: "went to the game",
  },
];

vi.mock("../lib/vault", () => ({
  getNoteIndex: vi.fn(async () => ({ builtAt: 1, notes: NOTES })),
  refreshNoteIndex: vi.fn(async () => ({ builtAt: 2, notes: NOTES })),
  // Query-agnostic fake: returns every note. The screen's own tag-filter
  // narrowing runs on top of this and is what the assertions exercise.
  searchNotes: vi.fn((index: { notes: NoteIndexEntry[] }) => index.notes),
  searchNoteBodies: vi.fn(),
  resolveNoteEntry: vi.fn(async (uri: string) => ({
    id: "resolved-1",
    mode: "idea",
    title: "First idea",
    filepath: uri,
    createdAt: 1_700_000_000_000,
  })),
}));

// The explainer's own gating logic (remote-vs-local provider, the
// AsyncStorage-backed "seen" flag) is unit-tested in askExplainer.test.ts.
// Here it's a plain mock so the screen's wiring — show dialog vs. navigate
// straight through, persist "don't show again", never navigate on Cancel —
// is what's under test, independent of settings/provider plumbing.
vi.mock("../lib/askExplainer", () => ({
  shouldShowAskExplainer: vi.fn(async () => false),
  markAskExplainerSeen: vi.fn(async () => undefined),
}));

import SearchScreen from "./SearchScreen";
import { resolveNoteEntry, searchNoteBodies, getNoteIndex } from "../lib/vault";
import { shouldShowAskExplainer, markAskExplainerSeen } from "../lib/askExplainer";

type ScreenProps = Parameters<typeof SearchScreen>[0];

function makeNavigation() {
  return {
    setOptions: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
  };
}

function renderScreen(params?: { tag?: string }) {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <SearchScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={{ key: "s", name: "Search", params } as ScreenProps["route"]}
      />
    </PaperProvider>,
  );
  return { navigation };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("SearchScreen", () => {
  it("browses the vault as cards on an empty query, with tag + pending stamps", async () => {
    renderScreen();
    expect(await screen.findByText("First idea")).toBeTruthy();
    expect(screen.getByText("A journal day")).toBeTruthy();
    expect(screen.getByText("the first excerpt")).toBeTruthy();
    // Stamps from the shared NoteCard grammar.
    expect(screen.getByText("#qa-test")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    // Filters are NOT docked — no pill row until the filter icon is tapped.
    expect(screen.queryByLabelText("Filter by tag qa-test")).toBeNull();
  });

  it("expands filter pills, narrows by tag, and dismisses via the active stamp", async () => {
    renderScreen();
    await screen.findByText("First idea");

    fireEvent.click(screen.getByLabelText("Show filters"));
    fireEvent.click(await screen.findByLabelText("Filter by tag qa-test"));

    // Row collapsed, results narrowed, dismiss stamp shown.
    await waitFor(() => expect(screen.queryByText("A journal day")).toBeNull());
    expect(screen.getByText("First idea")).toBeTruthy();
    const dismiss = screen.getByLabelText("Remove tag filter qa-test");

    fireEvent.click(dismiss);
    expect(await screen.findByText("A journal day")).toBeTruthy();
  });

  it("pre-applies a tag filter arriving via the route param", async () => {
    renderScreen({ tag: "sports" });
    expect(await screen.findByText("A journal day")).toBeTruthy();
    expect(screen.queryByText("First idea")).toBeNull();
    expect(screen.getByLabelText("Remove tag filter sports")).toBeTruthy();
  });

  it("opens a result via entry resolution", async () => {
    const { navigation } = renderScreen();
    fireEvent.click(await screen.findByText("First idea"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("RecentDetail", {
        entry: expect.objectContaining({ filepath: "file:///v/Ideas/first.md" }),
      }),
    );
    expect(resolveNoteEntry).toHaveBeenCalledWith("file:///v/Ideas/first.md");
  });
});

describe("body search", () => {
  it("shows the 'Search note contents' button only once a query is typed", async () => {
    renderScreen();
    await screen.findByText("First idea");
    expect(screen.queryByText("Search note contents")).toBeNull();

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
  });

  it("streams body matches as they resolve and shows a progress line", async () => {
    let onMatchCb!: (m: { uri: string; snippet: string }) => void;
    let onProgressCb!: (p: { scanned: number; total: number }) => void;
    vi.mocked(searchNoteBodies).mockImplementation(
      (_query, onMatch, onProgress, _signal) =>
        new Promise((resolve) => {
          onMatchCb = onMatch;
          onProgressCb = onProgress;
          // Deliberately never auto-resolves — the test drives it manually.
          void resolve;
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));

    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalled());

    onProgressCb({ scanned: 1, total: 2 });
    onMatchCb({ uri: "file:///v/Journal/2026-07-08.md", snippet: "…matched text…" });

    await waitFor(() => expect(screen.getByText(/1 of 2 notes/)).toBeTruthy());
    expect(screen.getByText("…matched text…")).toBeTruthy();
  });

  it("cancels the in-flight scan when the query changes", async () => {
    const abortSpy = vi.fn();
    vi.mocked(searchNoteBodies).mockImplementation(
      (_query, _onMatch, _onProgress, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", abortSpy);
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));

    fireEvent.change(input, { target: { value: "hello world" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(abortSpy).toHaveBeenCalled();
  });

  it("ignores a superseded scan's callbacks after a new scan has started", async () => {
    let onMatchA!: (m: { uri: string; snippet: string }) => void;
    let onProgressA!: (p: { scanned: number; total: number }) => void;
    let onMatchB!: (m: { uri: string; snippet: string }) => void;
    let onProgressB!: (p: { scanned: number; total: number }) => void;

    // Scan A: captures its callbacks and never resolves on its own — the
    // test fires them manually, including AFTER scan B has started.
    vi.mocked(searchNoteBodies).mockImplementationOnce(
      (_query, onMatch, onProgress, _signal) =>
        new Promise(() => {
          onMatchA = onMatch;
          onProgressA = onProgress;
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));

    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalledTimes(1));

    // Scan A delivers a match before it gets superseded.
    onProgressA({ scanned: 1, total: 5 });
    onMatchA({ uri: "file:///v/Journal/2026-07-08.md", snippet: "STALE_A_MATCH" });
    await waitFor(() => expect(screen.getByText(/1 of 5 notes/)).toBeTruthy());
    expect(screen.getByText("STALE_A_MATCH")).toBeTruthy();

    // Editing the query aborts scan A and resets the visible state.
    fireEvent.change(input, { target: { value: "hello world" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(screen.queryByText("STALE_A_MATCH")).toBeNull());

    // Scan B: a fresh search on the new query, captured separately.
    vi.mocked(searchNoteBodies).mockImplementationOnce(
      (_query, onMatch, onProgress, _signal) =>
        new Promise(() => {
          onMatchB = onMatch;
          onProgressB = onProgress;
        }),
    );

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));
    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalledTimes(2));

    onProgressB({ scanned: 1, total: 3 });
    onMatchB({ uri: "file:///v/Ideas/first.md", snippet: "FRESH_B_MATCH" });
    await waitFor(() => expect(screen.getByText(/1 of 3 notes/)).toBeTruthy());
    expect(screen.getByText("FRESH_B_MATCH")).toBeTruthy();

    // Scan A's stale callbacks fire late, after B is already the live scan.
    // Wrapped in act() so any (buggy, unguarded) state update is flushed
    // synchronously before the assertions below run — otherwise the
    // assertions could pass by accident just because React hadn't
    // re-rendered yet, regardless of whether the guard exists.
    act(() => {
      onProgressA({ scanned: 5, total: 5 });
      onMatchA({ uri: "file:///v/Journal/2026-07-08.md", snippet: "STALE_A_LATE_MATCH" });
    });

    // The stale delivery must not clobber B's progress or inject A's match.
    expect(screen.getByText(/1 of 3 notes/)).toBeTruthy();
    expect(screen.queryByText(/5 of 5 notes/)).toBeNull();
    expect(screen.queryByText("STALE_A_LATE_MATCH")).toBeNull();
    expect(screen.getByText("FRESH_B_MATCH")).toBeTruthy();
  });

  it("does not clobber idle state with a stale scan's late resolution after an implicit query-change cancel (no second scan started)", async () => {
    let onMatchA!: (m: { uri: string; snippet: string }) => void;
    let onProgressA!: (p: { scanned: number; total: number }) => void;
    let resolveA!: (finalProgress: { scanned: number; total: number }) => void;

    // Scan A: captures its callbacks and its own resolver — the test
    // decides exactly when the promise settles, simulating an in-flight
    // read that finishes AFTER abort() was called (abort doesn't cancel
    // already-issued reads — that's documented behavior).
    vi.mocked(searchNoteBodies).mockImplementationOnce(
      (_query, onMatch, onProgress, _signal) =>
        new Promise((resolve) => {
          onMatchA = onMatch;
          onProgressA = onProgress;
          resolveA = resolve;
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));
    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalledTimes(1));

    onProgressA({ scanned: 1, total: 5 });
    onMatchA({ uri: "file:///v/Journal/2026-07-08.md", snippet: "STALE_MATCH" });
    await waitFor(() => expect(screen.getByText(/1 of 5 notes/)).toBeTruthy());

    // Edit the query — implicit cancel via the [query] effect's cleanup.
    // No second scan is started.
    fireEvent.change(input, { target: { value: "hello world" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    // The new query is idle immediately — the button is back, stale match gone.
    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    expect(screen.queryByText("STALE_MATCH")).toBeNull();

    // Scan A's promise finally settles late, well after the abort. Uses an
    // async act() and an explicit microtask flush — resolveA() only queues
    // the .then() callback as a microtask, and a plain sync act() would
    // return (and let the assertions below run) before that microtask has
    // actually executed, making the assertions pass vacuously regardless of
    // whether the guard/nulling fix is present.
    await act(async () => {
      resolveA({ scanned: 5, total: 5 });
      await Promise.resolve();
    });

    // Must still be idle for the new query — no "Cancelled" leak, button intact.
    expect(screen.getByText("Search note contents")).toBeTruthy();
    expect(screen.queryByText(/Cancelled/)).toBeNull();
    expect(screen.queryByText("STALE_MATCH")).toBeNull();
  });

  it("caps rendered body matches at 50, with an overflow indicator for the rest", async () => {
    let onMatchCb!: (m: { uri: string; snippet: string }) => void;
    vi.mocked(searchNoteBodies).mockImplementation(
      (_query, onMatch, _onProgress, _signal) =>
        new Promise((resolve) => {
          onMatchCb = onMatch;
          void resolve;
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));
    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalled());

    act(() => {
      for (let i = 0; i < 55; i += 1) {
        onMatchCb({ uri: `file:///v/Ideas/match-${i}.md`, snippet: `SNIPPET_${i}` });
      }
    });

    // The 50th match (index 49) renders; the 51st (index 50) does not.
    await waitFor(() => expect(screen.getByText("SNIPPET_49")).toBeTruthy());
    expect(screen.queryByText("SNIPPET_50")).toBeNull();
    expect(
      screen.getByText("+5 more matches — try a more specific search"),
    ).toBeTruthy();
  });

  it("shows an error state (not a stuck spinner) and offers a retry when the scan promise rejects", async () => {
    let rejectA!: (err: Error) => void;
    vi.mocked(searchNoteBodies).mockImplementationOnce(
      (_query, _onMatch, _onProgress, _signal) =>
        new Promise((_resolve, reject) => {
          rejectA = reject;
        }),
    );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));
    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Scanning/)).toBeTruthy();

    await act(async () => {
      rejectA(new Error("SAF permission denied"));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText(/Search failed/)).toBeTruthy());
    expect(screen.queryByText(/Scanning/)).toBeNull();
    expect(screen.getByLabelText("Retry note content search")).toBeTruthy();
  });

  it("recovers from an error state via Retry, starting a fresh successful scan", async () => {
    let firstReject!: (e: Error) => void;
    let secondResolve!: (r: { scanned: number; total: number }) => void;
    vi.mocked(searchNoteBodies)
      .mockImplementationOnce(
        (_query, _onMatch, _onProgress, _signal) =>
          new Promise((_resolve, reject) => {
            firstReject = reject;
          }),
      )
      .mockImplementationOnce(
        (_query, _onMatch, _onProgress, _signal) =>
          new Promise((resolve) => {
            secondResolve = resolve;
          }),
      );

    renderScreen();
    await screen.findByText("First idea");

    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));
    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalledTimes(1));

    await act(async () => {
      firstReject(new Error("boom"));
      await Promise.resolve();
    });
    expect(screen.getByText(/Search failed/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Retry note content search"));
    await waitFor(() => expect(searchNoteBodies).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Scanning…/)).toBeTruthy();

    await act(async () => {
      secondResolve({ scanned: 1, total: 1 });
      await Promise.resolve();
    });
    expect(screen.getByText("Scanned 1 notes")).toBeTruthy();
  });
});

describe("ask entry point", () => {
  async function typeQuery(value: string) {
    const input = screen.getByPlaceholderText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("labels the ask button with the number that will actually be sent", async () => {
    const many: NoteIndexEntry[] = Array.from({ length: 50 }, (_, i) => ({
      uri: `file:///v/Ideas/note-${i}.md`,
      subdir: "Ideas",
      title: `Note ${i}`,
      createdOrDate: 1_700_000_000_000 + i,
      tags: [],
      mode: "idea",
      excerpt: "",
    }));
    vi.mocked(getNoteIndex).mockResolvedValueOnce({ builtAt: 1, notes: many });

    renderScreen();
    await screen.findByText("Note 0");
    await typeQuery("hello");

    await waitFor(() => expect(screen.getByText("Ask about these 12 notes")).toBeTruthy());
  });

  it("hides the ask button when there are no results", async () => {
    vi.mocked(getNoteIndex).mockResolvedValueOnce({ builtAt: 1, notes: [] });

    renderScreen();
    await waitFor(() =>
      expect(screen.getByText("No notes yet — capture something first.")).toBeTruthy(),
    );
    await typeQuery("hello");

    await waitFor(() =>
      expect(screen.getByText("Nothing matches — try fewer filters or different words.")).toBeTruthy(),
    );
    expect(screen.queryByText(/^Ask about these/)).toBeNull();
  });

  it("hides the ask button on an empty query even with results present", async () => {
    renderScreen();
    await screen.findByText("First idea");
    expect(screen.queryByText(/^Ask about these/)).toBeNull();
  });

  it("navigates straight to Ask when the explainer isn't needed", async () => {
    vi.mocked(shouldShowAskExplainer).mockResolvedValueOnce(false);
    const { navigation } = renderScreen();
    await screen.findByText("First idea");
    await typeQuery("hello");

    await waitFor(() => expect(screen.getByText("Ask about these 2 notes")).toBeTruthy());
    fireEvent.click(screen.getByText("Ask about these 2 notes"));

    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith(
        "Ask",
        expect.objectContaining({ question: "hello" }),
      ),
    );
  });

  it("builds candidates with body matches (resolved titles) first, then indexed results", async () => {
    vi.mocked(shouldShowAskExplainer).mockResolvedValueOnce(false);
    vi.mocked(searchNoteBodies).mockImplementation((_query, onMatch, _onProgress, _signal) => {
      onMatch({ uri: "file:///v/Journal/2026-07-08.md", snippet: "…matched…" });
      return Promise.resolve({ scanned: 1, total: 1 });
    });

    const { navigation } = renderScreen();
    await screen.findByText("First idea");
    await typeQuery("hello");

    await waitFor(() => expect(screen.getByText("Search note contents")).toBeTruthy());
    fireEvent.click(screen.getByText("Search note contents"));
    await waitFor(() => expect(screen.getByText("…matched…")).toBeTruthy());

    await waitFor(() => expect(screen.getByText("Ask about these 3 notes")).toBeTruthy());
    fireEvent.click(screen.getByText("Ask about these 3 notes"));

    await waitFor(() => expect(navigation.navigate).toHaveBeenCalled());
    const call = vi.mocked(navigation.navigate).mock.calls[0];
    expect(call[1]).toEqual(
      expect.objectContaining({
        candidates: [
          { uri: "file:///v/Journal/2026-07-08.md", title: "A journal day", fromBodyMatch: true },
          { uri: "file:///v/Ideas/first.md", title: "First idea", fromBodyMatch: false },
          {
            uri: "file:///v/Journal/2026-07-08.md",
            title: "A journal day",
            fromBodyMatch: false,
          },
        ],
      }),
    );
  });

  it("shows the one-time explainer before a remote ask, and persists don't-show-again on Continue", async () => {
    vi.mocked(shouldShowAskExplainer).mockResolvedValueOnce(true);
    const { navigation } = renderScreen();
    await screen.findByText("First idea");
    await typeQuery("hello");

    await waitFor(() => expect(screen.getByText("Ask about these 2 notes")).toBeTruthy());
    fireEvent.click(screen.getByText("Ask about these 2 notes"));

    await screen.findByText("Sending notes to your provider");
    expect(navigation.navigate).not.toHaveBeenCalledWith("Ask", expect.anything());

    fireEvent.click(screen.getByText("Don't show again"));
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => expect(markAskExplainerSeen).toHaveBeenCalled());
    expect(navigation.navigate).toHaveBeenCalledWith(
      "Ask",
      expect.objectContaining({ question: "hello" }),
    );
  });

  it("cancelling the explainer does not navigate or persist don't-show-again", async () => {
    vi.mocked(shouldShowAskExplainer).mockResolvedValueOnce(true);
    const { navigation } = renderScreen();
    await screen.findByText("First idea");
    await typeQuery("hello");

    await waitFor(() => expect(screen.getByText("Ask about these 2 notes")).toBeTruthy());
    fireEvent.click(screen.getByText("Ask about these 2 notes"));

    await screen.findByText("Sending notes to your provider");
    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() =>
      expect(screen.queryByText("Sending notes to your provider")).toBeNull(),
    );
    expect(navigation.navigate).not.toHaveBeenCalledWith("Ask", expect.anything());
    expect(markAskExplainerSeen).not.toHaveBeenCalled();
  });

  it("fails toward showing the explainer, and surfaces an error, when shouldShowAskExplainer rejects", async () => {
    vi.mocked(shouldShowAskExplainer).mockRejectedValueOnce(new Error("storage unavailable"));
    const { navigation } = renderScreen();
    await screen.findByText("First idea");
    await typeQuery("hello");

    await waitFor(() => expect(screen.getByText("Ask about these 2 notes")).toBeTruthy());
    fireEvent.click(screen.getByText("Ask about these 2 notes"));

    // A rejection must not read as "nothing happened": the dialog still
    // appears (fail toward disclosure, never toward silently skipping it)
    // AND the failure itself is visible, not swallowed by the `void` at the
    // call site.
    await screen.findByText("Sending notes to your provider");
    expect(screen.getByText(/storage unavailable/)).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalledWith("Ask", expect.anything());
  });
});
