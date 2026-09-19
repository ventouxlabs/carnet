// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the IO surface is mocked. The pure collaborators — markdownEdit,
// wysiwygSave/tags, frontmatter, @carnet/shared's deriveTitle — run for real,
// so the assertions below pin actual bytes rather than stub echoes.
vi.mock("./writer", async () => {
  const fm = await import("./frontmatter");
  return {
    splitFrontmatter: fm.splitFrontmatter,
    updateNote: vi.fn(async () => undefined),
  };
});
vi.mock("./storage", () => ({ updateCaptureTitle: vi.fn(async () => undefined) }));
vi.mock("./vault", async () => {
  const fm = await import("./frontmatter");
  return {
    getTagIndex: vi.fn(async () => ({ builtAt: 1, tags: [] })),
    invalidateNoteIndex: vi.fn(async () => undefined),
    tagsForNote: (md: string) => fm.getFrontmatterTags(md),
  };
});
vi.mock("./vaultImageInsert", () => ({ pickAndWriteVaultImage: vi.fn() }));

import { updateCaptureTitle } from "./storage";
import { getTagIndex, invalidateNoteIndex } from "./vault";
import { pickAndWriteVaultImage } from "./vaultImageInsert";
import { updateNote } from "./writer";
import { useNoteEditSession, type NoteEditSession } from "./useNoteEditSession";

const HEADER = "---\ncreated: 2026-07-08T11:55:46.000Z\ntags: [qa-test]\n---\n";
const NOTE_BODY = "# Draft Survival Test\n\nHello body text.\n";
const NOTE = HEADER + NOTE_BODY;
const ROOT = { uri: "file:///pinned-vault", fs: {} } as never;

// A deliberately NON-CANONICAL header: block-list tags, padded key spacing and a
// quoted, un-normalized tag value. Nothing here survives a round-trip through
// setFrontmatterTags (which would collapse the list to `tags: [qa-test,
// second-tag]` and drop the padding), so any test asserting these exact bytes
// can tell "header preserved verbatim" apart from "header re-serialized and
// happened to match".
const BLOCK_HEADER =
  "---\ncreated:   2026-07-08T11:55:46.000Z\ntags:\n  - qa-test\n  - 'Second Tag'\n---\n";
const BLOCK_NOTE = BLOCK_HEADER + NOTE_BODY;

function setup(overrides: Partial<Parameters<typeof useNoteEditSession>[0]> = {}) {
  const onBodyChange = vi.fn();
  const hook = renderHook(
    (props: Partial<Parameters<typeof useNoteEditSession>[0]>) =>
      useNoteEditSession({
        body: NOTE,
        filepath: "file:///v/Ideas/draft-survival-test.md",
        entryId: "r1",
        entryTitle: "Draft Survival Test",
        profileId: "vault-a",
        rootOverride: ROOT,
        richEditorEnabled: false,
        onBodyChange,
        ...props,
      }),
    { initialProps: overrides },
  );
  return { ...hook, onBodyChange };
}

/** Install a fake WYSIWYG bridge that returns `markdown` from getMarkdown(). */
function mountEditor(
  result: { current: NoteEditSession },
  markdown: string | Error,
) {
  const insertImage = vi.fn();
  act(() => {
    result.current.wysiwygRef.current = {
      getMarkdown: vi.fn(() =>
        markdown instanceof Error
          ? Promise.reject(markdown)
          : Promise.resolve(markdown),
      ),
      insertImage,
    } as unknown as NonNullable<typeof result.current.wysiwygRef.current>;
  });
  return { insertImage };
}

/**
 * Make the next updateNote() hang until the returned function is called, so a
 * save can be observed mid-flight (that is the only window in which the
 * in-flight / mounted guards are reachable).
 */
function deferNextUpdateNote(): () => void {
  let release!: () => void;
  vi.mocked(updateNote).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
  );
  return () => release();
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("entering and leaving edit mode", () => {
  it("seeds the markdown textarea with the FULL note, frontmatter included", () => {
    const { result } = setup();
    act(() => result.current.enterEdit());
    expect(result.current.editMode).toBe(true);
    expect(result.current.draft).toBe(NOTE);
    expect(result.current.selection).toEqual({ start: 0, end: 0 });
    expect(result.current.forceSelection).toBeNull();
  });

  it("seeds the rich editor with the BODY ONLY and the frontmatter tags as chips", () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    expect(result.current.wysiwygSeed).toBe(NOTE_BODY);
    expect(result.current.wysiwygSeed).not.toContain("---");
    expect(result.current.editTags).toEqual(["qa-test"]);
  });

  it("loads the vault tag index for autocomplete", async () => {
    vi.mocked(getTagIndex).mockResolvedValue({
      builtAt: 1,
      tags: [{ tag: "alpha", count: 2 }, { tag: "beta", count: 1 }],
    } as Awaited<ReturnType<typeof getTagIndex>>);
    const { result } = setup();
    await waitFor(() => expect(result.current.knownTags).toEqual(["alpha", "beta"]));
  });

  it("is dirty only once the markdown draft actually differs from disk", () => {
    const { result } = setup();
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.enterEdit());
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.setDraft(`${NOTE}extra`));
    expect(result.current.isDirty).toBe(true);
  });

  it("treats any rich-editor session as dirty (the WebView can't be diffed cheaply)", () => {
    const { result } = setup({ richEditorEnabled: true });
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.enterEdit());
    expect(result.current.isDirty).toBe(true);
  });

  it("cancels straight out when there is nothing to discard", () => {
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.cancelEdit());
    expect(result.current.discardVisible).toBe(false);
    expect(result.current.editMode).toBe(false);
    expect(result.current.draft).toBe("");
  });

  it("prompts before discarding real edits, and keeps them when asked", () => {
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(`${NOTE}extra`));
    act(() => result.current.cancelEdit());
    expect(result.current.discardVisible).toBe(true);
    // Still editing — nothing lost yet.
    expect(result.current.editMode).toBe(true);
    expect(result.current.draft).toBe(`${NOTE}extra`);

    act(() => result.current.keepEditing());
    expect(result.current.discardVisible).toBe(false);
    expect(result.current.editMode).toBe(true);
    expect(result.current.draft).toBe(`${NOTE}extra`);

    act(() => result.current.cancelEdit());
    act(() => result.current.confirmDiscard());
    expect(result.current.discardVisible).toBe(false);
    expect(result.current.editMode).toBe(false);
    expect(result.current.draft).toBe("");
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("replays the blocked navigation only after the discard is confirmed", () => {
    const replay = vi.fn();
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    act(() => result.current.showDiscardPrompt(replay));
    expect(result.current.discardVisible).toBe(true);
    expect(replay).not.toHaveBeenCalled();

    act(() => result.current.confirmDiscard());
    expect(replay).toHaveBeenCalledTimes(1);
    expect(result.current.editMode).toBe(false);
  });

  it("drops a pending replay when the user keeps editing", () => {
    const replay = vi.fn();
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    act(() => result.current.showDiscardPrompt(replay));
    act(() => result.current.keepEditing());
    // A later plain Cancel → Discard must NOT re-fire the stale navigation.
    act(() => result.current.cancelEdit());
    act(() => result.current.confirmDiscard());
    expect(replay).not.toHaveBeenCalled();
  });

  it("clears the tag chips on exit so they cannot leak into the next session", () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    expect(result.current.editTags).toEqual(["qa-test"]);
    act(() => result.current.setEditTags(["qa-test", "scratch"]));

    act(() => result.current.cancelEdit());
    act(() => result.current.confirmDiscard());
    // Leaving edit mode must drop the abandoned chips outright — a stale
    // "scratch" surviving here would render on the read-only screen and, worse,
    // be re-adopted by any later code path that reads editTags before enterEdit.
    expect(result.current.editTags).toEqual([]);

    act(() => result.current.enterEdit());
    expect(result.current.editTags).toEqual(["qa-test"]);
  });
});

describe("toolbar editing", () => {
  it("applies a real format transform and parks the caret after it", () => {
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("plain text"));
    act(() => result.current.setSelection({ start: 0, end: 5 }));
    act(() => result.current.applyFmt("bold"));

    expect(result.current.draft).toBe("**plain** text");
    expect(result.current.forceSelection).not.toBeNull();
    act(() => result.current.clearForceSelection());
    expect(result.current.forceSelection).toBeNull();
  });

  it("inserts the picked image as a relative embed at the caret", async () => {
    vi.mocked(pickAndWriteVaultImage).mockResolvedValue({
      rel: "../Photos/shot.jpg",
      dataUri: "data:image/jpeg;base64,AAA",
    } as Awaited<ReturnType<typeof pickAndWriteVaultImage>>);
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("before after"));
    act(() => result.current.setSelection({ start: 7, end: 7 }));
    await act(async () => {
      await result.current.insertImage();
    });

    expect(result.current.draft).toBe("before ![](../Photos/shot.jpg)after");
    expect(pickAndWriteVaultImage).toHaveBeenCalledWith(ROOT);
    expect(result.current.editError).toBeNull();
  });

  it("writes nothing into the draft when the picker is cancelled", async () => {
    vi.mocked(pickAndWriteVaultImage).mockResolvedValue(null);
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("untouched"));
    await act(async () => {
      await result.current.insertImage();
    });
    expect(result.current.draft).toBe("untouched");
    // A cancel is not a failure: the null-write guard must SHORT-CIRCUIT, not
    // fall through into insertAtCursor and get rescued by the catch — that
    // path leaves the draft untouched too, but flashes a bogus TypeError in
    // the save banner.
    expect(result.current.editError).toBeNull();
  });

  it("writes nothing into the rich editor when the picker is cancelled", async () => {
    vi.mocked(pickAndWriteVaultImage).mockResolvedValue(null);
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    const { insertImage } = mountEditor(result, NOTE_BODY);
    await act(async () => {
      await result.current.insertWysiwygImage();
    });
    expect(insertImage).not.toHaveBeenCalled();
    // Same short-circuit contract as the markdown path — no banner on cancel.
    expect(result.current.editError).toBeNull();
  });

  it("surfaces an image-write failure in the save banner", async () => {
    vi.mocked(pickAndWriteVaultImage).mockRejectedValue(new Error("SAF denied"));
    const { result } = setup();
    act(() => result.current.enterEdit());
    await act(async () => {
      await result.current.insertImage();
    });
    expect(result.current.editError).toBe("SAF denied");
  });

  it("hands the rich editor both the relative link and the preview data URI", async () => {
    vi.mocked(pickAndWriteVaultImage).mockResolvedValue({
      rel: "../Photos/shot.jpg",
      dataUri: "data:image/jpeg;base64,AAA",
    } as Awaited<ReturnType<typeof pickAndWriteVaultImage>>);
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    const { insertImage } = mountEditor(result, NOTE_BODY);
    await act(async () => {
      await result.current.insertWysiwygImage();
    });
    expect(insertImage).toHaveBeenCalledWith(
      "../Photos/shot.jpg",
      "data:image/jpeg;base64,AAA",
    );
    expect(pickAndWriteVaultImage).toHaveBeenCalledWith(ROOT);
  });

  it("ignores a format tap while a save is committing", async () => {
    const release = deferNextUpdateNote();
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("plain text"));
    act(() => result.current.setSelection({ start: 0, end: 5 }));
    let save!: Promise<void>;
    act(() => {
      save = result.current.handleSaveEdit();
    });
    expect(result.current.saving).toBe(true);

    act(() => result.current.applyFmt("bold"));
    // The save already captured `draft`; a late transform would be written to
    // the screen and then thrown away when the save exits edit mode.
    expect(result.current.draft).toBe("plain text");

    await act(async () => {
      release();
      await save;
    });
  });

  it("ignores the image button while a save is committing", async () => {
    vi.mocked(pickAndWriteVaultImage).mockResolvedValue(null);
    const release = deferNextUpdateNote();
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("plain text"));
    let save!: Promise<void>;
    act(() => {
      save = result.current.handleSaveEdit();
    });

    await act(async () => {
      await result.current.insertImage();
    });
    // Only the SAVE guard is armed here (no image pick is in flight), so an
    // `&&` between the two conditions would let the picker open mid-save.
    expect(pickAndWriteVaultImage).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await save;
    });
  });
});

describe("markdown save", () => {
  it("writes the draft verbatim, adopts it, and leaves edit mode", async () => {
    const edited = `${HEADER}# Renamed Note\n\nNew text.\n`;
    const { result, onBodyChange } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(edited));
    await act(async () => {
      await result.current.handleSaveEdit();
    });

    expect(updateNote).toHaveBeenCalledWith(
      "file:///v/Ideas/draft-survival-test.md",
      edited,
    );
    expect(onBodyChange).toHaveBeenCalledWith(edited);
    expect(result.current.editMode).toBe(false);
    expect(result.current.saving).toBe(false);
    // H1 changed → the recents row is renamed to match.
    expect(updateCaptureTitle).toHaveBeenCalledWith("r1", "Renamed Note", "vault-a");
  });

  it("skips the recents-title write when the H1 is unchanged", async () => {
    const edited = `${HEADER}# Draft Survival Test\n\nOnly the body moved.\n`;
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(edited));
    await act(async () => {
      await result.current.handleSaveEdit();
    });
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateCaptureTitle).not.toHaveBeenCalled();
  });

  it("keeps the user in edit mode with a banner when the disk write fails", async () => {
    vi.mocked(updateNote).mockRejectedValueOnce(new Error("ENOSPC"));
    const { result, onBodyChange } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(`${NOTE}extra`));
    await act(async () => {
      await result.current.handleSaveEdit();
    });

    expect(result.current.editError).toBe("ENOSPC");
    expect(result.current.editMode).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(result.current.draft).toBe(`${NOTE}extra`);
    expect(onBodyChange).not.toHaveBeenCalled();
    // The note never landed, so the recents title must not be renamed either.
    expect(updateCaptureTitle).not.toHaveBeenCalled();
  });

  it("still leaves edit mode when only the best-effort title write fails", async () => {
    vi.mocked(updateCaptureTitle).mockRejectedValueOnce(new Error("AsyncStorage"));
    const { result, onBodyChange } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(`${HEADER}# Renamed Note\n\nx\n`));
    await act(async () => {
      await result.current.handleSaveEdit();
    });

    expect(onBodyChange).toHaveBeenCalled();
    expect(result.current.editMode).toBe(false);
    expect(result.current.editError).toBeNull();
  });

  it("keeps the recents title when the saved note has no derivable heading", async () => {
    // deriveTitle returns "" here (no H1, blank first line); without the
    // `|| entryTitle` fallback that empty string would be pushed onto the
    // recents row, blanking it.
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft("\njust a paragraph, no heading\n"));
    await act(async () => {
      await result.current.handleSaveEdit();
    });

    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(updateCaptureTitle).not.toHaveBeenCalled();
  });

  it("ignores a second Save tap while the first write is still in flight", async () => {
    const release = deferNextUpdateNote();
    const { result } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(`${NOTE}extra`));
    let save!: Promise<void>;
    act(() => {
      save = result.current.handleSaveEdit();
    });
    expect(result.current.saving).toBe(true);

    await act(async () => {
      await result.current.handleSaveEdit();
    });
    // A double-tap must not write the note twice.
    expect(updateNote).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await save;
    });
    expect(updateNote).toHaveBeenCalledTimes(1);
    expect(result.current.editMode).toBe(false);
  });

  it("does not adopt the saved body when the screen unmounted mid-write", async () => {
    const release = deferNextUpdateNote();
    const { result, onBodyChange, unmount } = setup();
    act(() => result.current.enterEdit());
    act(() => result.current.setDraft(`${HEADER}# Renamed Note\n\nx\n`));
    let save!: Promise<void>;
    act(() => {
      save = result.current.handleSaveEdit();
    });
    unmount();
    await act(async () => {
      release();
      await save;
    });

    // The write itself still landed on disk...
    expect(updateNote).toHaveBeenCalledTimes(1);
    // ...but nothing may be pushed back into an unmounted screen.
    expect(onBodyChange).not.toHaveBeenCalled();
    expect(updateCaptureTitle).not.toHaveBeenCalled();
  });
});

describe("rich (WYSIWYG) save", () => {
  it("reattaches the stashed frontmatter header byte-exact ahead of the edited body", async () => {
    const { result, onBodyChange } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, "# Draft Survival Test\n\nEdited in the WebView.\n");
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    const written = vi.mocked(updateNote).mock.calls[0][1];
    // Byte-exact header: same key order, same values, one delimiter pair.
    expect(written).toBe(
      `${HEADER}# Draft Survival Test\n\nEdited in the WebView.\n`,
    );
    expect(written.startsWith(HEADER)).toBe(true);
    expect(written.match(/^---$/gm)?.length).toBe(2);
    expect(onBodyChange).toHaveBeenCalledWith(written);
    // Tags untouched → the vault index stays valid.
    expect(invalidateNoteIndex).not.toHaveBeenCalled();
  });

  it("skips the write entirely when the editor returns the on-disk content", async () => {
    const { result, onBodyChange } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, NOTE_BODY);
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    expect(updateNote).not.toHaveBeenCalled();
    expect(onBodyChange).not.toHaveBeenCalled();
    expect(result.current.editMode).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  it("rewrites the tags line and invalidates the index when chips change", async () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, NOTE_BODY);
    act(() => result.current.setEditTags(["qa-test", "added"]));
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    const written = vi.mocked(updateNote).mock.calls[0][1];
    expect(written).toContain("added");
    expect(written).toContain("qa-test");
    // The unrelated frontmatter key survives untouched.
    expect(written).toContain("created: 2026-07-08T11:55:46.000Z");
    expect(written.match(/^---$/gm)?.length).toBe(2);
    expect(written.endsWith(NOTE_BODY)).toBe(true);
    expect(invalidateNoteIndex).toHaveBeenCalledWith("vault-a");
  });

  it("reports a bridge failure instead of hanging on a disabled Save", async () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, new Error("getMarkdown timed out"));
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    expect(result.current.editError).toBe("getMarkdown timed out");
    expect(result.current.editMode).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("errors rather than writing when Save is tapped before the editor mounts", async () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });
    expect(result.current.editError).toBe("Editor not mounted");
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("renames the recents row from the SAVED markdown's heading", async () => {
    const { result } = setup({ richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, "# Renamed In WebView\n\nBody.\n");
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });
    expect(updateCaptureTitle).toHaveBeenCalledWith("r1", "Renamed In WebView", "vault-a");
  });

  // ── The byte-compatibility guarantee ───────────────────────────────────────
  // These two are the strongest tests in this file: an Obsidian vault holds
  // hand-written frontmatter that carnet did not author, and a body-only edit
  // must never re-serialize it. BLOCK_HEADER is chosen so that "preserved" and
  // "re-serialized" produce DIFFERENT bytes — with a canonical header the two
  // are indistinguishable and the assertion proves nothing.

  it("preserves a hand-written, non-canonical header BYTE-FOR-BYTE on a body-only edit", async () => {
    const { result, onBodyChange } = setup({
      body: BLOCK_NOTE,
      richEditorEnabled: true,
    });
    act(() => result.current.enterEdit());
    // The chips seed from the block list, so the tag SET is unchanged and the
    // header must be reattached verbatim rather than rewritten.
    expect(result.current.editTags).toEqual(["qa-test", "Second Tag"]);
    mountEditor(result, "# Draft Survival Test\n\nEdited in the WebView.\n");
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    const written = vi.mocked(updateNote).mock.calls[0][1];
    expect(written).toBe(
      `${BLOCK_HEADER}# Draft Survival Test\n\nEdited in the WebView.\n`,
    );
    // Spelled out, so a failure names the exact corruption: the block list must
    // still be a block list, the padded key must keep its padding, and the
    // quoted tag must keep its case and quotes.
    expect(written).toContain("tags:\n  - qa-test\n  - 'Second Tag'\n");
    expect(written).toContain("created:   2026-07-08T11:55:46.000Z");
    expect(written).not.toContain("second-tag");
    expect(onBodyChange).toHaveBeenCalledWith(written);
    // Unchanged tag set → the vault index is still valid.
    expect(invalidateNoteIndex).not.toHaveBeenCalled();
  });

  it("skips the write entirely for a non-canonical header when nothing changed", async () => {
    const { result } = setup({ body: BLOCK_NOTE, richEditorEnabled: true });
    act(() => result.current.enterEdit());
    mountEditor(result, NOTE_BODY);
    await act(async () => {
      await result.current.handleSaveWysiwyg();
    });

    // Open + Save on an untouched note must not churn the file. A re-serialized
    // header would differ from disk and force a pointless (destructive) write.
    expect(updateNote).not.toHaveBeenCalled();
    expect(invalidateNoteIndex).not.toHaveBeenCalled();
    expect(result.current.editMode).toBe(false);
  });
});
