// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PaperProvider } from "react-native-paper";

import { PersonJournalLinksCard } from "./PersonJournalLinksCard";
import { carnetLight } from "../lib/theme";

describe("PersonJournalLinksCard", () => {
  it("shows each ambiguous journal match and requires an explicit link action", () => {
    const onLink = vi.fn();
    render(
      <PaperProvider theme={carnetLight}>
        <PersonJournalLinksCard
          matches={[
            { uri: "file:///Journal/2026-09-12.md", linkTitle: "2026-09-12", linkTarget: "Journal/2026-09-12", excerpt: "Met Ada Lovelace." },
            { uri: "file:///Journal/2026-09-11.md", linkTitle: "2026-09-11", linkTarget: "Journal/2026-09-11", excerpt: "Ada Lovelace called." },
          ]}
          onLink={onLink}
        />
      </PaperProvider>,
    );

    expect(screen.getByText("Journal mentions")).toBeTruthy();
    expect(screen.getByText("Met Ada Lovelace.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Link journal 2026-09-12 into this person"));
    expect(onLink).toHaveBeenCalledWith({
      uri: "file:///Journal/2026-09-12.md",
      linkTitle: "2026-09-12",
      linkTarget: "Journal/2026-09-12",
      excerpt: "Met Ada Lovelace.",
    });
  });
});
