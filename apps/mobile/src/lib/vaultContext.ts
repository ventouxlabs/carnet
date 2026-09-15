/**
 * Immutable vault routing captured at the start of a user operation.
 *
 * Never retain a mutable Settings object across an await: a profile switch is
 * allowed while enrichment, queueing, or package creation is in flight. This
 * value carries both the registration id (for per-profile app state) and the
 * resolved-at-start root URI (for durable file routing after that switch).
 */

import {
  activeVaultProfile,
  normaliseVaultProfileState,
  type VaultProfile,
} from "./vaultProfiles";

export interface VaultContext {
  profileId: string;
  rootUri: string;
}

type SettingsVaultSlice = {
  vaultProfiles?: VaultProfile[];
  activeVaultProfileId?: string;
  captureFolderPath: string;
};

/** Capture a frozen routing snapshot. It does no IO and never changes profiles. */
export function captureVaultContext(settings: SettingsVaultSlice): VaultContext {
  const state = normaliseVaultProfileState({
    profiles: settings.vaultProfiles,
    activeProfileId: settings.activeVaultProfileId,
    legacyCaptureFolderPath: settings.captureFolderPath,
  });
  const active = activeVaultProfile(state);
  return Object.freeze({ profileId: active.id, rootUri: active.rootUri });
}

/** A context persisted with work queues must be structurally valid before use. */
export function isVaultContext(value: unknown): value is VaultContext {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.profileId === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate.profileId) &&
    typeof candidate.rootUri === "string"
  );
}
