import { beforeEach, describe, expect, it, vi } from "vitest";

const { refreshNoteIndex, loadCachedNoteIndex, resolveContextRoot } = vi.hoisted(() => ({
  refreshNoteIndex: vi.fn(),
  loadCachedNoteIndex: vi.fn(),
  resolveContextRoot: vi.fn(),
}));

vi.mock("./vault", () => ({ refreshNoteIndex, loadCachedNoteIndex }));
vi.mock("./vaultRoot", () => ({ resolveContextRoot }));
vi.mock("./settings", () => ({ getSettings: vi.fn() }));

import { refreshActiveVault } from "./vaultRefreshService";

describe("refreshActiveVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshNoteIndex.mockResolvedValue({ builtAt: 1, notes: [] });
    loadCachedNoteIndex.mockResolvedValue({ builtAt: 1, notes: [] });
  });

  it("scans and caches against the root captured before a profile switch", async () => {
    const workContext = { profileId: "work", rootUri: "file:///work" };
    const workRoot = { uri: "file:///work", fs: {} };
    resolveContextRoot.mockReturnValue(workRoot);

    await refreshActiveVault(workContext);

    expect(resolveContextRoot).toHaveBeenCalledWith(workContext);
    expect(refreshNoteIndex).toHaveBeenCalledWith("work", workRoot);
    expect(loadCachedNoteIndex).toHaveBeenCalledWith("work");
  });
});
