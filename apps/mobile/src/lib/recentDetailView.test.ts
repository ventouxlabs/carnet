import { describe, expect, it } from "vitest";

import {
  activeIssueMessage,
  busyLabel,
  formatDate,
  formatMode,
  isActionsBusy,
  karakeepSnackbarMessage,
  noteCapabilities,
  relatedSubdirForMode,
} from "./recentDetailView";

const NO_ISSUES = {
  editError: null,
  karakeepError: null,
  transcribeError: null,
  reEnrichError: null,
  enhanceError: null,
  attachPhotoError: null,
};
const NOT_BUSY = {
  reEnriching: false,
  transcribing: false,
  exportingKarakeep: false,
  enhancing: false,
  attachingPhoto: false,
};

describe("formatMode", () => {
  it("gives each mode a distinct human label", () => {
    // Asserted as a whole map so a swapped pair (person -> "Photo") fails.
    expect({
      idea: formatMode("idea"),
      journal: formatMode("journal"),
      person: formatMode("person"),
      photo: formatMode("photo"),
      audio: formatMode("audio"),
      note: formatMode("note"),
    }).toEqual({
      idea: "Idea",
      journal: "Journal",
      // "Contact", not "Person" — the user-facing word for the People vault.
      person: "Contact",
      photo: "Photo",
      audio: "Audio",
      note: "Note",
    });
  });

  it("gives a mode this build can't name a generic label, not undefined", () => {
    // A row persisted by a newer build, read after a downgrade — the File info
    // summary used to read "undefined · captured …".
    expect(formatMode("task" as unknown as Parameters<typeof formatMode>[0])).toBe("Capture");
  });
});

describe("formatDate", () => {
  it("renders the unix ms instant, not the raw number", () => {
    const unix = 1_751_975_746_000;
    const out = formatDate(unix);
    // Locale-stable pin: the year (2025) must appear, and the raw epoch
    // number must not — this fails if formatDate stops rendering the
    // actual date (e.g. drops to a fixed/empty string) without depending
    // on the exact locale formatting the test environment produces.
    expect(out).toContain("2025");
    expect(out).not.toContain(String(unix));
  });
});

describe("activeIssueMessage", () => {
  it("returns null when nothing failed", () => {
    expect(activeIssueMessage(NO_ISSUES)).toBeNull();
  });

  it("prefixes each error with the operation that produced it", () => {
    expect(activeIssueMessage({ ...NO_ISSUES, editError: "disk full" })).toBe(
      "Save failed: disk full",
    );
    expect(activeIssueMessage({ ...NO_ISSUES, karakeepError: "401" })).toBe(
      "Karakeep export failed: 401",
    );
    expect(activeIssueMessage({ ...NO_ISSUES, transcribeError: "no model" })).toBe(
      "Transcribe failed: no model",
    );
    expect(activeIssueMessage({ ...NO_ISSUES, reEnrichError: "timeout" })).toBe(
      "Re-enrich failed: timeout",
    );
  });

  it("gives the save error precedence over every other failure", () => {
    // All four set with DISTINCT reasons: whichever branch runs is visible in
    // the output, so reordering the precedence chain cannot stay green.
    expect(
      activeIssueMessage({
        editError: "save-reason",
        karakeepError: "karakeep-reason",
        transcribeError: "transcribe-reason",
        reEnrichError: "enrich-reason",
        enhanceError: "enhance-reason",
        attachPhotoError: "attach-reason",
      }),
    ).toBe("Save failed: save-reason");
  });

  it("orders the remaining three karakeep > transcribe > re-enrich", () => {
    expect(
      activeIssueMessage({
        editError: null,
        karakeepError: "karakeep-reason",
        transcribeError: "transcribe-reason",
        reEnrichError: "enrich-reason",
        enhanceError: "enhance-reason",
        attachPhotoError: "attach-reason",
      }),
    ).toBe("Karakeep export failed: karakeep-reason");
    expect(
      activeIssueMessage({
        editError: null,
        karakeepError: null,
        transcribeError: "transcribe-reason",
        reEnrichError: "enrich-reason",
        enhanceError: "enhance-reason",
        attachPhotoError: "attach-reason",
      }),
    ).toBe("Transcribe failed: transcribe-reason");
    expect(
      activeIssueMessage({
        editError: null,
        karakeepError: null,
        transcribeError: null,
        reEnrichError: "enrich-reason",
        enhanceError: "enhance-reason",
        attachPhotoError: "attach-reason",
      }),
    ).toBe("Re-enrich failed: enrich-reason");
    expect(
      activeIssueMessage({
        ...NO_ISSUES,
        enhanceError: "enhance-reason",
        attachPhotoError: "attach-reason",
      }),
    ).toBe("Enhance failed: enhance-reason");
  });

  it("reports an attach-photo failure when it is the only issue", () => {
    // Lowest precedence: a refused attach costs the user a re-shot, never
    // their own words.
    expect(
      activeIssueMessage({ ...NO_ISSUES, attachPhotoError: "note changed" }),
    ).toBe("Attach photo failed: note changed");
  });
});

describe("busyLabel", () => {
  it("returns null when idle", () => {
    expect(busyLabel(NOT_BUSY)).toBeNull();
  });

  it("names the running operation", () => {
    expect(busyLabel({ ...NOT_BUSY, reEnriching: true })).toBe(
      "Re-running vision enrichment…",
    );
    expect(busyLabel({ ...NOT_BUSY, transcribing: true })).toBe(
      "Transcribing audio…",
    );
    expect(busyLabel({ ...NOT_BUSY, exportingKarakeep: true })).toBe(
      "Sending to Karakeep…",
    );
  });

  it("orders re-enrich > transcribe > karakeep > enhance when several overlap", () => {
    const allBusy = {
      reEnriching: true,
      transcribing: true,
      exportingKarakeep: true,
      enhancing: true,
      attachingPhoto: true,
    };
    expect(busyLabel(allBusy)).toBe("Re-running vision enrichment…");
    expect(busyLabel({ ...allBusy, reEnriching: false })).toBe("Transcribing audio…");
    expect(
      busyLabel({ ...allBusy, reEnriching: false, transcribing: false }),
    ).toBe("Sending to Karakeep…");
    expect(
      busyLabel({
        ...allBusy,
        reEnriching: false,
        transcribing: false,
        exportingKarakeep: false,
      }),
    ).toBe("Enhancing prose…");
    expect(busyLabel({ ...NOT_BUSY, attachingPhoto: true })).toBe(
      "Attaching photo…",
    );
  });
});

describe("isActionsBusy", () => {
  it("is false only when all actions are idle", () => {
    expect(isActionsBusy(NOT_BUSY)).toBe(false);
    expect(isActionsBusy({ ...NOT_BUSY, reEnriching: true })).toBe(true);
    expect(isActionsBusy({ ...NOT_BUSY, transcribing: true })).toBe(true);
    expect(isActionsBusy({ ...NOT_BUSY, exportingKarakeep: true })).toBe(true);
    expect(isActionsBusy({ ...NOT_BUSY, enhancing: true })).toBe(true);
    expect(isActionsBusy({ ...NOT_BUSY, attachingPhoto: true })).toBe(true);
  });
});

describe("noteCapabilities", () => {
  it("offers re-enrich only for kinds whose raw input is on disk", () => {
    expect(noteCapabilities("photo", false).canReEnrich).toBe(true);
    expect(noteCapabilities("shared-image", false).canReEnrich).toBe(true);
    for (const kind of ["idea", "journal", "person", "shared-audio", "shared-link", ""]) {
      expect(noteCapabilities(kind, false).canReEnrich).toBe(false);
    }
  });

  it("offers transcribe only for audio notes", () => {
    expect(noteCapabilities("shared-audio", false).canTranscribe).toBe(true);
    for (const kind of ["photo", "shared-image", "idea", ""]) {
      expect(noteCapabilities(kind, false).canTranscribe).toBe(false);
    }
  });

  it("hides the player for an audio note whose file is missing", () => {
    expect(noteCapabilities("shared-audio", true)).toEqual({
      canReEnrich: false,
      canTranscribe: true,
      canEnhance: false,
      showAudioPlayer: false,
    });
    expect(noteCapabilities("shared-audio", false).showAudioPlayer).toBe(true);
  });

  it("offers enhance for every kind, but never when the file is missing", () => {
    // Deliberately NOT kind-gated: the "is there enough prose?" test needs the
    // body text and lives in lib/enhanceProse.ts. Only `missing` gates here.
    for (const kind of [
      "idea",
      "journal",
      "person",
      "photo",
      "shared-image",
      "shared-audio",
      "shared-link",
      "",
    ]) {
      expect(noteCapabilities(kind, false).canEnhance).toBe(true);
      expect(noteCapabilities(kind, true).canEnhance).toBe(false);
    }
  });

  it("never shows the player for a non-audio kind, missing or not", () => {
    expect(noteCapabilities("photo", false).showAudioPlayer).toBe(false);
    expect(noteCapabilities("photo", true).showAudioPlayer).toBe(false);
  });
});

describe("relatedSubdirForMode", () => {
  it("maps each mode onto its vault subdir", () => {
    expect({
      journal: relatedSubdirForMode("journal"),
      person: relatedSubdirForMode("person"),
      idea: relatedSubdirForMode("idea"),
      photo: relatedSubdirForMode("photo"),
      audio: relatedSubdirForMode("audio"),
      note: relatedSubdirForMode("note"),
    }).toEqual({
      journal: "Journal",
      person: "People",
      // photo/audio captures land in Ideas/ alongside idea notes.
      idea: "Ideas",
      photo: "Ideas",
      audio: "Ideas",
      note: "Notes",
    });
  });
});

describe("karakeepSnackbarMessage", () => {
  it("distinguishes an in-place update from a fresh export", () => {
    expect(karakeepSnackbarMessage(true, null)).toBe("Updated in Karakeep");
    expect(karakeepSnackbarMessage(false, null)).toBe("Exported to Karakeep");
  });

  it("appends the skip notice as its own sentence", () => {
    expect(karakeepSnackbarMessage(false, "a.zip is a file type")).toBe(
      "Exported to Karakeep. a.zip is a file type.",
    );
    expect(karakeepSnackbarMessage(true, "a.zip is a file type")).toBe(
      "Updated in Karakeep. a.zip is a file type.",
    );
  });
});
