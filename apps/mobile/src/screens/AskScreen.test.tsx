// @vitest-environment jsdom
//
// Screen smoke test for the retrospective query, in the house pattern
// (TagBrowserScreen.test.tsx): real component tree, real react-native-paper
// under the real carnetLight theme, native/data deps vi.mock'd.
//
// What this protects: the three properties that make a synthesized answer
// trustworthy — a citation the model invented does NOT become a tappable link,
// an answer built from fewer notes than matched says so, and Save lands in the
// vault AND the index in one action (without the second half the note is on
// disk but invisible to Search, which reads as "it vanished").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";

vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(cb, [cb]);
    },
  };
});

// vi.mock factories are hoisted above every const in this file, so the spies
// they close over have to be hoisted too.
const { askVault, writeSynthesis, upsertNoteInIndex, resolveNoteEntry, readNoteBodies } =
  vi.hoisted(() => ({
    askVault: vi.fn(),
    writeSynthesis: vi.fn(),
    upsertNoteInIndex: vi.fn(),
    resolveNoteEntry: vi.fn(),
    readNoteBodies: vi.fn(),
  }));

vi.mock("../lib/dispatcher", () => ({
  askVault,
  // captureErrorDecision (askErrorMessage) classifies through these — the
  // factory replaces the whole module, so they must all be present.
  isNotConfiguredError: vi.fn(() => false),
  isPermanentError: vi.fn(() => false),
  isInsecureTransportError: vi.fn(() => false),
}));

vi.mock("../lib/writer", () => ({ writeSynthesis }));

vi.mock("../lib/vault", () => ({ upsertNoteInIndex, resolveNoteEntry, readNoteBodies }));

import AskScreen, { type AskScreenProps } from "./AskScreen";
import type { CaptureEntry } from "../lib/storage";

const CANDIDATE_A = { uri: "file:///v/Ideas/a.md", title: "A", fromBodyMatch: false };

function renderScreen(params?: Partial<AskScreenProps["route"]["params"]>) {
  const navigation = { navigate: vi.fn() };
  render(
    <PaperProvider theme={carnetLight}>
      <AskScreen
        route={{
          params: {
            question: "what about A?",
            candidates: [CANDIDATE_A],
            ...params,
          },
        }}
        navigation={navigation as unknown as AskScreenProps["navigation"]}
      />
    </PaperProvider>,
  );
  return { navigation };
}

beforeEach(() => {
  vi.clearAllMocks();
  askVault.mockResolvedValue({
    result: { markdown: "You wrote about [[A]] and [[Ghost]].", model: "m" },
    usedFallback: false,
    fallbackProviderId: null,
    providerLabel: "Test",
  });
  readNoteBodies.mockResolvedValue(new Map([["file:///v/Ideas/a.md", "body a"]]));
  writeSynthesis.mockResolvedValue({ filepath: "file:///v/Notes/q.md" });
  upsertNoteInIndex.mockResolvedValue(undefined);
  resolveNoteEntry.mockResolvedValue(null);
});

afterEach(cleanup);

describe("AskScreen", () => {
  it("renders the synthesized answer", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText(/You wrote about/)).toBeTruthy());
  });

  it("renders a citation outside the retrieval set as inert text", async () => {
    // [[Ghost]] was never sent, so the model invented it. It must render as its
    // literal source text — a link to nothing is worse than visibly made up.
    renderScreen();
    await waitFor(() => expect(screen.getByText(/\[\[Ghost\]\]/)).toBeTruthy());
  });

  it("saves to Notes/ and updates the index in the same action", async () => {
    renderScreen();
    await waitFor(() => screen.getByText(/You wrote about/));
    fireEvent.click(screen.getByLabelText("Save answer to vault"));
    await waitFor(() => {
      expect(writeSynthesis).toHaveBeenCalled();
      expect(upsertNoteInIndex).toHaveBeenCalledWith(
        "file:///v/Notes/q.md",
        expect.stringContaining("tags: [synthesis]"),
      );
    });
  });

  it("opens the note behind a citation that WAS in the retrieval set", async () => {
    const entry = {
      filepath: CANDIDATE_A.uri,
      title: "A",
      mode: "idea",
    } as unknown as CaptureEntry;
    resolveNoteEntry.mockResolvedValue(entry);

    const { navigation } = renderScreen();
    fireEvent.click(await screen.findByLabelText("Open note A"));

    await waitFor(() => expect(resolveNoteEntry).toHaveBeenCalledWith(CANDIDATE_A.uri));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("RecentDetail", { entry }),
    );
  });

  it("does not navigate when the cited note no longer resolves", async () => {
    // A citation can outlive its note (deleted since the index was built).
    // RecentDetailScreen would crash on a null entry.
    resolveNoteEntry.mockResolvedValue(null);
    const { navigation } = renderScreen();
    fireEvent.click(await screen.findByLabelText("Open note A"));
    await waitFor(() => expect(resolveNoteEntry).toHaveBeenCalledWith(CANDIDATE_A.uri));
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("discloses that the answer used fewer notes than matched", async () => {
    // Two candidates on screen, one body readable → one note actually sent.
    renderScreen({
      candidates: [CANDIDATE_A, { uri: "file:///v/Ideas/b.md", title: "B", fromBodyMatch: false }],
    });
    await waitFor(() =>
      expect(screen.getByText("Synthesized from the top 1 of 2 matches.")).toBeTruthy(),
    );
  });

  it("sanitizes the answer before it reaches the renderer, not just before save", async () => {
    // The render path is the FIRST place model output lands. A Templater tag
    // that survives to the screen is one copy-paste from executing in Obsidian.
    askVault.mockResolvedValue({
      result: { markdown: "Before <% tp.file.title %> after.", model: "m" },
      usedFallback: false,
      fallbackProviderId: null,
      providerLabel: "Test",
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText(/Before/)).toBeTruthy());
    expect(screen.queryByText(/tp\.file\.title/)).toBeNull();
  });

  it("surfaces an ask failure instead of a permanently empty answer", async () => {
    askVault.mockRejectedValue(new Error("timed out after 30s"));
    renderScreen();
    await waitFor(() => expect(screen.getByText("timed out after 30s")).toBeTruthy());
  });

  it("offers a retry after a failure instead of dead-ending", async () => {
    // The failure message used to live only in a Snackbar that self-clears
    // after 7s, and the run-once ref blocked any second attempt — leaving the
    // question on screen with no answer, no error and no way forward.
    askVault.mockRejectedValueOnce(new Error("timed out after 30s"));
    renderScreen();

    const retry = await screen.findByLabelText("Retry");
    expect(screen.getByText("timed out after 30s")).toBeTruthy();

    fireEvent.click(retry);
    await waitFor(() => expect(askVault).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/You wrote about/)).toBeTruthy());
  });

  it("treats an empty model answer as a failure, not a blank note", async () => {
    // Plan: "An LLM answer that comes back empty or unparseable surfaces as a
    // failure, not as a blank note." An armed Save here would write an empty
    // synthesis note into the vault.
    askVault.mockResolvedValue({
      result: { markdown: "   \n  \n", model: "m" },
      usedFallback: false,
      fallbackProviderId: null,
      providerLabel: "Test",
    });
    renderScreen();

    await waitFor(() =>
      expect(screen.getByText("The model returned nothing.")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Save answer to vault")).toBeNull();
    expect(await screen.findByLabelText("Retry")).toBeTruthy();
  });

  it("keeps Save latched after the confirmation toast auto-dismisses", async () => {
    // `saved` used to be both the toast's visibility flag and the button's
    // latch, so Paper's 2.5s auto-dismiss re-armed the button. writeSynthesis
    // collision-resolves rather than overwrites, so a second tap writes a
    // DUPLICATE note (q-2.md) — savingRef only guards concurrent taps.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderScreen();
      await waitFor(() => screen.getByText(/You wrote about/));
      fireEvent.click(screen.getByLabelText("Save answer to vault"));
      await waitFor(() => expect(writeSynthesis).toHaveBeenCalledTimes(1));

      await act(async () => {
        vi.advanceTimersByTime(6000);
      });

      expect(screen.getByText("Saved")).toBeTruthy();
      expect(screen.queryByText("Save to vault")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits the note is missing from Search when indexing fails after a good write", async () => {
    // The note IS on disk, so this is not a save failure — but claiming a
    // plain success would reproduce exactly the "I saved it and it vanished"
    // outcome acceptance criterion 4 exists to prevent.
    upsertNoteInIndex.mockRejectedValue(new Error("index write failed"));
    renderScreen();
    await waitFor(() => screen.getByText(/You wrote about/));
    fireEvent.click(screen.getByLabelText("Save answer to vault"));

    await waitFor(() =>
      expect(
        screen.getByText("Saved to Notes, but Search needs a refresh to show it."),
      ).toBeTruthy(),
    );
    // Still latched: the write succeeded, so re-saving would duplicate it.
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("does not call the model when no candidate body could be read", async () => {
    readNoteBodies.mockResolvedValue(new Map());
    renderScreen();
    await waitFor(() =>
      expect(screen.getByText("None of these notes could be read.")).toBeTruthy(),
    );
    expect(askVault).not.toHaveBeenCalled();
  });
});
