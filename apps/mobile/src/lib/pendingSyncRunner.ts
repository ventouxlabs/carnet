/**
 * Real-dependency bindings for the pending-sync drain.
 *
 * lib/pendingSync.ts owns the queue + drain ORCHESTRATION with injected deps;
 * this module supplies the production ones — Settings for the Karakeep base
 * URL, the reachability probe, and the note-export pipeline — and is what the
 * app triggers (App.tsx on foreground, HomeScreen's Retry button).
 */

import { getSettings } from "./settings";
import { isVaultContext, type VaultContext } from "./vaultContext";
import { resolveContextRoot } from "./vaultRoot";
import { DEFAULT_VAULT_PROFILE_ID, defaultVaultProfile, normaliseVaultProfileState } from "./vaultProfiles";
import { isHostReachable } from "./hostReachability";
import { getModificationTime, readNote } from "./writer";
import { exportNoteToKarakeep } from "./karakeepNoteExport";
import {
  drainPendingExports,
  type PendingExport,
  type PendingExportResult,
} from "./pendingSync";

/**
 * Attempt one queued export against the live pipeline and classify the result
 * for the drain. The note body is re-read from disk so the freshest text is
 * exported. A read failure is `gone` only when deletion can be CONFIRMED
 * (file:// with no file behind it) — a transient read error (SAF permission
 * hiccup, I/O) must burn an attempt and retry, never silently drop the
 * export. SAF content:// can't confirm existence (getModificationTime is
 * always null there), so its read failures always take the retry path; a
 * truly-deleted SAF note drops at the attempts cap instead.
 */
async function exportPendingItem(
  item: PendingExport,
): Promise<PendingExportResult> {
  let body: string;
  try {
    body = await readNote(item.filepath);
  } catch (e: unknown) {
    const confirmedGone =
      !item.filepath.startsWith("content://") &&
      (await getModificationTime(item.filepath)) === null;
    if (confirmedGone) return { kind: "gone" };
    const message = e instanceof Error ? e.message : String(e);
    return { kind: "error", message: `note read failed: ${message}` };
  }
  // Legacy rows predate the context field. They belong to the original
  // default/legacy vault, not whichever profile happens to be active when a
  // later drain runs. New rows always carry the frozen context below.
  let vaultContext: VaultContext;
  if (isVaultContext(item.vaultContext)) {
    vaultContext = item.vaultContext;
  } else {
    const settings = await getSettings();
    const state = normaliseVaultProfileState({
      profiles: settings.vaultProfiles,
      activeProfileId: settings.activeVaultProfileId,
      legacyCaptureFolderPath: settings.captureFolderPath,
    });
    const legacy = state.profiles.find((profile) => profile.id === DEFAULT_VAULT_PROFILE_ID)
      ?? defaultVaultProfile(settings.captureFolderPath);
    vaultContext = { profileId: legacy.id, rootUri: legacy.rootUri };
  }
  const outcome = await exportNoteToKarakeep({
    body,
    filepath: item.filepath,
    entryTitle: item.entryTitle,
    rootOverride: resolveContextRoot(vaultContext),
  });
  if (outcome.kind === "failed") {
    return outcome.unreachable
      ? { kind: "unreachable" }
      : { kind: "error", message: outcome.reason };
  }
  // `partial` still counts as delivered: the bookmark exists and the note is
  // stamped with its id — the attachment gap is a re-export concern, not a
  // connectivity one, and retrying here would spin on a server-side reject.
  return { kind: "ok" };
}

/**
 * Run one pending-export drain pass against the configured Karakeep host.
 * No-op (leaving the queue intact) when no Karakeep URL is configured —
 * queued items should survive until the user restores their Settings.
 * Never throws: triggers are fire-and-forget UI/AppState paths.
 */
export async function drainPendingKarakeepExports(): Promise<void> {
  try {
    const { karakeepUrl } = await getSettings();
    const baseUrl = karakeepUrl.trim();
    if (!baseUrl) return;
    await drainPendingExports({
      isReachable: () => isHostReachable(baseUrl),
      exportOne: exportPendingItem,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[PendingSync] drain failed:", msg);
  }
}
