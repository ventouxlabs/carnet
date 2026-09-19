/** Resolve the vault once at the start of a multi-await capture operation. */
import { getSettings } from "./settings";
import { captureVaultContext, type VaultContext } from "./vaultContext";
import { resolveContextRoot, type Root } from "./vaultRoot";

export interface CaptureVaultSnapshot {
  context: VaultContext;
  root: Root;
}

/** Settings failures are recoverable: existing writers retain active-root fallback. */
export async function captureVaultSnapshot(): Promise<CaptureVaultSnapshot | null> {
  try {
    const context = captureVaultContext(await getSettings());
    return { context, root: resolveContextRoot(context) };
  } catch {
    return null;
  }
}
