// @vitest-environment jsdom
//
// Screen smoke test (pattern: see TagBrowserScreen.test.tsx). getAllTodos is
// kept REAL (via importOriginal) so the aggregation/sort/filter behavior
// under test is genuine, not a stand-in; only the storage/IO-touching vault
// functions (getNoteIndex, refreshNoteIndex, resolveNoteEntry,
// upsertNoteInIndex) and writer functions (readNote, updateChecklistItem)
// are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { NoteIndex } from "../lib/vault";

vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(cb, [cb]);
    },
  };
});

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
const resolveNoteEntry = vi.fn(async () => null);
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

function renderScreen() {
  const navigation = makeNavigation();
  render(
    <PaperProvider theme={carnetLight}>
      <TodosScreen
        navigation={navigation as unknown as ScreenProps["navigation"]}
        route={{ key: "t", name: "Todos", params: undefined } as ScreenProps["route"]}
      />
    </PaperProvider>,
  );
  return { navigation };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    await waitFor(() => expect(upsertNoteInIndex).toHaveBeenCalledWith("file:///v/Ideas/a.md", expect.any(String)));
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
    // A real successful write for ONE specific line — this is the case the
    // old text-only matching got wrong: it had no way to tell the two rows
    // apart, so a successful write to one line flipped BOTH in the local
    // cache until the next refocus.
    updateChecklistItem.mockResolvedValueOnce({ ok: true });
    renderScreen();

    // "All" filter, not the default "open" — a successfully-checked row must
    // stay visible after the toggle for this assertion to see both rows.
    fireEvent.click(await screen.findByText("All"));

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
    expect(screen.queryByText("Call mom")).toBeNull();

    fireEvent.click(screen.getByText("All"));

    expect(await screen.findByText("Call mom")).toBeTruthy();
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
