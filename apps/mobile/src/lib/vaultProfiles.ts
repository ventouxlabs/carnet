/**
 * Durable vault-profile model.
 *
 * A profile is a registration for a user-owned root; it never owns the files
 * under that root. Removing a profile therefore removes only this metadata.
 * The active profile is always valid, and a legacy single root is represented
 * as the stable `default` profile without moving any files.
 */

export const DEFAULT_VAULT_PROFILE_ID = "default";

export interface VaultProfile {
  /** Stable local identifier. It is never derived from a filesystem URI. */
  id: string;
  /** User-facing label. It has no effect on filesystem routing. */
  name: string;
  /** Empty means Carnet's app-sandbox root; otherwise file://, raw, or SAF URI. */
  rootUri: string;
  createdAt: number;
}

export interface VaultProfileState {
  profiles: VaultProfile[];
  activeProfileId: string;
}

type ProfileCandidate = Partial<VaultProfile>;

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function normaliseProfile(value: ProfileCandidate): VaultProfile | null {
  if (!validId(value.id) || typeof value.rootUri !== "string") return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0;
  return {
    id: value.id,
    name: name || "Vault",
    rootUri: value.rootUri.trim(),
    createdAt,
  };
}

/** Build the stable registration used when upgrading from one vault. */
export function defaultVaultProfile(legacyRootUri = ""): VaultProfile {
  return {
    id: DEFAULT_VAULT_PROFILE_ID,
    name: "Default vault",
    rootUri: legacyRootUri.trim(),
    createdAt: 0,
  };
}

/**
 * Validate persisted profile data and migrate a legacy capture-folder path.
 *
 * This function is deliberately pure so settings migration remains retry-safe:
 * interrupted writes simply run the same normalization again. Invalid or
 * duplicate registrations are ignored, but no filesystem operation is ever
 * performed here.
 */
export function normaliseVaultProfileState(input: {
  profiles?: unknown;
  activeProfileId?: unknown;
  legacyCaptureFolderPath?: string;
}): VaultProfileState {
  const candidates = Array.isArray(input.profiles) ? input.profiles : [];
  const seen = new Set<string>();
  const profiles: VaultProfile[] = [];
  for (const candidate of candidates) {
    const profile = normaliseProfile(candidate as ProfileCandidate);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }

  if (profiles.length === 0) {
    profiles.push(defaultVaultProfile(input.legacyCaptureFolderPath));
  }

  const requested = input.activeProfileId;
  const activeProfileId =
    typeof requested === "string" && profiles.some((p) => p.id === requested)
      ? requested
      : profiles[0].id;
  return { profiles, activeProfileId };
}

/** Return a frozen routing snapshot for an operation started in this profile. */
export function activeVaultProfile(state: VaultProfileState): VaultProfile {
  return state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0];
}

/**
 * Remove only a registration. The final profile cannot be removed, and if the
 * active registration is removed the first surviving profile becomes active.
 */
export function removeVaultProfile(
  state: VaultProfileState,
  profileId: string,
): VaultProfileState {
  if (state.profiles.length <= 1 || !state.profiles.some((p) => p.id === profileId)) {
    return state;
  }
  const profiles = state.profiles.filter((p) => p.id !== profileId);
  return {
    profiles,
    activeProfileId:
      state.activeProfileId === profileId ? profiles[0].id : state.activeProfileId,
  };
}
