// @vitest-environment jsdom
//
// Screen smoke test (pattern: see TagBrowserScreen.test.tsx). getAllTodos is
// kept REAL (via importOriginal) so the aggregation/sort/filter behavior
// under test is genuine, not a stand-in; only the storage/IO-touching vault
// functions (getNoteIndex, refreshNoteIndex, resolveNoteEntry,
// upsertNoteInIndex) and writer functions (readNote, updateChecklistItem)
// are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight, carnetDark } from "../lib/theme";
import type { NoteIndex } from "../lib/vault";
import type { CaptureEntry } from "../lib/storage";

vi.mock("../lib/vaultRefreshService", () => ({ refreshActiveVault: vi.fn(async () => {}) }));
vi.mock("../lib/settings", () => ({ getSettings: vi.fn(async () => ({ captureFolderPath: "" })) }));
vi.mock("../lib/vaultRoot", () => ({
  resolveContextRoot: vi.fn(() => ({ uri: "file:///vault", fs: {} })),
}));

const focus = vi.hoisted(() => ({ focused: true, listeners: new Set<() => void>() }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect, useSyncExternalStore } = await import("react");
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      const focused = useSyncExternalStore((listener) => {
        focus.listeners.add(listener);
        return () => { focus.listeners.delete(listener); };
      }, () => focus.focused);
      useEffect(() => focused ? cb() : undefined, [cb, focused]);
    },
  };
});
function setFocused(value: boolean) {
  act(() => { focus.focused = value; focus.listeners.forEach((listener) => listener()); });
}
const preferences = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(async () => {}) }));
vi.mock("../lib/todoViewPreferences", () => ({
  getTodoViewPreferences: preferences.get, setTodoViewPreferences: preferences.set,
}));
import { defaultTodoViewPreferences } from "../lib/todoView";

const SEEDED_INDEX: NoteIndex = {
  builtAt: 1,
  notes: [
    {
      uri: "file:///v/Ideas/a.md",
      subdir: "Ideas",
      title: "Note A",
      createdOrDate: 200,
      tags: [],
      mode: "idea",
      excerpt: "",
      todos: [
        { text: "Buy milk", checked: false },
        { text: "Call mom", checked: true },
      ],
    },
    {
      uri: "file:///v/Journal/b.md",
      subdir: "Journal",
      title: "Note B",
      createdOrDate: 100,
      tags: [],
      mode: "journal",
      excerpt: "",
      todos: [{ text: "Write report", checked: false }],
    },
  ],
};

const getNoteIndex = vi.fn(async () => SEEDED_INDEX);
const refreshNoteIndex = vi.fn(async () => SEEDED_INDEX);
const resolveNoteEntry = vi.fn<() => Promise<CaptureEntry | null>>(async () => null);
const upsertNoteInIndex = vi.fn(async () => undefined);

vi.mock("../lib/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/vault")>();
  return {
    ...actual,
    getNoteIndex: (...args: Parameters<typeof getNoteIndex>) => getNoteIndex(...args),
    refreshNoteIndex: (...args: Parameters<typeof refreshNoteIndex>) => refreshNoteIndex(...args),
    resolveNoteEntry: (...args: Parameters<typeof resolveNoteEntry>) => resolveNoteEntry(...args),
    upsertNoteInIndex: (...args: Parameters<typeof upsertNoteInIndex>) =>
      upsertNoteInIndex(...args),
  };
});

const readNote = vi.fn(async () => "# Note A\n\n- [ ] Buy milk\n- [x] Call mom\n");
const updateChecklistItem = vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string });

vi.mock("../lib/writer", () => ({
  readNote: (...args: Parameters<typeof readNote>) => readNote(...args),
  updateChecklistItem: (...args: Parameters<typeof updateChecklistItem>) =>
    updateChecklistItem(...args),
}));

import TodosScreen, { flipInIndex } from "./TodosScreen";
import type { AggregatedTodo } from "../lib/vault";
import { getSettings } from "../lib/settings";

type ScreenProps = Parameters<typeof TodosScreen>[0];

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

function renderScreen(theme = carnetLight) {
  const navigation = makeNavigation();
  const rendered = render(
    <PaperProvider theme={theme}>
      <TodosScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={{ key: "t", name: "Todos", params: undefined } as ScreenProps["route"]}
      />
    </PaperProvider>,
  );
  return { navigation, ...rendered };
}

async function waitForViewReady() {
  const assertReady = () => {
    expect(screen.getByLabelText("Search todos").getAttribute("readonly")).toBeNull();
    expect(screen.getByRole("button", { name: "All" }).hasAttribute("disabled")).toBe(false);
  };
  await waitFor(assertReady);
  // React Native Web updates its press handlers in a passive effect after
  // hydration renders the enabled controls. Flush that effect before pressing.
  await act(async () => {});
  assertReady();
}

beforeEach(() => {
  vi.clearAllMocks();
  focus.focused = true;
  preferences.get.mockResolvedValue(defaultTodoViewPreferences());
  preferences.set.mockResolvedValue(undefined);
  vi.mocked(getSettings).mockResolvedValue({ captureFolderPath: "" } as Awaited<ReturnType<typeof getSettings>>);
  getNoteIndex.mockResolvedValue(SEEDED_INDEX);
  refreshNoteIndex.mockResolvedValue(SEEDED_INDEX);
  resolveNoteEntry.mockResolvedValue(null);
  upsertNoteInIndex.mockResolvedValue(undefined);
  readNote.mockResolvedValue("# Note A\n\n- [ ] Buy milk\n- [x] Call mom\n");
  updateChecklistItem.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("TodosScreen", () => {
  it("renders open todos from a seeded index, newest-note-first, default filter hides checked", async () => {
    renderScreen();
    expect(await screen.findByText("Buy milk")).toBeTruthy();
    expect(screen.getByText("Note A")).toBeTruthy();
    expect(screen.getByText("Write report")).toBeTruthy();
    // "Call mom" is checked — hidden under the default "open" filter.
    expect(screen.queryByText("Call mom")).toBeNull();
  });

  it("toggling a checkbox calls updateChecklistItem with (uri, text, expectedChecked)", async () => {
    renderScreen();
    await screen.findByText("Buy milk");
    const checkbox = screen.getByLabelText("Mark as done: Buy milk");
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(updateChecklistItem).toHaveBeenCalledWith("file:///v/Ideas/a.md", "Buy milk", false),
    );
    await waitFor(() =>
      expect(upsertNoteInIndex).toHaveBeenCalledWith(
        "file:///v/Ideas/a.md",
        expect.any(String),
        "default",
      ),
    );
  });

  it("uses the profile captured when the toggle began for its cache repair", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      captureFolderPath: "file:///work",
      vaultProfiles: [{ id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 }],
      activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    renderScreen();
    fireEvent.click(await screen.findByLabelText("Mark as done: Buy milk"));

    await waitFor(() =>
      expect(upsertNoteInIndex).toHaveBeenCalledWith(
        "file:///v/Ideas/a.md",
        expect.any(String),
        "work",
      ),
    );
  });

  it("does not navigate an old todo after its vault context is cleared during entry lookup", async () => {
    let release: ((value: CaptureEntry | null) => void) | undefined;
    resolveNoteEntry.mockImplementationOnce(() => new Promise<CaptureEntry | null>((resolve) => {
      release = resolve;
    }));
    const { navigation, unmount } = renderScreen();
    fireEvent.click(await screen.findByLabelText("Open note Note A"));

    // Simulate leaving/refocusing under another profile while SAF is still
    // resolving the old URI. Focus cleanup clears the paired context ref.
    unmount();
    release?.({
      id: "a", mode: "idea", title: "Note A",
      filepath: "file:///v/Ideas/a.md", createdAt: 200,
    });
    await Promise.resolve();

    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("reverts the optimistic flip and shows the Snackbar on an ambiguous result", async () => {
    updateChecklistItem.mockResolvedValueOnce({ ok: false, reason: "ambiguous" });
    renderScreen();
    await screen.findByText("Buy milk");
    const checkbox = screen.getByLabelText("Mark as done: Buy milk");
    fireEvent.click(checkbox);

    expect(
      await screen.findByText(
        "Can't tell which item — edit the text in the note to make it unique.",
      ),
    ).toBeTruthy();
    // Reverted: back to unchecked, so the "mark as done" label is present again.
    await waitFor(() =>
      expect(screen.getByLabelText("Mark as done: Buy milk")).toBeTruthy(),
    );
    expect(upsertNoteInIndex).not.toHaveBeenCalled();
  });

  it("reverts and shows a different message on a not_found result", async () => {
    updateChecklistItem.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    renderScreen();
    await screen.findByText("Buy milk");
    fireEvent.click(screen.getByLabelText("Mark as done: Buy milk"));

    expect(
      await screen.findByText("That item changed — pull to refresh and try again."),
    ).toBeTruthy();
  });

  it("reverts the optimistic flip and shows an error Snackbar when updateChecklistItem throws", async () => {
    updateChecklistItem.mockRejectedValueOnce(new Error("SAF permission revoked"));
    renderScreen();
    await screen.findByText("Buy milk");
    const checkbox = screen.getByLabelText("Mark as done: Buy milk");
    fireEvent.click(checkbox);

    expect(
      await screen.findByText("Couldn't update that item: SAF permission revoked"),
    ).toBeTruthy();
    // Reverted: back to unchecked, so the "mark as done" label is present again.
    await waitFor(() =>
      expect(screen.getByLabelText("Mark as done: Buy milk")).toBeTruthy(),
    );
    expect(upsertNoteInIndex).not.toHaveBeenCalled();
  });

  it("toggling one of two identical-text checklist items in the same note flips only the tapped one", async () => {
    const dupIndex: NoteIndex = {
      builtAt: 1,
      notes: [
        {
          uri: "file:///v/Ideas/dup.md",
          subdir: "Ideas",
          title: "Dup Note",
          createdOrDate: 300,
          tags: [],
          mode: "idea",
          excerpt: "",
          todos: [
            { text: "Water plants", checked: false },
            { text: "Water plants", checked: false },
          ],
        },
      ],
    };
    getNoteIndex.mockResolvedValue(dupIndex);
    preferences.get.mockResolvedValue({ ...defaultTodoViewPreferences(), groupBySource: true, sort: "oldest" });
    // A real successful write for ONE specific line — this is the case the
    // old text-only matching got wrong: it had no way to tell the two rows
    // apart, so a successful write to one line flipped BOTH in the local
    // cache until the next refocus.
    updateChecklistItem.mockResolvedValueOnce({ ok: true });
    renderScreen();

    // "All" filter, not the default "open" — a successfully-checked row must
    // stay visible after the toggle for this assertion to see both rows.
    await screen.findAllByLabelText("Mark as done: Water plants");
    fireEvent.click(screen.getByText("All"));

    const before = await screen.findAllByLabelText("Mark as done: Water plants");
    expect(before).toHaveLength(2);
    fireEvent.click(before[0]);

    await waitFor(() => expect(updateChecklistItem).toHaveBeenCalled());
    // Exactly one row flipped: one "done" checkbox remains, one is now "not done".
    await waitFor(() => {
      expect(screen.getAllByLabelText("Mark as done: Water plants")).toHaveLength(1);
      expect(screen.getAllByLabelText("Mark as not done: Water plants")).toHaveLength(1);
    });
  });

  it("the open/all filter changes what's rendered", async () => {
    renderScreen();
    await screen.findByText("Buy milk");
    await waitForViewReady();
    expect(screen.queryByText("Call mom")).toBeNull();

    fireEvent.click(screen.getByText("All"));

    expect(await screen.findByText("Call mom")).toBeTruthy();
  });
  it("composes search, completed status, mode and tags without Markdown IO", async () => {
    getNoteIndex.mockResolvedValue({ ...SEEDED_INDEX, notes: SEEDED_INDEX.notes.map((note) => ({ ...note, tags: ["home"] })) });
    renderScreen();
    await screen.findByText("Buy milk");
    await waitForViewReady();
    fireEvent.click(screen.getByText("Completed"));
    fireEvent.change(screen.getByLabelText("Search todos"), { target: { value: "Note A" } });
    fireEvent.click(screen.getByLabelText("View options"));
    fireEvent.click(screen.getByLabelText("Mode: idea"));
    fireEvent.click(screen.getByLabelText("Tag: home"));
    expect(screen.getByText("Call mom")).toBeTruthy();
    expect(screen.queryByText("Write report")).toBeNull();
    expect(screen.getByLabelText("Mode: journal")).toBeTruthy();
    expect(readNote).not.toHaveBeenCalled();
    expect(updateChecklistItem).not.toHaveBeenCalled();
    expect(preferences.set).toHaveBeenLastCalledWith(expect.objectContaining({ profileId: "default" }), expect.objectContaining({ query: "Note A", status: "completed", modes: ["idea"], tags: ["home"] }));
  });

  it("disables edits until hydration and does not save initial defaults", async () => {
    let release!: (value: ReturnType<typeof defaultTodoViewPreferences>) => void;
    preferences.get.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    renderScreen();
    await screen.findByText("Buy milk");
    expect(screen.getByLabelText("Search todos").getAttribute("readonly")).not.toBeNull();
    fireEvent.click(screen.getByText("All"));
    expect(preferences.set).not.toHaveBeenCalled();
    await act(async () => release({ ...defaultTodoViewPreferences(), status: "completed" }));
    expect(screen.getByText("Call mom")).toBeTruthy();
    expect(screen.queryByText("Buy milk")).toBeNull();
    expect(preferences.set).not.toHaveBeenCalled();
  });

  it.each(["root", "profile"] as const)("ignores old index and preference hydration after blur and %s replacement", async (replacement) => {
    let releaseIndex!: (value: NoteIndex) => void;
    let releasePreferences!: (value: ReturnType<typeof defaultTodoViewPreferences>) => void;
    getNoteIndex.mockReturnValueOnce(new Promise((resolve) => { releaseIndex = resolve; }));
    preferences.get.mockReturnValueOnce(new Promise((resolve) => { releasePreferences = resolve; }));
    renderScreen();
    await waitFor(() => expect(preferences.get).toHaveBeenCalledTimes(1));
    setFocused(false);
    vi.mocked(getSettings).mockResolvedValue({ captureFolderPath: "file:///replacement",
      ...(replacement === "profile" ? { vaultProfiles: [{ id: "work", name: "Work", rootUri: "file:///replacement", createdAt: 1 }], activeVaultProfileId: "work" } : {}),
    } as Awaited<ReturnType<typeof getSettings>>);
    getNoteIndex.mockResolvedValue({ builtAt: 2, notes: [{ ...SEEDED_INDEX.notes[1], title: "New vault" }] });
    preferences.get.mockResolvedValue(defaultTodoViewPreferences());
    setFocused(true);
    await screen.findByText("New vault");
    await act(async () => {
      releaseIndex(SEEDED_INDEX);
      releasePreferences({ ...defaultTodoViewPreferences(), query: "Old vault" });
    });
    expect(screen.queryByText("Buy milk")).toBeNull();
    expect((screen.getByLabelText("Search todos") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByText("All"));
    expect(preferences.set).toHaveBeenLastCalledWith(expect.objectContaining({ profileId: replacement === "profile" ? "work" : "default", rootUri: "file:///replacement" }), expect.objectContaining({ status: "all" }));
  });

  it("restores per-vault preferences and groups sorted original rows with source navigation", async () => {
    preferences.get.mockResolvedValue({ ...defaultTodoViewPreferences(), status: "all", sort: "oldest", groupBySource: true });
    const { navigation } = renderScreen(carnetDark);
    await screen.findByLabelText("Open source note Note A, 2 todos");
    const headings = screen.getAllByLabelText(/Open source note/);
    expect(headings[0].getAttribute("aria-label")).toContain("Note B");
    resolveNoteEntry.mockResolvedValue({ id: "a", mode: "idea", title: "Note A", filepath: "file:///v/Ideas/a.md", createdAt: 200 });
    fireEvent.click(screen.getByLabelText("Open source note Note A, 2 todos"));
    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith("RecentDetail", expect.objectContaining({ vaultContext: expect.objectContaining({ profileId: "default" }) })));
    fireEvent.click(screen.getByLabelText("Mark as not done: Call mom"));
    await waitFor(() => expect(updateChecklistItem).toHaveBeenCalledWith("file:///v/Ideas/a.md", "Call mom", true));
  });

  it("offers retries for failed loading and preference saves", async () => {
    getNoteIndex.mockRejectedValueOnce(new Error("offline"));
    renderScreen();
    fireEvent.click(await screen.findByText("Retry loading todos"));
    await screen.findByText("Buy milk");
    await waitForViewReady();
    preferences.set.mockRejectedValueOnce(new Error("storage full"));
    fireEvent.click(screen.getByText("All"));
    fireEvent.click(await screen.findByText("Retry view preferences"));
    await waitFor(() => expect(preferences.set).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Couldn't save view preferences/)).toBeNull();
  });

  it.each([carnetLight, carnetDark])("renders options and distinct search/filter/completed empties in both themes", async (theme) => {
    preferences.get.mockResolvedValue({ ...defaultTodoViewPreferences(), tags: ["missing"] });
    renderScreen(theme);
    await screen.findByText("No todos match these filters.");
    expect(screen.getByText("#missing")).toBeTruthy();
    await waitForViewReady();
    fireEvent.click(screen.getByLabelText("View options"));
    expect(screen.getByText("Tags — any selected tag")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Reset view")[0]);
    expect(screen.getByText("Buy milk")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search todos"), { target: { value: "absent" } });
    expect(screen.getByText("No todos match your search.")).toBeTruthy();
  });

  it("retries preference hydration without overwriting stored preferences", async () => {
    preferences.get.mockRejectedValueOnce(new Error("storage unavailable"));
    renderScreen();
    await screen.findByText("Buy milk");
    expect(await screen.findByText("Retry view preferences")).toBeTruthy();
    expect(preferences.set).not.toHaveBeenCalled();
    preferences.get.mockResolvedValue({ ...defaultTodoViewPreferences(), status: "completed" });
    fireEvent.click(screen.getByText("Retry view preferences"));
    expect(await screen.findByText("Call mom")).toBeTruthy();
    expect(preferences.set).not.toHaveBeenCalled();
  });

  it("restores a new profile's view on refocus and rejects old background refresh completion", async () => {
    const { refreshActiveVault } = await import("../lib/vaultRefreshService");
    let release!: (value: NoteIndex) => void;
    vi.mocked(refreshActiveVault).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    renderScreen();
    await screen.findByText("Buy milk");
    setFocused(false);
    vi.mocked(getSettings).mockResolvedValue({
      captureFolderPath: "file:///work", vaultProfiles: [{ id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 }], activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    preferences.get.mockResolvedValue({ ...defaultTodoViewPreferences(), status: "completed" });
    setFocused(true);
    await screen.findByText("Call mom");
    await act(async () => release({ builtAt: 9, notes: [] }));
    expect(screen.getByText("Call mom")).toBeTruthy();
    expect(preferences.get).toHaveBeenLastCalledWith({ profileId: "work", rootUri: "file:///work" });
    expect(preferences.set).not.toHaveBeenCalled();
  });

});

describe("flipInIndex", () => {
  const baseIndex: NoteIndex = {
    builtAt: 1,
    notes: [
      {
        uri: "file:///v/Ideas/a.md",
        subdir: "Ideas",
        title: "Note A",
        createdOrDate: 100,
        tags: [],
        mode: "idea",
        excerpt: "",
        todos: [
          { text: "First", checked: false },
          { text: "Second", checked: true },
        ],
      },
    ],
  };

  function todoAt(index: NoteIndex, ordinal: number): AggregatedTodo {
    const line = index.notes[0].todos![ordinal];
    return { ...line, uri: index.notes[0].uri, noteTitle: "Note A", subdir: "Ideas", mode: "idea", createdOrDate: 100, ordinal };
  }

  it("flips the checked state of exactly the note+ordinal targeted", () => {
    const todo = todoAt(baseIndex, 0);
    const result = flipInIndex(baseIndex, todo);
    expect(result.notes[0].todos).toEqual([
      { text: "First", checked: true },
      { text: "Second", checked: true },
    ]);
    // Immutable: original index untouched.
    expect(baseIndex.notes[0].todos![0].checked).toBe(false);
  });

  it("refuses to flip when the note's todo at that ordinal no longer matches (stale ordinal)", () => {
    // Simulates a refresh landing between the apply and revert calls in
    // onToggle: the closure's `todo` still says ordinal 0 is "First", but
    // the index it's applied against now has different text there.
    const reorderedIndex: NoteIndex = {
      ...baseIndex,
      notes: [
        {
          ...baseIndex.notes[0],
          todos: [
            { text: "Something else entirely", checked: false },
            { text: "Second", checked: true },
          ],
        },
      ],
    };
    const staleTodo = todoAt(baseIndex, 0); // text: "First", ordinal: 0
    const result = flipInIndex(reorderedIndex, staleTodo);
    // Untouched — not flipped, not corrupted.
    expect(result.notes[0].todos).toEqual(reorderedIndex.notes[0].todos);
  });

  it("leaves other notes untouched", () => {
    const twoNoteIndex: NoteIndex = {
      builtAt: 1,
      notes: [
        baseIndex.notes[0],
        {
          uri: "file:///v/Ideas/b.md",
          subdir: "Ideas",
          title: "Note B",
          createdOrDate: 50,
          tags: [],
          mode: "idea",
          excerpt: "",
          todos: [{ text: "First", checked: false }], // same text+ordinal, different note
        },
      ],
    };
    const todo = todoAt(twoNoteIndex, 0); // targets Note A
    const result = flipInIndex(twoNoteIndex, todo);
    expect(result.notes[0].todos![0].checked).toBe(true); // Note A flipped
    expect(result.notes[1].todos![0].checked).toBe(false); // Note B untouched
  });
});
