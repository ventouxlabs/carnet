/**
 * JS-side facade for the persistent capture notification.
 *
 * Wraps the native CaptureNotification bridge module so callers don't have
 * to know about NativeModules quirks (missing under Expo Go, undefined
 * when the package wasn't autolinked, etc.) and the API is typed.
 *
 * Permission flow: Android 13+ gates POST_NOTIFICATIONS at runtime via a
 * manifest perm declared by the config plugin. `requestPermission()`
 * surfaces the OS dialog via the built-in PermissionsAndroid API — no new
 * dependency. Callers should request before calling `start()`; without
 * the grant the service runs but the notification is silently suppressed.
 */

import { NativeModules, PermissionsAndroid, Platform } from "react-native";

interface CaptureNotificationNative {
  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  isEnabled: () => Promise<boolean>;
  setVaultContext: (profileId: string, rootUri: string) => Promise<boolean>;
  clearVaultContext: () => Promise<boolean>;
  completeDriveInboxReceipt: (receiptId: string) => Promise<boolean>;
  releaseDriveInboxReceiptForRetry: (receiptId: string) => Promise<boolean>;
}

function getNative(): CaptureNotificationNative | null {
  // Module is Android-only; iOS will never have it registered.
  if (Platform.OS !== "android") return null;
  const mod = (NativeModules as Record<string, unknown>).CaptureNotification;
  if (!mod) return null;
  return mod as CaptureNotificationNative;
}

export function isAvailable(): boolean {
  return getNative() !== null;
}

/**
 * Trigger the OS POST_NOTIFICATIONS prompt (Android 13+). Returns true if
 * the user granted (or if the prompt isn't needed on older Android). The
 * caller should NOT start the service if this returns false — the
 * notification would be invisible.
 *
 * Uses PermissionsAndroid (built-in) rather than expo-notifications so we
 * don't pull in a new dependency for a one-shot prompt.
 */
export async function requestPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  // POST_NOTIFICATIONS landed in API 33; older devices auto-grant.
  if (typeof Platform.Version === "number" && Platform.Version < 33) return true;
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Start the foreground service and persist the toggle to native prefs. */
export async function start(): Promise<void> {
  const native = getNative();
  if (!native) {
    throw new Error(
      "Persistent notification is not available in this build (Expo Go / iOS / missing native module).",
    );
  }
  await native.start();
}

/** Stop the foreground service and clear the persisted toggle. */
export async function stop(): Promise<void> {
  const native = getNative();
  if (!native) return;
  await native.stop();
}

/** Read the native-side persisted toggle. Source of truth on Android since
 * the BootReceiver reads from the same SharedPreferences slot. */
export async function isEnabled(): Promise<boolean> {
  const native = getNative();
  if (!native) return false;
  return native.isEnabled();
}

/**
 * Persist the active vault routing snapshot for native, headless Drive Inbox
 * replies. This contains no secret material. An empty root URI is valid for
 * Carnet's app-sandbox vault; an empty profile id is not.
 */
export async function setVaultContext(profileId: string, rootUri: string): Promise<void> {
  const native = getNative();
  if (!native) return;
  const normalizedProfileId = profileId.trim();
  if (!normalizedProfileId) {
    throw new Error("A vault profile id is required for Drive Inbox capture.");
  }
  await native.setVaultContext(normalizedProfileId, rootUri);
}

/** Invalidate native Drive Inbox routing before AsyncStorage commits a new
 * active profile/root. Until setVaultContext succeeds, native replies fail
 * closed instead of writing into the prior vault. */
export async function clearVaultContext(): Promise<void> {
  const native = getNative();
  if (!native) return;
  await native.clearVaultContext();
}

/** A Drive Inbox raw note carrying this receipt is durably on disk. Native may
 * now consume its pending handoff and render the next prompt. False means the
 * receipt is no longer current, so callers leave the on-disk note untouched. */
export async function completeDriveInboxReceipt(receiptId: string): Promise<boolean> {
  const native = getNative();
  if (!native || !receiptId.trim()) return false;
  return native.completeDriveInboxReceipt(receiptId.trim());
}

/** Release only this still-current receipt's native dispatch latch after JS
 * could not write its raw note. The durable frozen payload remains intact for
 * a later retry; a stale/missing receipt is deliberately a no-op. */
export async function releaseDriveInboxReceiptForRetry(receiptId: string): Promise<boolean> {
  const native = getNative();
  if (!native || !receiptId.trim()) return false;
  return native.releaseDriveInboxReceiptForRetry(receiptId.trim());
}

/**
 * Non-prompting permission check. Used on Settings mount to detect drift
 * where the native toggle says ON but the user revoked POST_NOTIFICATIONS
 * via system settings — in that case the service runs but the notification
 * is invisible, and the UI must reconcile.
 */
export async function permissionIsGranted(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  if (typeof Platform.Version === "number" && Platform.Version < 33) return true;
  return PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
}
