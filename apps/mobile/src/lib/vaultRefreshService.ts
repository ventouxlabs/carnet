import { getSettings } from "./settings";
import { captureVaultContext, type VaultContext } from "./vaultContext";
import { loadCachedNoteIndex, refreshNoteIndex, type NoteIndex } from "./vault";
import { resolveContextRoot } from "./vaultRoot";
import { createVaultRefreshCoordinator } from "./vaultRefreshCoordinator";

const coordinator = createVaultRefreshCoordinator(Date.now);

/** Reconcile the profile active when this call begins. Never throws to UI callers. */
export async function refreshActiveVault(context?: VaultContext): Promise<NoteIndex | null> {
  const captured = context ?? captureVaultContext(await getSettings());
  await coordinator.refresh(captured.profileId, async () => {
    await refreshNoteIndex(captured.profileId, resolveContextRoot(captured));
  });
  return loadCachedNoteIndex(captured.profileId);
}
