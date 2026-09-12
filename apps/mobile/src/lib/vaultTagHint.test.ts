import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./vault", () => ({ loadCachedTagIndex: vi.fn() }));

import { loadCachedTagIndex } from "./vault";
import { getVaultTagStrings, MAX_HINT_TAGS, MAX_TAG_LENGTH } from "./vaultTagHint";
// withTagHint lives in prompts.ts (pure, no native imports) so that
// llmClient.ts can use it without pulling ./vault -> expo-modules-core in.
import { withTagHint } from "./prompts";

function mockIndex(tags: { tag: string; count: number }[]) {
  return { builtAt: 0, tags: tags.map((t) => ({ ...t, files: [] })) };
}

describe("getVaultTagStrings", () => {
  beforeEach(() => {
    vi.mocked(loadCachedTagIndex).mockReset();
  });

  it("returns [] on a cold cache instead of triggering a vault walk", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(null);
    expect(await getVaultTagStrings()).toEqual([]);
  });

  // Note: the vault mock deliberately exposes ONLY loadCachedTagIndex. If the
  // implementation ever reaches for getTagIndex (which falls through to a full
  // SAF vault walk on a cache miss), every test here fails with "not a
  // function" — that is the guard, not a separate assertion.

  it("returns [] when the cached read throws", async () => {
    vi.mocked(loadCachedTagIndex).mockRejectedValue(new Error("storage gone"));
    expect(await getVaultTagStrings()).toEqual([]);
  });

  it("preserves the index's count-sorted order", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([
        { tag: "journal", count: 9 },
        { tag: "idea", count: 4 },
        { tag: "dev", count: 1 },
      ]),
    );
    expect(await getVaultTagStrings()).toEqual(["journal", "idea", "dev"]);
  });

  it("caps at MAX_HINT_TAGS, keeping the most-used", async () => {
    const many = Array.from({ length: MAX_HINT_TAGS + 20 }, (_, i) => ({
      tag: `tag${i}`,
      count: 1000 - i,
    }));
    vi.mocked(loadCachedTagIndex).mockResolvedValue(mockIndex(many));
    const result = await getVaultTagStrings();
    expect(result).toHaveLength(MAX_HINT_TAGS);
    expect(result[0]).toBe("tag0");
  });

  it("drops over-long tags rather than truncating them", async () => {
    const long = "a".repeat(MAX_TAG_LENGTH + 1);
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([
        { tag: long, count: 5 },
        { tag: "ok", count: 1 },
      ]),
    );
    expect(await getVaultTagStrings()).toEqual(["ok"]);
  });

  it("keeps a tag exactly at MAX_TAG_LENGTH", async () => {
    const atLimit = "a".repeat(MAX_TAG_LENGTH);
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([{ tag: atLimit, count: 1 }]),
    );
    expect(await getVaultTagStrings()).toEqual([atLimit]);
  });

  it("drops empty tags", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([
        { tag: "", count: 5 },
        { tag: "ok", count: 1 },
      ]),
    );
    expect(await getVaultTagStrings()).toEqual(["ok"]);
  });

  it("honours an explicit smaller limit", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([
        { tag: "a", count: 3 },
        { tag: "b", count: 2 },
        { tag: "c", count: 1 },
      ]),
    );
    expect(await getVaultTagStrings(2)).toEqual(["a", "b"]);
  });

  it("returns [] for an empty vault index", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(mockIndex([]));
    expect(await getVaultTagStrings()).toEqual([]);
  });
});

describe("withTagHint", () => {
  it("returns the system prompt untouched when there are no tags", () => {
    expect(withTagHint("SYSTEM", [])).toBe("SYSTEM");
  });

  it("appends a hint naming the tags", () => {
    const result = withTagHint("SYSTEM", ["dev", "journal"]);
    expect(result.startsWith("SYSTEM")).toBe(true);
    expect(result).toContain("dev, journal");
  });

  it("tells the model it may still create new tags", () => {
    expect(withTagHint("SYSTEM", ["dev"]).toLowerCase()).toContain("new");
  });

  it("does not override the per-prompt tag count instruction", () => {
    // Builders ask for 2-3 (idea/journal/person) or 3-5 (shared image/link);
    // the hint supplies vocabulary only and must not restate a count.
    const hint = withTagHint("SYSTEM", ["dev"]).slice("SYSTEM".length);
    expect(hint).not.toMatch(/\b\d+\s*[-–]\s*\d+\b/);
  });

  it("is applied on top of an arbitrary (overridden) system prompt", () => {
    const overridden = "Totally custom user instructions.";
    expect(withTagHint(overridden, ["dev"]).startsWith(overridden)).toBe(true);
  });
});
