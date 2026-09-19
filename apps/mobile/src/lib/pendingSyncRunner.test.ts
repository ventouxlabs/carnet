import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({ getSettings: vi.fn() }));
vi.mock("./hostReachability", () => ({ isHostReachable: vi.fn() }));
vi.mock("./writer", () => ({
  readNote: vi.fn(),
  getModificationTime: vi.fn(),
}));
vi.mock("./karakeepNoteExport", () => ({ exportNoteToKarakeep: vi.fn() }));
vi.mock("./pendingSync", () => ({ drainPendingExports: vi.fn() }));

import { drainPendingKarakeepExports } from "./pendingSyncRunner";
import { getSettings } from "./settings";
import { isHostReachable } from "./hostReachability";
import { getModificationTime, readNote } from "./writer";
import { exportNoteToKarakeep } from "./karakeepNoteExport";
import {
  drainPendingExports,
  type PendingExport,
  type PendingSyncDrainDeps,
} from "./pendingSync";

const ITEM: PendingExport = {
  id: "x1",
  kind: "karakeep-export",
  filepath: "file:///vault/Ideas/a.md",
  entryTitle: "A",
  queuedAt: 1,
  attempts: 0,
  lastError: null,
};

function mockUrl(karakeepUrl: string): void {
  vi.mocked(getSettings).mockResolvedValue({
    karakeepUrl,
    captureFolderPath: "file:///legacy",
  } as Awaited<ReturnType<typeof getSettings>>);
}

/** Run the runner and capture the deps it hands the drain. */
async function capturedDeps(): Promise<PendingSyncDrainDeps> {
  await drainPendingKarakeepExports();
  expect(drainPendingExports).toHaveBeenCalledTimes(1);
  return vi.mocked(drainPendingExports).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("drainPendingKarakeepExports", () => {
  it("skips the drain entirely when no Karakeep URL is configured", async () => {
    mockUrl("   ");
    await drainPendingKarakeepExports();
    expect(drainPendingExports).not.toHaveBeenCalled();
  });

  it("probes the configured (trimmed) base URL", async () => {
    mockUrl(" https://kk.tailnet.ts.net ");
    vi.mocked(isHostReachable).mockResolvedValue(true);
    const deps = await capturedDeps();
    await deps.isReachable();
    expect(isHostReachable).toHaveBeenCalledWith("https://kk.tailnet.ts.net");
  });

  it("classifies a confirmed-deleted file:// note as gone without exporting", async () => {
    mockUrl("https://kk");
    vi.mocked(readNote).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(getModificationTime).mockResolvedValue(null);
    const deps = await capturedDeps();
    await expect(deps.exportOne(ITEM)).resolves.toEqual({ kind: "gone" });
    expect(exportNoteToKarakeep).not.toHaveBeenCalled();
  });

  it("treats a transient read failure as a retryable error, not gone", async () => {
    mockUrl("https://kk");
    vi.mocked(readNote).mockRejectedValue(new Error("I/O hiccup"));
    // The file still exists — deletion is NOT confirmed.
    vi.mocked(getModificationTime).mockResolvedValue(1234);
    const deps = await capturedDeps();
    await expect(deps.exportOne(ITEM)).resolves.toEqual({
      kind: "error",
      message: "note read failed: I/O hiccup",
    });
  });

  it("never classifies a SAF content:// read failure as gone (existence unconfirmable)", async () => {
    mockUrl("https://kk");
    vi.mocked(readNote).mockRejectedValue(new Error("SAF: permission"));
    vi.mocked(getModificationTime).mockResolvedValue(null);
    const deps = await capturedDeps();
    await expect(
      deps.exportOne({ ...ITEM, filepath: "content://doc/tree/a.md" }),
    ).resolves.toEqual({
      kind: "error",
      message: "note read failed: SAF: permission",
    });
  });

  it("re-reads the note body and exports with the queued title", async () => {
    mockUrl("https://kk");
    vi.mocked(readNote).mockResolvedValue("# fresh body\n");
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "exported",
      nextBody: "n",
      didUpdate: false,
      skippedUnsupported: [],
    });
    const deps = await capturedDeps();
    const item = {
      ...ITEM,
      vaultContext: { profileId: "a", rootUri: "file:///vault-a" },
    };
    await expect(deps.exportOne(item)).resolves.toEqual({ kind: "ok" });
    expect(exportNoteToKarakeep).toHaveBeenCalledWith({
      body: "# fresh body\n",
      filepath: ITEM.filepath,
      entryTitle: "A",
      rootOverride: expect.objectContaining({ uri: "file:///vault-a" }),
    });
  });

  it("routes a legacy contextless row through the default profile, not the active profile", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      karakeepUrl: "https://kk",
      captureFolderPath: "file:///work",
      vaultProfiles: [
        { id: "default", name: "Personal", rootUri: "file:///personal", createdAt: 0 },
        { id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 },
      ],
      activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(readNote).mockResolvedValue("# fresh body\n");
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "exported", nextBody: "n", didUpdate: false, skippedUnsupported: [],
    });
    const deps = await capturedDeps();

    await expect(deps.exportOne(ITEM)).resolves.toEqual({ kind: "ok" });
    expect(exportNoteToKarakeep).toHaveBeenCalledWith(expect.objectContaining({
      rootOverride: expect.objectContaining({ uri: "file:///personal" }),
    }));
  });

  it("treats a partial export as delivered", async () => {
    mockUrl("https://kk");
    vi.mocked(readNote).mockResolvedValue("body");
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "partial",
      nextBody: "n",
      assetError: "upload failed",
      skippedUnsupported: [],
    });
    const deps = await capturedDeps();
    await expect(deps.exportOne(ITEM)).resolves.toEqual({ kind: "ok" });
  });

  it("maps an unreachable failure to the drain's stop signal", async () => {
    mockUrl("https://kk");
    vi.mocked(readNote).mockResolvedValue("body");
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "failed",
      reason: "timed out after 20s",
      unreachable: true,
    });
    const deps = await capturedDeps();
    await expect(deps.exportOne(ITEM)).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("maps a real failure to an attempt-burning error", async () => {
    mockUrl("https://kk");
    vi.mocked(readNote).mockResolvedValue("body");
    vi.mocked(exportNoteToKarakeep).mockResolvedValue({
      kind: "failed",
      reason: "HTTP 500",
      unreachable: false,
    });
    const deps = await capturedDeps();
    await expect(deps.exportOne(ITEM)).resolves.toEqual({
      kind: "error",
      message: "HTTP 500",
    });
  });

  it("never throws — a settings read failure is swallowed with a warn", async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error("storage broken"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(drainPendingKarakeepExports()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
