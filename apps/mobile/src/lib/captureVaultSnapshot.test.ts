import { describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({ getSettings: vi.fn() }));
vi.mock("./vaultRoot", () => ({
  resolveContextRoot: vi.fn((context: { rootUri: string }) => ({ uri: context.rootUri, fs: {} })),
}));

import { captureVaultSnapshot } from "./captureVaultSnapshot";
import { getSettings } from "./settings";

describe("captureVaultSnapshot", () => {
  it("resolves the active Work profile exactly once", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      captureFolderPath: "file:///work",
      vaultProfiles: [
        { id: "default", name: "Personal", rootUri: "file:///personal", createdAt: 0 },
        { id: "work", name: "Work", rootUri: "file:///work", createdAt: 1 },
      ],
      activeVaultProfileId: "work",
    } as Awaited<ReturnType<typeof getSettings>>);
    expect(await captureVaultSnapshot()).toEqual({
      context: { profileId: "work", rootUri: "file:///work" },
      root: { uri: "file:///work", fs: {} },
    });
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it("returns null when settings cannot be read", async () => {
    vi.mocked(getSettings).mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await captureVaultSnapshot()).toBeNull();
  });
});
