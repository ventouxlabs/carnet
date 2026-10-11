import { describe, expect, it } from "vitest";

import { hasPossibleSafStaleTail } from "./safTailDetector";

describe("hasPossibleSafStaleTail", () => {
  it("finds an unterminated terminal fragment repeated as an earlier line suffix", () => {
    expect(
      hasPossibleSafStaleTail(
        "# A note\n\nThe original sentence ends with a distinctive fragment\nNew shorter text\ndistinctive fragment",
      ),
    ).toBe(true);
  });

  it("does not flag ordinary newline-terminated Markdown", () => {
    expect(
      hasPossibleSafStaleTail(
        "# A note\n\nThe original sentence ends with a distinctive fragment\ndistinctive fragment\n",
      ),
    ).toBe(false);
  });

  it("does not flag a repeated whole line or a short ending", () => {
    expect(hasPossibleSafStaleTail("repeatable line\nrepeatable line")).toBe(false);
    expect(hasPossibleSafStaleTail("A longer prose line\nline")).toBe(false);
  });

  it("ignores frontmatter and fenced-code fragments", () => {
    expect(
      hasPossibleSafStaleTail(
        "---\nmetadata: the distinctive leftover fragment\ndistinctive leftover fragment",
      ),
    ).toBe(false);
    expect(
      hasPossibleSafStaleTail(
        "```text\nThe code line ends in a distinctive leftover fragment\ndistinctive leftover fragment",
      ),
    ).toBe(false);
  });
});
