import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage mock — same pattern as writer.test.ts's
// expo-file-system mock, but for the React Native AsyncStorage module.
// We can't pull in the real native binding under Node + vitest.
const _store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _store.delete(k);
    }),
  },
}));

import {
  getRecentCaptures,
  recordCapture,
  removeFromHistory,
  removeFromHistoryByFilepath,
  removeManyFromHistory,
  updateCaptureFilepath,
  updateCaptureTitle,
  type CaptureEntry,
} from "./storage";
import AsyncStorage from "@react-native-async-storage/async-storage";

function entry(id: string, t = Date.now()): CaptureEntry {
  return {
    id,
    mode: "idea",
    title: `entry-${id}`,
    filepath: `/vault/Ideas/${id}.md`,
    createdAt: t,
  };
}

describe("recents history", () => {
  beforeEach(() => {
    _store.clear();
  });

  it("starts empty when nothing has been recorded", async () => {
    expect(await getRecentCaptures()).toEqual([]);
  });

  it("records entries in MRU order (newest first)", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await recordCapture(entry("c"));
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("caps at HISTORY_LIMIT (20)", async () => {
    for (let i = 0; i < 25; i++) {
      await recordCapture(entry(`${i}`));
    }
    const xs = await getRecentCaptures();
    expect(xs).toHaveLength(20);
    expect(xs[0].id).toBe("24");
    expect(xs[19].id).toBe("5");
  });

  it("removeFromHistory removes by id and preserves the order of the rest", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await recordCapture(entry("c"));
    await removeFromHistory("b");
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["c", "a"]);
  });

  it("removeFromHistory is a no-op for an unknown id", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await removeFromHistory("nonexistent");
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("removeFromHistory on an empty store does not throw", async () => {
    await expect(removeFromHistory("anything")).resolves.toBeUndefined();
    expect(await getRecentCaptures()).toEqual([]);
  });

  it("returns an empty array when stored JSON is corrupted", async () => {
    _store.set("carnet:history:v1", "{ this is not valid JSON");
    expect(await getRecentCaptures()).toEqual([]);
  });

  it("isolates histories by profile and migrates v1 only to default", async () => {
    _store.set("carnet:history:v1", JSON.stringify([entry("legacy")]));
    await recordCapture(entry("work"), "work");

    expect((await getRecentCaptures("work")).map((item) => item.id)).toEqual(["work"]);
    expect((await getRecentCaptures("default")).map((item) => item.id)).toEqual(["legacy"]);
    expect(_store.has("carnet:history:v2:default")).toBe(true);
  });
});

describe("removeManyFromHistory", () => {
  beforeEach(() => {
    _store.clear();
  });

  it("removes multiple ids in a single write, preserving order of the rest", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await recordCapture(entry("c"));
    await recordCapture(entry("d"));
    // MRU order before delete: d, c, b, a
    await removeManyFromHistory(["b", "d"]);
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["c", "a"]);
  });

  it("ignores unknown ids", async () => {
    await recordCapture(entry("a"));
    await removeManyFromHistory(["nope", "alsoNope"]);
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["a"]);
  });

  it("is a no-op on empty input (does not touch storage)", async () => {
    await recordCapture(entry("a"));
    await removeManyFromHistory([]);
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["a"]);
  });

  it("clears all entries when every id matches", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await removeManyFromHistory(["a", "b"]);
    const xs = await getRecentCaptures();
    expect(xs).toEqual([]);
  });

  it("dedupes via internal Set (duplicate ids still remove once each)", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await removeManyFromHistory(["a", "a"]);
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["b"]);
  });
});

describe("removeFromHistoryByFilepath", () => {
  beforeEach(() => {
    _store.clear();
    vi.mocked(AsyncStorage.setItem).mockClear();
  });

  it("removes the entry whose filepath matches (id-agnostic)", async () => {
    await recordCapture(entry("a")); // filepath /vault/Ideas/a.md
    await recordCapture(entry("b"));
    await removeFromHistoryByFilepath("/vault/Ideas/a.md");
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["b"]);
  });

  it("is a no-op (skips the write) when no filepath matches", async () => {
    await recordCapture(entry("a"));
    vi.mocked(AsyncStorage.setItem).mockClear();
    await removeFromHistoryByFilepath("/vault/Ideas/ghost.md");
    expect(vi.mocked(AsyncStorage.setItem)).not.toHaveBeenCalled();
    expect((await getRecentCaptures()).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("updateCaptureTitle", () => {
  beforeEach(() => {
    _store.clear();
    vi.mocked(AsyncStorage.setItem).mockClear();
  });

  it("updates the matching id and leaves siblings untouched", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await recordCapture(entry("c"));
    await updateCaptureTitle("b", "Fixed title");
    const xs = await getRecentCaptures();
    const byId = Object.fromEntries(xs.map((e) => [e.id, e.title]));
    expect(byId).toEqual({ a: "entry-a", b: "Fixed title", c: "entry-c" });
  });

  it("preserves MRU order when updating a non-head entry", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await recordCapture(entry("c"));
    await updateCaptureTitle("a", "Renamed");
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("is a no-op for an unknown id (does not touch storage)", async () => {
    await recordCapture(entry("a"));
    vi.mocked(AsyncStorage.setItem).mockClear();
    await updateCaptureTitle("ghost", "Whatever");
    const xs = await getRecentCaptures();
    expect(xs.map((e) => e.title)).toEqual(["entry-a"]);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it("skips the write when the new title equals the existing title (common no-change case)", async () => {
    await recordCapture(entry("a"));
    vi.mocked(AsyncStorage.setItem).mockClear();
    await updateCaptureTitle("a", "entry-a");
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});

describe("updateCaptureFilepath", () => {
  beforeEach(() => {
    _store.clear();
    vi.mocked(AsyncStorage.setItem).mockClear();
  });

  it("repoints the matching entry's filepath and leaves siblings untouched", async () => {
    await recordCapture(entry("a"));
    await recordCapture(entry("b"));
    await updateCaptureFilepath("/vault/Ideas/a.md", "/vault/Ideas/a-2.md");
    const xs = await getRecentCaptures();
    const byId = Object.fromEntries(xs.map((e) => [e.id, e.filepath]));
    expect(byId).toEqual({
      a: "/vault/Ideas/a-2.md",
      b: "/vault/Ideas/b.md",
    });
  });

  it("is a no-op (skips the write) when no filepath matches", async () => {
    await recordCapture(entry("a"));
    vi.mocked(AsyncStorage.setItem).mockClear();
    await updateCaptureFilepath("/vault/Ideas/ghost.md", "/vault/Ideas/new.md");
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect((await getRecentCaptures())[0].filepath).toBe("/vault/Ideas/a.md");
  });
});
