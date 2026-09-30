// @vitest-environment jsdom
//
// modeStamp is the stamp every browse surface and the Sync dialog read. A mode
// this build can't name (a row persisted by a newer build, read after a
// downgrade) used to fall off the switch as `undefined`, and every
// `modeStamp(mode).label` / destructure threw into CrashBoundary.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { carnetLight } from "../lib/theme";
import type { CaptureMode } from "../lib/storage";
import { modeStamp, NoteCard } from "./NoteCard";

afterEach(cleanup);

const FROM_A_NEWER_BUILD = "task" as unknown as CaptureMode;

describe("modeStamp", () => {
  it("still names every known mode", () => {
    expect(modeStamp("idea").label).toBe("Idea");
    expect(modeStamp("note").label).toBe("Note");
    expect(modeStamp("person").label).toBe("Contact");
  });

  it("degrades an unknown persisted mode to a generic stamp instead of undefined", () => {
    expect(modeStamp(FROM_A_NEWER_BUILD)).toEqual({ label: "Capture", icon: "file-document-outline" });
  });
});

describe("NoteCard", () => {
  it("renders a card for an unknown persisted mode rather than throwing", () => {
    render(
      <PaperProvider theme={carnetLight}>
        <NoteCard title="From the future" mode={FROM_A_NEWER_BUILD} onPress={() => undefined} />
      </PaperProvider>,
    );
    expect(screen.getByLabelText("Capture: From the future")).toBeTruthy();
  });
});
