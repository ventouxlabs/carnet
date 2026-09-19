/**
 * Vault root resolution (the one place a storage backend is chosen).
 *
 * Storage paths come in two flavors — `file://...` (expo-file-system legacy)
 * and `content://...tree/...` (Storage Access Framework). The per-backend
 * branching lives behind the `VaultFs` seam in ./vaultFs; resolveRoot selects
 * a backend ONCE from the configured `captureFolderPath` setting and hands the
 * pair back, so callers (writer.ts, pairedBinaries.ts) never re-decide it.
 *
 * Lives in its own module rather than in writer.ts so both writer.ts and
 * pairedBinaries.ts can depend on it without forming an import cycle.
 */

import * as FileSystem from "expo-file-system/legacy";
import { getSettings } from "./settings";
import { vaultFsFor, type VaultFs } from "./vaultFs";
import {
  activeVaultProfile,
  normaliseVaultProfileState,
  type VaultProfile,
} from "./vaultProfiles";
import type { VaultContext } from "./vaultContext";

export interface Root {
  /** Either a `file://` URI or a `content://...tree/...` SAF tree URI. */
  uri: string;
  /** The filesystem backend selected for `uri` (SAF vs file://). */
  fs: VaultFs;
}

/**
 * The app-sandbox root used when no vault folder has been picked yet
 * (`captureFolderPath` empty). Exported as the single source of truth for
 * this computation — vaultMigration.ts needs to name this root EXPLICITLY
 * (as the pre-vault migration source) independent of whatever
 * `captureFolderPath` currently holds, so it must not recompute
 * `documentDirectory ?? fallback` itself: a drift between the two copies
 * would silently point migration at the wrong folder.
 */
export function internalVaultRoot(): Root {
  const base = FileSystem.documentDirectory ?? "file:///data/user/0/carnet/files/";
  return { uri: `${base.replace(/\/$/, "")}/carnet`, fs: vaultFsFor(false) };
}

/**
 * Resolve the root folder URI from settings.
 *   - empty / default → app sandbox carnet/
 *   - content://...tree/... → SAF tree URI as-is
 *   - anything else → treat as a file:// URI (legacy raw Android path)
 */
export function resolveProfileRoot(profile: Pick<VaultProfile, "rootUri">): Root {
  const trimmed = profile.rootUri.trim();
  if (!trimmed) {
    return internalVaultRoot();
  }
  if (trimmed.startsWith("content://")) {
    return { uri: trimmed, fs: vaultFsFor(true) };
  }
  // Best-effort: file:// or raw path. Ensure file:// prefix for FileSystem API.
  const uri = trimmed.startsWith("file://") ? trimmed : `file://${trimmed}`;
  return { uri, fs: vaultFsFor(false) };
}

/** Resolve a root from an operation's immutable profile snapshot. */
export function resolveContextRoot(context: VaultContext): Root {
  return resolveProfileRoot(context);
}

/** Resolve the active profile. Operations that can outlive a profile switch
 * call resolveProfileRoot on their captured profile instead. */
export async function resolveRoot(): Promise<Root> {
  const settings = await getSettings();
  const profileState = normaliseVaultProfileState({
    profiles: settings.vaultProfiles,
    activeProfileId: settings.activeVaultProfileId,
    legacyCaptureFolderPath: settings.captureFolderPath,
  });
  return resolveProfileRoot(
    activeVaultProfile(profileState),
  );
}
