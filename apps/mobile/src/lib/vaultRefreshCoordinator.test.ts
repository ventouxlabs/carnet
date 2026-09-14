import { describe, expect, it, vi } from "vitest";
import { createVaultRefreshCoordinator } from "./vaultRefreshCoordinator";

describe("vaultRefreshCoordinator", () => {
  it("coalesces focus storms and throttles each vault independently", async () => {
    let now = 0;
    const c = createVaultRefreshCoordinator(() => now, 100);
    const scan = vi.fn(async () => undefined);
    await Promise.all([c.refresh("work", scan), c.refresh("work", scan)]);
    expect(scan).toHaveBeenCalledTimes(1);
    await c.refresh("work", scan);
    await c.refresh("default", scan);
    expect(scan).toHaveBeenCalledTimes(2);
    now = 101;
    await c.refresh("work", scan);
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("keeps cached data stale on ordinary failure and marks revoked access unavailable", async () => {
    const c = createVaultRefreshCoordinator(() => 0);
    expect(await c.refresh("work", async () => { throw new Error("network hiccup"); })).toBe("stale");
    expect(await c.refresh("default", async () => { throw new Error("permission revoked"); })).toBe("unavailable");
  });
});
