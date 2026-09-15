import { getSettings } from "./settings";
import { captureVaultContext } from "./vaultContext";
import { refreshNoteIndex } from "./vault";
import { createVaultRefreshCoordinator } from "./vaultRefreshCoordinator";

const coordinator = createVaultRefreshCoordinator(Date.now);

/** Reconcile the profile active when this call begins. Never throws to UI callers. */
export async function refreshActiveVault(): Promise<void> {
  const context = captureVaultContext(await getSettings());
  await coordinator.refresh(context.profileId, async () => {
    await refreshNoteIndex(context.profileId);
  });
}
