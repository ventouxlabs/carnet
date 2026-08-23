// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage mock — same pattern as queue.test.ts (no native
// binding under Node).
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
  assetKey,
  clearPushedAssets,
  loadPushedAssets,
  savePushedAssets,
} from "./karakeepAssetSync";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = (bm: string) => `carnet:karakeep-assets:v1:${bm}`;

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

describe("assetKey", () => {
  it("joins subdir and filename into a stable key", () => {
    expect(assetKey("Photos", "a.jpg")).toBe("Photos/a.jpg");
    expect(assetKey("Files", "report.pdf")).toBe("Files/report.pdf");
  });
});

describe("loadPushedAssets / savePushedAssets", () => {
  it("returns an empty map when nothing was saved", async () => {
    expect(await loadPushedAssets("bk_1")).toEqual(new Map());
  });

  it("round-trips a saved key→assetId map", async () => {
    await savePushedAssets(
      "bk_1",
      new Map([
        ["Photos/a.jpg", "as_1"],
        ["Files/b.pdf", "as_2"],
      ]),
    );
    expect(await loadPushedAssets("bk_1")).toEqual(
      new Map([
        ["Photos/a.jpg", "as_1"],
        ["Files/b.pdf", "as_2"],
      ]),
    );
  });

  it("persists the map as a JSON object of key→assetId", async () => {
    await savePushedAssets("bk_1", new Map([["Photos/a.jpg", "as_1"]]));
    expect(_store.get(KEY("bk_1"))).toBe('{"Photos/a.jpg":"as_1"}');
  });

  it("scopes records per bookmark id", async () => {
    await savePushedAssets("bk_1", new Map([["Photos/a.jpg", "as_1"]]));
    await savePushedAssets("bk_2", new Map([["Files/b.pdf", "as_2"]]));
    expect(await loadPushedAssets("bk_1")).toEqual(
      new Map([["Photos/a.jpg", "as_1"]]),
    );
    expect(await loadPushedAssets("bk_2")).toEqual(
      new Map([["Files/b.pdf", "as_2"]]),
    );
  });

  it("returns an empty map on a corrupt (non-JSON) value", async () => {
    await AsyncStorage.setItem(KEY("bk_x"), "{not json");
    expect(await loadPushedAssets("bk_x")).toEqual(new Map());
  });

  it("drops non-string assetId values from a stored object", async () => {
    await AsyncStorage.setItem(
      KEY("bk_y"),
      JSON.stringify({ "Photos/a.jpg": "as_1", "Files/b.pdf": 42 }),
    );
    expect(await loadPushedAssets("bk_y")).toEqual(
      new Map([["Photos/a.jpg", "as_1"]]),
    );
  });

  // Legacy v1 records were a JSON ARRAY of keys (no assetIds). Tolerate them by
  // mapping each to "" — the export treats an empty assetId as not-yet-synced
  // and re-uploads once to capture the real id.
  it("migrates a legacy array of keys to a key→'' map", async () => {
    await AsyncStorage.setItem(
      KEY("bk_legacy"),
      JSON.stringify(["Photos/a.jpg", "Files/b.pdf"]),
    );
    expect(await loadPushedAssets("bk_legacy")).toEqual(
      new Map([
        ["Photos/a.jpg", ""],
        ["Files/b.pdf", ""],
      ]),
    );
  });

  it("ignores non-string entries in a legacy array", async () => {
    await AsyncStorage.setItem(
      KEY("bk_z"),
      JSON.stringify(["Photos/a.jpg", 42, null, "Files/b.pdf"]),
    );
    expect(await loadPushedAssets("bk_z")).toEqual(
      new Map([
        ["Photos/a.jpg", ""],
        ["Files/b.pdf", ""],
      ]),
    );
  });
});

describe("clearPushedAssets", () => {
  it("forgets a bookmark's record, so a later load is empty", async () => {
    await savePushedAssets("bk_1", new Map([["Photos/a.jpg", "as_1"]]));
    await clearPushedAssets("bk_1");
    expect(await loadPushedAssets("bk_1")).toEqual(new Map());
  });

  it("leaves other bookmarks' records intact", async () => {
    await savePushedAssets("bk_1", new Map([["Photos/a.jpg", "as_1"]]));
    await savePushedAssets("bk_2", new Map([["Files/b.pdf", "as_2"]]));
    await clearPushedAssets("bk_1");
    expect(await loadPushedAssets("bk_2")).toEqual(
      new Map([["Files/b.pdf", "as_2"]]),
    );
  });
});
