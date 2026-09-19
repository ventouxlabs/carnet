import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory AsyncStorage mock — same pattern as queue.test.ts ─────────────

const PENDING_SYNC_KEY = "carnet:pendingsync:v1";
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
  drainPendingExports,
  enqueuePendingExport,
  getPendingExportCount,
  listPendingExports,
  subscribePendingSyncChanges,
  MAX_PENDING_EXPORT_ATTEMPTS,
  type PendingExport,
  type PendingExportResult,
} from "./pendingSync";

function storedItems(): PendingExport[] {
  const raw = _store.get(PENDING_SYNC_KEY);
  return raw ? (JSON.parse(raw) as PendingExport[]) : [];
}

beforeEach(() => {
  _store.clear();
});

// ── CRUD + dedupe ────────────────────────────────────────────────────────────

describe("enqueuePendingExport", () => {
  it("persists the source vault context for a future drain", async () => {
    const vaultContext = { profileId: "a", rootUri: "file:///vault-a" };
    await enqueuePendingExport({ filepath: "file:///vault-a/Ideas/a.md", entryTitle: "A", vaultContext });
    expect((await listPendingExports())[0].vaultContext).toEqual(vaultContext);
  });

  it("stores a karakeep-export item with zero attempts", async () => {
    await enqueuePendingExport({
      filepath: "file:///vault/Ideas/a.md",
      entryTitle: "A",
    });
    const items = await listPendingExports();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "karakeep-export",
      filepath: "file:///vault/Ideas/a.md",
      entryTitle: "A",
      attempts: 0,
      lastError: null,
    });
    expect(items[0].id).toBeTruthy();
  });

  it("dedupes by filepath — a re-queue refreshes the title, keeps attempts", async () => {
    await enqueuePendingExport({
      filepath: "file:///vault/Ideas/a.md",
      entryTitle: "Old title",
    });
    // Simulate a burned attempt so we can see it survive the re-queue.
    const seeded = storedItems();
    seeded[0] = { ...seeded[0], attempts: 3 };
    _store.set(PENDING_SYNC_KEY, JSON.stringify(seeded));

    await enqueuePendingExport({
      filepath: "file:///vault/Ideas/a.md",
      entryTitle: "New title",
    });
    const items = await listPendingExports();
    expect(items).toHaveLength(1);
    expect(items[0].entryTitle).toBe("New title");
    expect(items[0].attempts).toBe(3);
  });

  it("queues distinct notes separately and counts them", async () => {
    await enqueuePendingExport({ filepath: "file:///a.md", entryTitle: "A" });
    await enqueuePendingExport({ filepath: "file:///b.md", entryTitle: "B" });
    await expect(getPendingExportCount()).resolves.toBe(2);
  });

  it("survives a corrupt storage payload", async () => {
    _store.set(PENDING_SYNC_KEY, "{not json");
    await expect(listPendingExports()).resolves.toEqual([]);
    await enqueuePendingExport({ filepath: "file:///a.md", entryTitle: "A" });
    await expect(getPendingExportCount()).resolves.toBe(1);
  });
});

// ── Change notification ──────────────────────────────────────────────────────

describe("subscribePendingSyncChanges", () => {
  it("pings on enqueue, on drain removal, and on attempt bumps", async () => {
    const pings: number[] = [];
    const unsubscribe = subscribePendingSyncChanges(() => pings.push(1));

    await enqueuePendingExport({ filepath: "file:///a.md", entryTitle: "A" });
    expect(pings).toHaveLength(1);

    await drainPendingExports({
      isReachable: async () => true,
      exportOne: async () => ({ kind: "error", message: "HTTP 500" }),
    });
    expect(pings).toHaveLength(2); // bump

    await drainPendingExports({
      isReachable: async () => true,
      exportOne: async () => ({ kind: "ok" }),
    });
    expect(pings).toHaveLength(3); // removal

    unsubscribe();
    await enqueuePendingExport({ filepath: "file:///b.md", entryTitle: "B" });
    expect(pings).toHaveLength(3); // unsubscribed — no further pings
  });

  it("isolates a throwing subscriber from the queue and its siblings", async () => {
    const seen: string[] = [];
    const unsubBad = subscribePendingSyncChanges(() => {
      throw new Error("broken subscriber");
    });
    const unsubGood = subscribePendingSyncChanges(() => seen.push("good"));

    await expect(
      enqueuePendingExport({ filepath: "file:///a.md", entryTitle: "A" }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual(["good"]);
    await expect(getPendingExportCount()).resolves.toBe(1);

    unsubBad();
    unsubGood();
  });
});

// ── Drain orchestration (injected deps) ──────────────────────────────────────
// (What-queues classification is tested where it lives: karakeepNoteExport's
// `unreachable` flag — see karakeepNoteExport.test.ts.)

async function seed(...filepaths: string[]): Promise<PendingExport[]> {
  for (const filepath of filepaths) {
    await enqueuePendingExport({ filepath, entryTitle: filepath });
  }
  return listPendingExports();
}

describe("drainPendingExports", () => {
  it("does not probe the host when the queue is empty", async () => {
    const isReachable = vi.fn(async () => true);
    const exportOne = vi.fn();
    await drainPendingExports({ isReachable, exportOne });
    expect(isReachable).not.toHaveBeenCalled();
    expect(exportOne).not.toHaveBeenCalled();
  });

  it("exports nothing when the host is unreachable, burning no attempts", async () => {
    await seed("file:///a.md");
    const exportOne = vi.fn();
    await drainPendingExports({ isReachable: async () => false, exportOne });
    expect(exportOne).not.toHaveBeenCalled();
    expect((await listPendingExports())[0].attempts).toBe(0);
  });

  it("removes items that export ok, oldest-first", async () => {
    await seed("file:///a.md", "file:///b.md");
    const order: string[] = [];
    await drainPendingExports({
      isReachable: async () => true,
      exportOne: async (item) => {
        order.push(item.filepath);
        return { kind: "ok" };
      },
    });
    expect(order).toEqual(["file:///a.md", "file:///b.md"]);
    await expect(getPendingExportCount()).resolves.toBe(0);
  });

  it("drops an item whose note no longer exists", async () => {
    await seed("file:///gone.md");
    await drainPendingExports({
      isReachable: async () => true,
      exportOne: async () => ({ kind: "gone" }),
    });
    await expect(getPendingExportCount()).resolves.toBe(0);
  });

  it("stops the pass on the first unreachable result, leaving the rest untouched", async () => {
    await seed("file:///a.md", "file:///b.md", "file:///c.md");
    const results: PendingExportResult[] = [
      { kind: "ok" },
      { kind: "unreachable" },
    ];
    const exportOne = vi.fn(async () => results.shift() ?? { kind: "ok" as const });
    await drainPendingExports({ isReachable: async () => true, exportOne });
    // a exported, b hit unreachable, c never attempted.
    expect(exportOne).toHaveBeenCalledTimes(2);
    const remaining = await listPendingExports();
    expect(remaining.map((i) => i.filepath)).toEqual([
      "file:///b.md",
      "file:///c.md",
    ]);
    // Unreachability burns no attempts.
    expect(remaining.every((i) => i.attempts === 0)).toBe(true);
  });

  it("bumps attempts on a real error and continues with later items", async () => {
    await seed("file:///bad.md", "file:///good.md");
    await drainPendingExports({
      isReachable: async () => true,
      exportOne: async (item) =>
        item.filepath === "file:///bad.md"
          ? { kind: "error", message: "HTTP 500" }
          : { kind: "ok" },
    });
    const remaining = await listPendingExports();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      filepath: "file:///bad.md",
      attempts: 1,
      lastError: "HTTP 500",
    });
  });

  it("redacts Bearer tokens before persisting an error", async () => {
    await seed("file:///a.md");
    await drainPendingExports({
      isReachable: async () => true,
      exportOne: async () => ({
        kind: "error",
        message: "rejected Bearer sk-secret-token",
      }),
    });
    expect((await listPendingExports())[0].lastError).toBe(
      "rejected Bearer [redacted]",
    );
  });

  it("drops an item once errors reach the attempts cap", async () => {
    await seed("file:///a.md");
    for (let i = 0; i < MAX_PENDING_EXPORT_ATTEMPTS; i++) {
      await drainPendingExports({
        isReachable: async () => true,
        exportOne: async () => ({ kind: "error", message: "HTTP 500" }),
      });
    }
    await expect(getPendingExportCount()).resolves.toBe(0);
  });

  it("is single-flight — a drain started mid-drain is a no-op", async () => {
    await seed("file:///a.md");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exportOne = vi.fn(async (): Promise<PendingExportResult> => {
      await gate;
      return { kind: "ok" };
    });
    const first = drainPendingExports({
      isReachable: async () => true,
      exportOne,
    });
    // Second call while the first holds the flight guard.
    await drainPendingExports({ isReachable: async () => true, exportOne });
    release();
    await first;
    expect(exportOne).toHaveBeenCalledTimes(1);
  });
});
