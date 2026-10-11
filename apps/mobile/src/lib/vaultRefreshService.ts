import { getSettings } from "./settings";
import { captureVaultContext, type VaultContext } from "./vaultContext";
import { loadCachedNoteIndex, refreshNoteIndex, type NoteIndex } from "./vault";
import { resolveContextRoot } from "./vaultRoot";
import { createVaultRefreshCoordinator } from "./vaultRefreshCoordinator";

import { noteIndexKey } from "./vaultStorageKeys";

const coordinator = createVaultRefreshCoordinator(Date.now);

/** Reconcile the profile active when this call begins. Never throws to UI callers. */
export async function refreshActiveVault(context?: VaultContext): Promise<NoteIndex | null> {
  const captured = context ?? captureVaultContext(await getSettings());
  const root = resolveContextRoot(captured);
  await coordinator.refresh(noteIndexKey(captured.profileId, root.uri), async () => {
    await refreshNoteIndex(captured.profileId, root);
  });
  return loadCachedNoteIndex(captured.profileId, root);
}
