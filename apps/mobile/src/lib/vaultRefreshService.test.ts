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
    expect(loadCachedNoteIndex).toHaveBeenCalledWith("work", workRoot);
  });
});

it("does not throttle a replacement folder behind the same profile's recent scan", async () => {
  vi.clearAllMocks();
  resolveContextRoot.mockImplementation((context) => ({ uri: context.rootUri, fs: {} }));
  const a = { profileId: "replacement", rootUri: "file:///a" };
  const b = { profileId: "replacement", rootUri: "file:///b" };
  await refreshActiveVault(a);
  await refreshActiveVault(b);
  expect(refreshNoteIndex).toHaveBeenCalledTimes(2);
  expect(refreshNoteIndex).toHaveBeenNthCalledWith(2, "replacement", { uri: b.rootUri, fs: {} });
});

it("does not share an old folder's delayed scan with its replacement", async () => {
  vi.clearAllMocks();
  resolveContextRoot.mockImplementation((context) => ({ uri: context.rootUri, fs: {} }));
  let finishA!: () => void;
  refreshNoteIndex.mockImplementationOnce(() => new Promise((resolve) => {
    finishA = () => resolve({ builtAt: 1, notes: [] });
  }));
  const pendingA = refreshActiveVault({ profileId: "inflight", rootUri: "file:///a" });
  await vi.waitFor(() => expect(finishA).toBeTypeOf("function"));
  await refreshActiveVault({ profileId: "inflight", rootUri: "file:///b" });
  expect(refreshNoteIndex).toHaveBeenCalledTimes(2);
  expect(loadCachedNoteIndex).toHaveBeenCalledWith("inflight", { uri: "file:///b", fs: {} });
  finishA();
  await pendingA;
  expect(loadCachedNoteIndex).toHaveBeenLastCalledWith("inflight", { uri: "file:///a", fs: {} });
});
