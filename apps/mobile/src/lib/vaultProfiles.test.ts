import { describe, expect, it } from "vitest";

import {
  activeVaultProfile,
  addVaultProfile,
  defaultVaultProfile,
  normaliseVaultProfileState,
  removeVaultProfile,
  setActiveVaultProfile,
} from "./vaultProfiles";

describe("vault profiles", () => {
  it("migrates the legacy root into one stable default registration", () => {
    const state = normaliseVaultProfileState({
      legacyCaptureFolderPath: " content://provider/tree/primary%3ACarnet ",
    });
    expect(state).toEqual({
      profiles: [{ ...defaultVaultProfile("content://provider/tree/primary%3ACarnet") }],
      activeProfileId: "default",
    });
  });

  it("is idempotent and keeps a valid active profile", () => {
    const input = {
      profiles: [
        { id: "personal", name: " Personal ", rootUri: " file:///one ", createdAt: 5 },
        { id: "personal", name: "duplicate", rootUri: "file:///two", createdAt: 6 },
        { id: "bad id", name: "Invalid", rootUri: "file:///three" },
      ],
      activeProfileId: "personal",
      legacyCaptureFolderPath: "file:///legacy",
    };
    const once = normaliseVaultProfileState(input);
    const twice = normaliseVaultProfileState({
      profiles: once.profiles,
      activeProfileId: once.activeProfileId,
      legacyCaptureFolderPath: "file:///legacy",
    });
    expect(twice).toEqual(once);
    expect(activeVaultProfile(twice)).toMatchObject({
      id: "personal",
      name: "Personal",
      rootUri: "file:///one",
    });
  });

  it("falls back safely for corrupt data and cannot remove the final profile", () => {
    const state = normaliseVaultProfileState({
      profiles: "not an array",
      activeProfileId: "missing",
      legacyCaptureFolderPath: "",
    });
    expect(removeVaultProfile(state, "default")).toBe(state);
  });

  it("removes only registration metadata and switches from a removed active profile", () => {
    const state = normaliseVaultProfileState({
      profiles: [
        { id: "personal", name: "Personal", rootUri: "file:///one", createdAt: 1 },
        { id: "work", name: "Work", rootUri: "file:///two", createdAt: 2 },
      ],
      activeProfileId: "work",
    });
    expect(removeVaultProfile(state, "work")).toEqual({
      profiles: [state.profiles[0]],
      activeProfileId: "personal",
    });
  });

  it("adds and switches registrations without replacing an existing root", () => {
    const initial = normaliseVaultProfileState({ legacyCaptureFolderPath: "file:///personal" });
    const withWork = addVaultProfile(initial, {
      id: "work", name: "Work", rootUri: "file:///work", createdAt: 2,
    });
    expect(activeVaultProfile(setActiveVaultProfile(withWork, "work"))).toMatchObject({
      id: "work", rootUri: "file:///work",
    });
    expect(() => addVaultProfile(withWork, {
      id: "work", name: "Replacement", rootUri: "file:///other", createdAt: 3,
    })).toThrow("already exists");
    expect(setActiveVaultProfile(withWork, "missing")).toBe(withWork);
  });
});
