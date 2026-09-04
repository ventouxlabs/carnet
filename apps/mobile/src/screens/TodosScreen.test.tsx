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

import TodosScreen from "./TodosScreen";

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

  it("the open/all filter changes what's rendered", async () => {
    renderScreen();
    await screen.findByText("Buy milk");
    expect(screen.queryByText("Call mom")).toBeNull();

    fireEvent.click(screen.getByText("All"));

    expect(await screen.findByText("Call mom")).toBeTruthy();
  });
});
