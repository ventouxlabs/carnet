import { describe, expect, it, vi, beforeEach } from "vitest";

// react-native isn't loadable in Node — stub the pieces captureNotification
// reaches for. Each describe block overrides Platform and NativeModules
// before re-importing the facade so we exercise the runtime-environment
// branches in isolation.

function mockReactNative(opts: {
  osPlatform: "android" | "ios";
  hasNative: boolean;
  permGranted?: boolean;
}) {
  const setVaultContext = vi.fn().mockResolvedValue(true);
  const clearVaultContext = vi.fn().mockResolvedValue(true);
  const completeDriveInboxReceipt = vi.fn().mockResolvedValue(true);
  const releaseDriveInboxReceiptForRetry = vi.fn().mockResolvedValue(true);
  vi.doMock("react-native", () => {
    const PermissionsAndroid = {
      PERMISSIONS: { POST_NOTIFICATIONS: "android.permission.POST_NOTIFICATIONS" },
      RESULTS: { GRANTED: "granted", DENIED: "denied", NEVER_ASK_AGAIN: "never_ask_again" },
      request: vi.fn().mockResolvedValue(opts.permGranted ? "granted" : "denied"),
      check: vi.fn().mockResolvedValue(opts.permGranted ?? false),
    };
    const native = opts.hasNative
      ? {
          CaptureNotification: {
            start: vi.fn().mockResolvedValue(true),
            stop: vi.fn().mockResolvedValue(true),
            isEnabled: vi.fn().mockResolvedValue(false),
            setVaultContext,
            clearVaultContext,
            completeDriveInboxReceipt,
            releaseDriveInboxReceiptForRetry,
          },
        }
      : {};
    return {
      NativeModules: native,
      PermissionsAndroid,
      Platform: { OS: opts.osPlatform, Version: 33 },
    };
  });
  return { setVaultContext, clearVaultContext, completeDriveInboxReceipt, releaseDriveInboxReceiptForRetry };
}

beforeEach(() => {
  vi.resetModules();
});

describe("captureNotification facade", () => {
  it("isAvailable() returns false on iOS even if a CaptureNotification module is present", async () => {
    mockReactNative({ osPlatform: "ios", hasNative: true });
    const mod = await import("./captureNotification");
    expect(mod.isAvailable()).toBe(false);
  });

  it("isAvailable() returns false when the native module is missing (Expo Go path)", async () => {
    mockReactNative({ osPlatform: "android", hasNative: false });
    const mod = await import("./captureNotification");
    expect(mod.isAvailable()).toBe(false);
  });

  it("isAvailable() returns true when the native module is registered on Android", async () => {
    mockReactNative({ osPlatform: "android", hasNative: true });
    const mod = await import("./captureNotification");
    expect(mod.isAvailable()).toBe(true);
  });

  it("start() throws a friendly error when the native module is missing", async () => {
    mockReactNative({ osPlatform: "android", hasNative: false });
    const mod = await import("./captureNotification");
    await expect(mod.start()).rejects.toThrow(/not available/);
  });

  it("stop() is a no-op when the native module is missing (defensive cleanup paths)", async () => {
    mockReactNative({ osPlatform: "android", hasNative: false });
    const mod = await import("./captureNotification");
    await expect(mod.stop()).resolves.toBeUndefined();
  });

  it("isEnabled() returns false when the native module is missing", async () => {
    mockReactNative({ osPlatform: "android", hasNative: false });
    const mod = await import("./captureNotification");
    await expect(mod.isEnabled()).resolves.toBe(false);
  });

  it("persists a non-secret vault context through the Android bridge", async () => {
    const native = mockReactNative({ osPlatform: "android", hasNative: true });
    const mod = await import("./captureNotification");

    await mod.setVaultContext("work", "content://provider/tree/work");

    expect(native.setVaultContext).toHaveBeenCalledWith(
      "work",
      "content://provider/tree/work",
    );
  });

  it("does not need a bridge to synchronize context outside a native Android build", async () => {
    mockReactNative({ osPlatform: "ios", hasNative: false });
    const mod = await import("./captureNotification");

    await expect(mod.setVaultContext("default", "")).resolves.toBeUndefined();
    await expect(mod.clearVaultContext()).resolves.toBeUndefined();
  });

  it("clears native routing before a vault transition", async () => {
    const native = mockReactNative({ osPlatform: "android", hasNative: true });
    const mod = await import("./captureNotification");

    await mod.clearVaultContext();

    expect(native.clearVaultContext).toHaveBeenCalledOnce();
  });

  it("returns native Drive Inbox completion status", async () => {
    const native = mockReactNative({ osPlatform: "android", hasNative: true });
    const mod = await import("./captureNotification");

    await expect(mod.completeDriveInboxReceipt("receipt-1234567890")).resolves.toBe(true);
    expect(native.completeDriveInboxReceipt).toHaveBeenCalledWith("receipt-1234567890");
  });

  it("releases only a receipt's native retry latch", async () => {
    const native = mockReactNative({ osPlatform: "android", hasNative: true });
    const mod = await import("./captureNotification");

    await expect(mod.releaseDriveInboxReceiptForRetry("receipt-1234567890")).resolves.toBe(true);
    expect(native.releaseDriveInboxReceiptForRetry).toHaveBeenCalledWith("receipt-1234567890");
  });

  it("rejects a missing profile id without mutating native state", async () => {
    const native = mockReactNative({ osPlatform: "android", hasNative: true });
    const mod = await import("./captureNotification");

    await expect(mod.setVaultContext("   ", "file:///vault")).rejects.toThrow(/profile id/i);
    expect(native.setVaultContext).not.toHaveBeenCalled();
  });

  it("requestPermission() returns false on iOS without prompting", async () => {
    mockReactNative({ osPlatform: "ios", hasNative: false });
    const mod = await import("./captureNotification");
    await expect(mod.requestPermission()).resolves.toBe(false);
  });

  it("requestPermission() returns true when user grants on Android 13+", async () => {
    mockReactNative({ osPlatform: "android", hasNative: true, permGranted: true });
    const mod = await import("./captureNotification");
    await expect(mod.requestPermission()).resolves.toBe(true);
  });

  it("requestPermission() returns false when user denies", async () => {
    mockReactNative({ osPlatform: "android", hasNative: true, permGranted: false });
    const mod = await import("./captureNotification");
    await expect(mod.requestPermission()).resolves.toBe(false);
  });

  it("permissionIsGranted() reflects PermissionsAndroid.check on Android 13+", async () => {
    mockReactNative({ osPlatform: "android", hasNative: true, permGranted: true });
    const mod = await import("./captureNotification");
    await expect(mod.permissionIsGranted()).resolves.toBe(true);
  });

  it("permissionIsGranted() returns false on iOS (no Android permission concept)", async () => {
    mockReactNative({ osPlatform: "ios", hasNative: false });
    const mod = await import("./captureNotification");
    await expect(mod.permissionIsGranted()).resolves.toBe(false);
  });
});
