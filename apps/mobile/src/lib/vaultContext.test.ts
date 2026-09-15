import { describe, expect, it } from "vitest";

import { captureVaultContext, isVaultContext } from "./vaultContext";

describe("vault context", () => {
  it("pins the active profile root even if the source settings later switch", () => {
    const settings = {
      vaultProfiles: [
        { id: "personal", name: "Personal", rootUri: "file:///personal", createdAt: 1 },
        { id: "work", name: "Work", rootUri: "file:///work", createdAt: 2 },
      ],
      activeVaultProfileId: "personal",
      captureFolderPath: "file:///personal",
    };
    const context = captureVaultContext(settings);
    settings.activeVaultProfileId = "work";
    settings.captureFolderPath = "file:///work";

    expect(context).toEqual({ profileId: "personal", rootUri: "file:///personal" });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("uses the legacy folder as the default profile during staged migration", () => {
    expect(captureVaultContext({ captureFolderPath: "content://provider/tree/root" })).toEqual({
      profileId: "default",
      rootUri: "content://provider/tree/root",
    });
  });

  it("validates only queue-safe profile contexts", () => {
    expect(isVaultContext({ profileId: "work", rootUri: "file:///work" })).toBe(true);
    expect(isVaultContext({ profileId: "bad id", rootUri: "file:///work" })).toBe(false);
    expect(isVaultContext({ profileId: "work" })).toBe(false);
  });
});
