// ⚠️  CI DOES NOT COMPILE THE KOTLIN BELOW BY DEFAULT.
// The Kotlin emitted from this file is generated at `expo prebuild` time into
// the gitignored android/ tree. vitest + `tsc --noEmit` (the only checks in the
// required `gate` CI job) never see it, so an invalid override signature or type
// error here compiles clean in CI and only fails on a real Gradle build. This
// exact trap shipped once: `getTaskConfig(intent: Intent)` should be
// `getTaskConfig(intent: Intent?)` — the base HeadlessJsTaskService signature is
// nullable — and it broke every clean prebuild until caught on-device.
// There IS a `mobile-android` CI job (.github/workflows/ci.yml) that runs a real
// prebuild + `:app:compileDebugKotlin`, but it is currently non-blocking (not in
// `gate.needs`). Until it is promoted to a required check, BEFORE MERGING any
// change to the Kotlin templates in this file you MUST manually run:
//   cd apps/mobile && npx expo prebuild --clean -p android \
//     && cd android && ./gradlew :app:compileDebugKotlin
// and confirm BUILD SUCCESSFUL.
//
// TODO(plugin-cleanup): Kotlin templates are embedded as JS strings here
// for expedience. Future refactor: move to plugins/templates/notification/*.kt
// and render via __PACKAGE__ placeholder substitution. Defer until we have a
// real reason to edit one of these files — current cost is grep+edit, no
// behavior gain from extracting now.
//
// Persistent capture notification — foreground-service-backed.
//
// Emits the Kotlin sources + manifest declarations + MainApplication
// package registration needed for a "Pull down notification shade →
// 4-button quick capture" surface that survives reboot.
//
// Three modifier stages:
//   1. withAndroidManifest — add <service>, <receiver>, and 4 permissions.
//      Idempotent — won't double-add on re-prebuild.
//   2. withMainApplication — inject `add(CaptureNotificationPackage())`
//      into the React getPackages() return list so the RN bridge module
//      is discoverable from JS.
//   3. withDangerousMod — write the actual Kotlin files + audio icon
//      drawable into android/app/src/main/java/{...}/notification/ and
//      android/app/src/main/res/drawable/.
//
// The service uses foregroundServiceType="specialUse" because the standard
// Android 14+ service types (dataSync, mediaPlayback, ...) don't fit a
// "UI-shortcut notification" use case. specialUse + the property tag is
// the right pick for sideloaded apps. Play Store path would need different
// design (see plan).
//
// All emitted Kotlin lives under the configured Android package's notification namespace — that
// package path is built from app.json's android.package so a rebrand /
// fork doesn't silently break the manifest references.

const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require('@expo/config-plugins');

// graphic_eq Material icon — audio waveform bars. Visually distinct from
// shortcut_journal's microphone (which represents voice-to-text capture,
// not raw audio).
const SHORTCUT_AUDIO_PATH_DATA =
  'M7,18h2L9,6L7,6v12zM11,22h2L13,2h-2v20zM3,14h2v-4L3,10v4zM15,18h2L17,6h-2v12zM19,10v4h2v-4h-2z';
const PRIMARY_COLOR = '#5E63FF';

function buildVectorDrawable(pathData) {
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <path
      android:fillColor="${PRIMARY_COLOR}"
      android:pathData="${pathData}" />
</vector>
`;
}

function captureForegroundServiceKt(packageName) {
  return `package ${packageName}.notification

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import ${packageName}.R
import java.util.UUID

/**
 * Foreground service that hosts a persistent 4-button capture notification.
 *
 * One channel ("carnet_capture", IMPORTANCE_LOW — no sound/vibration). The
 * notification is built once on start; it never updates because the buttons
 * are static (deep-link targets don't change). The service idles after
 * startForeground() — no wake locks, no timers, no listeners.
 *
 * Stop path: a second startService with action = ACTION_STOP. The module
 * calls this when the user flips the Settings toggle off.
 */
class CaptureForegroundService : Service() {
  companion object {
    const val CHANNEL_ID = "carnet_capture"
    const val NOTIFICATION_ID = 1042
    const val ACTION_STOP = "${packageName}.CAPTURE_STOP"
    const val ACTION_REFRESH_DRIVE_INBOX = "${packageName}.REFRESH_DRIVE_INBOX"
    const val KEY_DRIVE_INBOX_PROMPT_AT = "drive_inbox_prompt_at"
    const val KEY_DRIVE_INBOX_RECEIPT_ID = "drive_inbox_receipt_id"
    const val KEY_DRIVE_INBOX_LAST_READ_AT = "drive_inbox_last_read_at"
    const val KEY_DRIVE_INBOX_PENDING_RECEIPT_ID = "drive_inbox_pending_receipt_id"
    const val KEY_DRIVE_INBOX_PENDING_TEXT = "drive_inbox_pending_text"
    const val KEY_DRIVE_INBOX_PENDING_PROFILE_ID = "drive_inbox_pending_profile_id"
    const val KEY_DRIVE_INBOX_PENDING_ROOT_URI = "drive_inbox_pending_root_uri"
    const val KEY_DRIVE_INBOX_PENDING_DISPATCHING = "drive_inbox_pending_dispatching"
    /** Shared with the action service so receipt acceptance and rendering
     * cannot interleave inside this process. */
    val DRIVE_INBOX_LOCK = Any()
  }

  override fun onCreate() {
    super.onCreate()
    // The pending-dispatching flag means a Headless JS task was started in this app
    // process. A recreated foreground service can only safely retry after that
    // process has gone away; the receipt marker and JS in-process de-dupe make
    // the normal restart path idempotent. Reset the persisted latch here, not
    // on every notification refresh, so an already-running task is never
    // redispatched by a routine render.
    synchronized(DRIVE_INBOX_LOCK) {
      getSharedPreferences(CaptureNotificationModule.PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(KEY_DRIVE_INBOX_PENDING_DISPATCHING, false)
        .commit()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    ensureChannel()
    if (intent?.action == ACTION_REFRESH_DRIVE_INBOX) {
      // A stale notification action can arrive after Android killed the
      // service. In that case the broadcast must start a foreground service,
      // which in turn MUST call startForeground promptly; notify() alone
      // violates that contract. Calling it again for an already-running
      // foreground service is also the supported way to replace its content.
      startForeground(NOTIFICATION_ID, buildNotification())
      resumePendingDriveInboxHandoff()
      return START_STICKY
    }
    startForeground(NOTIFICATION_ID, buildNotification())
    resumePendingDriveInboxHandoff()
    // START_STICKY so the OS re-creates the service if it kills it for
    // resources — the user opted into "always available" by flipping the
    // toggle on, and the service costs nothing while idle.
    return START_STICKY
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Capture",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Persistent quick-capture shortcuts"
        setShowBadge(false)
      }
      val mgr = getSystemService(NotificationManager::class.java)
      mgr?.createNotificationChannel(channel)
    }
  }

  /** A pending receipt is durable until JS confirms its raw write. A newly
   * created foreground service clears the old process's dispatch latch before
   * this asks the private action service to retry it. */
  private fun resumePendingDriveInboxHandoff() {
    val pending = getSharedPreferences(CaptureNotificationModule.PREFS_NAME, Context.MODE_PRIVATE)
      .getString(KEY_DRIVE_INBOX_PENDING_RECEIPT_ID, null)
      .orEmpty()
    if (pending.isEmpty()) return
    try {
      startService(Intent(this, DriveInboxActionService::class.java).apply {
        action = DriveInboxActionService.ACTION_DELIVER_PENDING
        setPackage(packageName)
      })
    } catch (e: Exception) {
      android.util.Log.w("CarnetDriveInbox", "Failed to resume pending handoff: \${e.message}")
    }
  }

  private fun captureIntent(uri: String, requestCode: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    // FLAG_IMMUTABLE is mandatory on Android 12+ for PendingIntents that
    // don't need post-creation mutation. UPDATE_CURRENT keeps the same
    // PendingIntent slot but refreshes the embedded Intent extras.
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    return PendingIntent.getActivity(this, requestCode, intent, flags)
  }

  /**
   * "Quick idea" inline-reply action (B5). A RemoteInput lets the user type an
   * idea directly in the notification shade — zero app open — and QuickIdeaReceiver
   * hands it to the save-first headless task.
   *
   * Direct replies require a mutable PendingIntent on Android 12+, but the
   * intent remains explicit and the receiver remains non-exported. That limits
   * mutation to RemoteInput's OS-delivered result rather than allowing another
   * app to redirect the action to a different component.
   */
  private fun quickIdeaAction(): NotificationCompat.Action {
    val remoteInput = RemoteInput.Builder(QuickIdeaReceiver.KEY_QUICK_IDEA)
      .setLabel("Quick idea")
      .build()
    val intent = Intent(this, QuickIdeaReceiver::class.java).apply {
      action = QuickIdeaReceiver.ACTION_QUICK_IDEA
      setPackage(packageName)
    }
    val pi = PendingIntent.getBroadcast(
      this,
      5,
      intent,
      PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Action.Builder(R.drawable.shortcut_idea, "Quick idea", pi)
      .addRemoteInput(remoteInput)
      .setAllowGeneratedReplies(false)
      .build()
  }

  /** Android Auto pilot: one self-conversation, not a vault browser. The reply
   * is delivered directly to a private Service, as required by Android Auto's
   * messaging notification contract. The service then starts the same
   * save-first headless capture task as QuickIdeaReceiver. */
  private fun driveInboxReplyAction(state: DriveInboxState): NotificationCompat.Action {
    val remoteInput = RemoteInput.Builder(QuickIdeaReceiver.KEY_QUICK_IDEA)
      .setLabel("Dictate a note")
      .build()
    val intent = Intent(this, DriveInboxActionService::class.java).apply {
      action = DriveInboxActionService.ACTION_REPLY
      setPackage(packageName)
      // PendingIntent identity includes data. Do not use UPDATE_CURRENT here:
      // a car host may retain an old action, and replacing its extras would let
      // that old action impersonate the newly rendered receipt.
      data = Uri.parse("carnet://drive-inbox/\${state.receiptId}/reply")
      putExtra(DriveInboxActionService.EXTRA_RECEIPT_ID, state.receiptId)
    }
    val pi = PendingIntent.getService(
      this,
      6,
      intent,
      PendingIntent.FLAG_MUTABLE,
    )
    return NotificationCompat.Action.Builder(R.drawable.shortcut_idea, "Reply", pi)
      .addRemoteInput(remoteInput)
      .setAllowGeneratedReplies(true)
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      .setShowsUserInterface(false)
      .build()
  }

  private fun driveInboxMarkReadAction(state: DriveInboxState): NotificationCompat.Action {
    val intent = Intent(this, DriveInboxActionService::class.java).apply {
      action = DriveInboxActionService.ACTION_MARK_READ
      setPackage(packageName)
      data = Uri.parse("carnet://drive-inbox/\${state.receiptId}/mark-read")
      putExtra(DriveInboxActionService.EXTRA_RECEIPT_ID, state.receiptId)
    }
    val pi = PendingIntent.getService(
      this,
      7,
      intent,
      PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Action.Builder(R.drawable.shortcut_idea, "Mark read", pi)
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
      .setShowsUserInterface(false)
      .build()
  }

  private data class DriveInboxState(
    val promptAt: Long,
    val receiptId: String,
    val unread: Boolean,
  )

  /**
   * The Drive Inbox prompt is a single persisted message, not a freshly
   * timestamped unread message every time the notification is rebuilt. Without
   * this state, mark-read only writes a preference which the MessagingStyle
   * immediately ignores on refresh.
   */
  private fun driveInboxState(): DriveInboxState {
    val prefs = getSharedPreferences(CaptureNotificationModule.PREFS_NAME, Context.MODE_PRIVATE)
    synchronized(DRIVE_INBOX_LOCK) {
      var promptAt = prefs.getLong(KEY_DRIVE_INBOX_PROMPT_AT, 0L)
      var receiptId = prefs.getString(KEY_DRIVE_INBOX_RECEIPT_ID, null).orEmpty()
      // Older installs have a timestamp but no receipt. Treat that legacy
      // prompt as spent and render a fresh, action-addressable prompt.
      if (promptAt == 0L || receiptId.isEmpty()) {
        promptAt = System.currentTimeMillis()
        receiptId = UUID.randomUUID().toString()
        prefs.edit()
          .putLong(KEY_DRIVE_INBOX_PROMPT_AT, promptAt)
          .putString(KEY_DRIVE_INBOX_RECEIPT_ID, receiptId)
          .putLong(KEY_DRIVE_INBOX_LAST_READ_AT, 0L)
          .commit()
      }
      val lastReadAt = prefs.getLong(KEY_DRIVE_INBOX_LAST_READ_AT, 0L)
      return DriveInboxState(promptAt, receiptId, lastReadAt < promptAt)
    }
  }

  private fun driveInboxStyle(state: DriveInboxState): NotificationCompat.MessagingStyle {
    val self = Person.Builder().setName("You").setKey("carnet:self").build()
    val inbox = Person.Builder().setName("Drive Inbox").setKey("carnet:drive-inbox").build()
    val style = NotificationCompat.MessagingStyle(self)
      .setConversationTitle("Drive Inbox")
      .setGroupConversation(false)
    // Once acknowledged, omit the prompt rather than re-creating it as an
    // unread message. Its actions are omitted too: their receipt is spent.
    if (state.unread) {
      style.addMessage(
        NotificationCompat.MessagingStyle.Message(
          "Dictate a note to yourself.",
          state.promptAt,
          inbox,
        ),
      )
    }
    return style
  }

  private fun buildNotification(): Notification {
    val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse("carnet://")).apply {
      setPackage(packageName)
    }
    val launchPi = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    val driveInbox = driveInboxState()
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.shortcut_idea)
      .setContentTitle("Carnet")
      .setContentText(
        if (driveInbox.unread) "Drive Inbox ready for a voice note" else "Drive Inbox is caught up",
      )
      .setNumber(if (driveInbox.unread) 1 else 0)
      .setContentIntent(launchPi)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setStyle(driveInboxStyle(driveInbox))
      .apply {
        if (driveInbox.unread) {
          addAction(driveInboxReplyAction(driveInbox))
          addAction(driveInboxMarkReadAction(driveInbox))
        }
      }
      .addAction(quickIdeaAction())
      .addAction(R.drawable.shortcut_idea, "Idea", captureIntent("carnet://capture/idea", 1))
      .addAction(R.drawable.shortcut_journal, "Journal", captureIntent("carnet://capture/journal", 2))
      .addAction(R.drawable.shortcut_photo, "Photo", captureIntent("carnet://photo", 3))
      .addAction(R.drawable.shortcut_audio, "Audio", captureIntent("carnet://audio", 4))
      .build()
  }
}
`;
}

function captureNotificationModuleKt(packageName) {
  return `package ${packageName}.notification

import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * RN bridge for the capture notification. start() launches the foreground
 * service and persists the toggle state to native SharedPreferences;
 * BootReceiver reads that prefs slot to decide whether to re-launch on
 * boot. AsyncStorage's SQLite-backed data isn't accessible from a
 * BroadcastReceiver's short-lived context, so we keep a parallel native
 * flag.
 */
class CaptureNotificationModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val PREFS_NAME = "carnet_native"
    const val KEY_ENABLED = "persistent_notification_enabled"
    const val KEY_DRIVE_INBOX_PROFILE_ID = "drive_inbox_profile_id"
    const val KEY_DRIVE_INBOX_ROOT_URI = "drive_inbox_root_uri"
  }

  override fun getName() = "CaptureNotification"

  @ReactMethod
  fun start(promise: Promise) {
    val ctx = reactApplicationContext
    val intent = Intent(ctx, CaptureForegroundService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(KEY_ENABLED, true)
        .apply()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_START_FAIL", e.message ?: "Failed to start service", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val ctx = reactApplicationContext
    val intent = Intent(ctx, CaptureForegroundService::class.java).apply {
      action = CaptureForegroundService.ACTION_STOP
    }
    try {
      ctx.startService(intent)
      ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(KEY_ENABLED, false)
        .apply()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("E_STOP_FAIL", e.message ?: "Failed to stop service", e)
    }
  }

  @ReactMethod
  fun isEnabled(promise: Promise) {
    val enabled = reactApplicationContext
      .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getBoolean(KEY_ENABLED, false)
    promise.resolve(enabled)
  }

  /**
   * Mirrors the active vault's non-secret routing context into native prefs.
   * A headless notification reply cannot safely await AsyncStorage and must
   * never guess a profile after a foreground switch. commit() makes a resolved
   * JS promise mean that the next native receipt can read this exact context.
   */
  @ReactMethod
  fun setVaultContext(profileId: String, rootUri: String, promise: Promise) {
    val normalizedProfileId = profileId.trim()
    if (normalizedProfileId.isEmpty()) {
      promise.reject("E_VAULT_CONTEXT", "Vault profile id is required")
      return
    }
    val committed = reactApplicationContext
      .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_DRIVE_INBOX_PROFILE_ID, normalizedProfileId)
      // The default app-sandbox vault intentionally has an empty root URI;
      // absence is represented by a null preference, not an empty string.
      .putString(KEY_DRIVE_INBOX_ROOT_URI, rootUri)
      .commit()
    if (committed) {
      promise.resolve(true)
    } else {
      promise.reject("E_VAULT_CONTEXT", "Failed to persist vault context")
    }
  }

  /** Remove receipt routing before Settings persists a different active vault.
   * This deliberately fails closed: a headless reply without both values is
   * dropped rather than using the previous vault while AsyncStorage changes. */
  @ReactMethod
  fun clearVaultContext(promise: Promise) {
    val committed = reactApplicationContext
      .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(KEY_DRIVE_INBOX_PROFILE_ID)
      .remove(KEY_DRIVE_INBOX_ROOT_URI)
      .commit()
    if (committed) {
      promise.resolve(true)
    } else {
      promise.reject("E_VAULT_CONTEXT", "Failed to clear vault context")
    }
  }

  /** JS calls this immediately after the raw receipt-marked note is durable.
   * Only then is the old receipt consumed and a new unread prompt rendered. */
  @ReactMethod
  fun completeDriveInboxReceipt(receiptId: String, promise: Promise) {
    val normalizedReceiptId = receiptId.trim()
    if (normalizedReceiptId.isEmpty()) {
      promise.resolve(false)
      return
    }
    val prefs = reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val committed = synchronized(CaptureForegroundService.DRIVE_INBOX_LOCK) {
      val currentReceipt = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_RECEIPT_ID, null)
      val pendingReceipt = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_RECEIPT_ID, null)
      if (currentReceipt != normalizedReceiptId || pendingReceipt != normalizedReceiptId) {
        false
      } else {
        prefs.edit()
          .putLong(CaptureForegroundService.KEY_DRIVE_INBOX_PROMPT_AT, System.currentTimeMillis())
          .putString(CaptureForegroundService.KEY_DRIVE_INBOX_RECEIPT_ID, java.util.UUID.randomUUID().toString())
          .putLong(CaptureForegroundService.KEY_DRIVE_INBOX_LAST_READ_AT, 0L)
          .remove(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_RECEIPT_ID)
          .remove(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_TEXT)
          .remove(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_PROFILE_ID)
          .remove(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_ROOT_URI)
          .remove(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_DISPATCHING)
          .commit()
      }
    }
    if (!committed) {
      promise.resolve(false)
      return
    }
    try {
      val refresh = Intent(reactApplicationContext, CaptureForegroundService::class.java).apply {
        action = CaptureForegroundService.ACTION_REFRESH_DRIVE_INBOX
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactApplicationContext.startForegroundService(refresh)
      } else {
        reactApplicationContext.startService(refresh)
      }
    } catch (e: Exception) {
      android.util.Log.w("CarnetDriveInbox", "Completed receipt but refresh failed: \${e.message}")
    }
    promise.resolve(true)
  }

  /** JS calls this only when a pending receipt could not reach a durable raw
   * write. It releases the in-process dispatch latch without changing the
   * payload or prompt, so the exact same frozen handoff can retry. */
  @ReactMethod
  fun releaseDriveInboxReceiptForRetry(receiptId: String, promise: Promise) {
    val normalizedReceiptId = receiptId.trim()
    if (normalizedReceiptId.isEmpty()) {
      promise.resolve(false)
      return
    }
    val prefs = reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val released = synchronized(CaptureForegroundService.DRIVE_INBOX_LOCK) {
      val currentReceipt = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_RECEIPT_ID, null)
      val pendingReceipt = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_RECEIPT_ID, null)
      if (currentReceipt != normalizedReceiptId || pendingReceipt != normalizedReceiptId) {
        false
      } else {
        prefs.edit()
          .putBoolean(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_DISPATCHING, false)
          .commit()
      }
    }
    promise.resolve(released)
  }
}
`;
}

function capturePackageKt(packageName) {
  return `package ${packageName}.notification

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/** ReactPackage registration for the CaptureNotification native module. */
class CaptureNotificationPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(CaptureNotificationModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
`;
}

function bootReceiverKt(packageName) {
  return `package ${packageName}.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Restarts the capture notification service after device boot — but only
 * if the user previously enabled it (persisted in native SharedPreferences
 * by CaptureNotificationModule).
 *
 * Listens to ACTION_BOOT_COMPLETED (post-unlock) AND
 * LOCKED_BOOT_COMPLETED (pre-unlock, direct-boot aware). The latter
 * delivers earlier on Android 7+. We don't care about pre-unlock UI;
 * either trigger is fine.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED &&
        action != "android.intent.action.LOCKED_BOOT_COMPLETED" &&
        action != "android.intent.action.QUICKBOOT_POWERON") {
      return
    }
    val prefs = context.getSharedPreferences(
      CaptureNotificationModule.PREFS_NAME,
      Context.MODE_PRIVATE,
    )
    if (!prefs.getBoolean(CaptureNotificationModule.KEY_ENABLED, false)) return

    val serviceIntent = Intent(context, CaptureForegroundService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(serviceIntent)
      } else {
        context.startService(serviceIntent)
      }
    } catch (e: Exception) {
      // Best-effort — boot context restrictions on Android 14+ may reject
      // the start. Log at WARN so devs can adb-logcat -s CarnetBoot:* to
      // diagnose "notification disappeared after reboot" reports.
      android.util.Log.w("CarnetBoot", "Boot restore failed: \${e.message}")
    }
  }
}
`;
}

function quickIdeaReceiverKt(packageName) {
  return `package ${packageName}.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.facebook.react.HeadlessJsTaskService

/**
 * Receives the "Quick idea" inline-reply (RemoteInput) from the capture
 * notification and hands the typed text to the save-first headless JS task —
 * WITHOUT opening the app (B5).
 *
 * Blank / whitespace-only submissions are dropped here (the JS handler guards
 * this too, defense-in-depth) so an empty reply never spins up a task or writes
 * an empty note.
 *
 * The task is started via QuickIdeaTaskService (a HeadlessJsTaskService).
 * acquireWakeLockNow keeps the CPU awake while the short-lived JS write + async
 * enrichment runs. Starting the service from a notification-action broadcast is
 * within Android's temporary background-start allowlist that a user action on a
 * notification grants.
 */
class QuickIdeaReceiver : BroadcastReceiver() {
  companion object {
    const val KEY_QUICK_IDEA = "quick_idea_text"
    const val ACTION_QUICK_IDEA = "${packageName}.QUICK_IDEA"
    const val EXTRA_TEXT = "text"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val results = RemoteInput.getResultsFromIntent(intent) ?: return
    val text = results.getCharSequence(KEY_QUICK_IDEA)?.toString()?.trim().orEmpty()
    if (text.isEmpty()) return

    val serviceIntent = Intent(context, QuickIdeaTaskService::class.java).apply {
      putExtra(EXTRA_TEXT, text)
    }
    try {
      context.startService(serviceIntent)
      HeadlessJsTaskService.acquireWakeLockNow(context)
    } catch (e: Exception) {
      android.util.Log.w("CarnetQuickIdea", "Failed to start quick-idea task: \${e.message}")
    }
  }
}
`;
}

function quickIdeaTaskServiceKt(packageName) {
  return `package ${packageName}.notification

import android.content.Intent
import android.os.Bundle
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * HeadlessJsTaskService that runs the "CarnetQuickIdea" JS task (registered in
 * index.js via registerQuickIdeaTask.ts) with the app closed. The task name here
 * MUST match QUICK_IDEA_TASK_NAME on the JS side — the two ends of the bridge.
 *
 * The 2-minute timeout covers a cold JS-runtime start plus the save-first write
 * and one async enrichment attempt; the raw note lands well before the LLM call,
 * so even a timeout can't lose the capture. allowedInForeground=true so it still
 * runs if the app happens to be foregrounded when the reply is sent.
 */
class QuickIdeaTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras: Bundle = intent?.extras ?: return null
    return HeadlessJsTaskConfig(
      "CarnetQuickIdea",
      Arguments.fromBundle(extras),
      120000L,
      true,
    )
  }
}
`;
}

function driveInboxActionServiceKt(packageName) {
  return `package ${packageName}.notification

import android.content.Context
import android.content.Intent
import android.app.Service
import android.os.IBinder
import androidx.core.app.RemoteInput
import com.facebook.react.HeadlessJsTaskService

/**
 * Handles Android Auto actions for the Drive Inbox self-conversation.
 *
 * Android Auto requires the reply and mark-as-read PendingIntents to target a
 * Service, rather than a BroadcastReceiver. The reply keeps the established
 * save-first path by forwarding RemoteInput text to QuickIdeaTaskService. A
 * durable receipt makes old/duplicate PendingIntents inert, and the vault
 * context comes from native preferences captured by Settings before the UI
 * activates that profile. Mark read only records acknowledgement state and
 * refreshes the foreground notification; it never starts JS or writes a note.
 */
class DriveInboxActionService : Service() {
  companion object {
    const val ACTION_REPLY = "${packageName}.DRIVE_INBOX_REPLY"
    const val ACTION_MARK_READ = "${packageName}.DRIVE_INBOX_MARK_READ"
    const val ACTION_DELIVER_PENDING = "${packageName}.DRIVE_INBOX_DELIVER_PENDING"
    const val EXTRA_RECEIPT_ID = "drive_inbox_receipt_id"
    const val EXTRA_PROFILE_ID = "profileId"
    const val EXTRA_ROOT_URI = "rootUri"
  }

  private data class VaultContext(val profileId: String, val rootUri: String)
  private data class PendingHandoff(
    val receiptId: String,
    val text: String,
    val vaultContext: VaultContext,
  )

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val actionIntent = intent ?: run {
      stopSelf(startId)
      return START_NOT_STICKY
    }
    when (actionIntent.action) {
      ACTION_REPLY -> handleReply(actionIntent)
      ACTION_MARK_READ -> handleMarkRead(actionIntent)
      ACTION_DELIVER_PENDING -> deliverPending()
    }
    stopSelf(startId)
    return START_NOT_STICKY
  }

  private fun handleReply(intent: Intent) {
    val results = RemoteInput.getResultsFromIntent(intent) ?: return
    val text = results.getCharSequence(QuickIdeaReceiver.KEY_QUICK_IDEA)
      ?.toString()
      ?.trim()
      .orEmpty()
    if (text.isEmpty()) return

    val receiptId = intent.getStringExtra(EXTRA_RECEIPT_ID)?.trim().orEmpty()
    if (receiptId.isEmpty()) return
    // Persist the immutable handoff before JS starts. Receipt completion is
    // deliberately deferred until JS confirms the raw receipt-marked note is
    // durable, so a task-start/process failure remains retryable.
    if (!storePendingReply(receiptId, text)) return
    deliverPending()
  }

  private fun handleMarkRead(intent: Intent) {
    val receiptId = intent.getStringExtra(EXTRA_RECEIPT_ID)?.trim().orEmpty()
    if (receiptId.isEmpty() || !claimMarkRead(receiptId)) return
    refreshDriveInbox()
  }

  /** Persist a current receipt's handoff exactly once. A duplicate action uses
   * the original text/context and never overwrites it. */
  private fun storePendingReply(receiptId: String, text: String): Boolean {
    val prefs = getSharedPreferences(CaptureNotificationModule.PREFS_NAME, Context.MODE_PRIVATE)
    synchronized(CaptureForegroundService.DRIVE_INBOX_LOCK) {
      val promptAt = prefs.getLong(CaptureForegroundService.KEY_DRIVE_INBOX_PROMPT_AT, 0L)
      val currentReceipt = prefs.getString(
        CaptureForegroundService.KEY_DRIVE_INBOX_RECEIPT_ID,
        null,
      )
      if (promptAt == 0L || currentReceipt != receiptId) return false
      val pendingReceipt = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_RECEIPT_ID, null)
      if (pendingReceipt != null) return pendingReceipt == receiptId

      val profileId = prefs.getString(CaptureNotificationModule.KEY_DRIVE_INBOX_PROFILE_ID, null)
        ?.trim()
        .orEmpty()
      val rootUri = prefs.getString(CaptureNotificationModule.KEY_DRIVE_INBOX_ROOT_URI, null)
      if (profileId.isEmpty() || rootUri == null) {
        android.util.Log.w("CarnetDriveInbox", "Dropped reply without a persisted vault context")
        return false
      }
      return prefs.edit()
        .putString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_RECEIPT_ID, receiptId)
        // User text is short-lived app-private data, not a credential. It is
        // removed in the same commit that consumes the receipt after raw write.
        .putString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_TEXT, text)
        .putString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_PROFILE_ID, profileId)
        .putString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_ROOT_URI, rootUri)
        .putBoolean(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_DISPATCHING, false)
        .commit()
    }
  }

  /** Dispatch the persisted handoff at most once per foreground-service run.
   * CaptureForegroundService.onCreate resets a stale-process latch before a
   * restart asks us to resume; completion remains the only operation that
   * consumes this receipt. */
  private fun deliverPending() {
    val prefs = getSharedPreferences(CaptureNotificationModule.PREFS_NAME, Context.MODE_PRIVATE)
    val handoff = synchronized(CaptureForegroundService.DRIVE_INBOX_LOCK) {
      val receiptId = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_RECEIPT_ID, null)
        .orEmpty()
      val currentReceipt = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_RECEIPT_ID, null)
      val text = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_TEXT, null)
      val profileId = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_PROFILE_ID, null)
      val rootUri = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_ROOT_URI, null)
      if (receiptId.isEmpty() || currentReceipt != receiptId || text == null ||
          profileId.isNullOrBlank() || rootUri == null) {
        null
      } else {
        val dispatching = prefs.getBoolean(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_DISPATCHING, false)
        if (dispatching) {
          null
        } else if (prefs.edit()
            .putBoolean(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_DISPATCHING, true)
            .commit()) {
          PendingHandoff(receiptId, text, VaultContext(profileId, rootUri))
        } else {
          null
        }
      }
    } ?: return

    val taskIntent = Intent(this, QuickIdeaTaskService::class.java).apply {
      putExtra(QuickIdeaReceiver.EXTRA_TEXT, handoff.text)
      putExtra(EXTRA_RECEIPT_ID, handoff.receiptId)
      putExtra(EXTRA_PROFILE_ID, handoff.vaultContext.profileId)
      putExtra(EXTRA_ROOT_URI, handoff.vaultContext.rootUri)
    }
    try {
      startService(taskIntent)
      HeadlessJsTaskService.acquireWakeLockNow(this)
    } catch (e: Exception) {
      // Keep the pending payload and make a later reply or FGS restart retry it.
      synchronized(CaptureForegroundService.DRIVE_INBOX_LOCK) {
        val currentPending = prefs.getString(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_RECEIPT_ID, null)
        if (currentPending == handoff.receiptId) {
          prefs.edit().putBoolean(CaptureForegroundService.KEY_DRIVE_INBOX_PENDING_DISPATCHING, false).commit()
        }
      }
      android.util.Log.w("CarnetDriveInbox", "Failed to start pending reply capture: \${e.message}")
    }
  }

  /** Mark-read consumes only the prompt that rendered its PendingIntent. It
   * never creates a replacement prompt, so a delayed duplicate cannot mark the
   * next receipt read. */
  private fun claimMarkRead(receiptId: String): Boolean {
    val prefs = getSharedPreferences(CaptureNotificationModule.PREFS_NAME, Context.MODE_PRIVATE)
    synchronized(CaptureForegroundService.DRIVE_INBOX_LOCK) {
      val promptAt = prefs.getLong(CaptureForegroundService.KEY_DRIVE_INBOX_PROMPT_AT, 0L)
      val currentReceipt = prefs.getString(
        CaptureForegroundService.KEY_DRIVE_INBOX_RECEIPT_ID,
        null,
      )
      val lastReadAt = prefs.getLong(CaptureForegroundService.KEY_DRIVE_INBOX_LAST_READ_AT, 0L)
      if (promptAt == 0L || currentReceipt != receiptId || lastReadAt >= promptAt) return false
      return prefs.edit()
        .putLong(CaptureForegroundService.KEY_DRIVE_INBOX_LAST_READ_AT, promptAt)
        .commit()
    }
  }

  private fun refreshDriveInbox() {
    try {
      val refreshIntent = Intent(this, CaptureForegroundService::class.java).apply {
        action = CaptureForegroundService.ACTION_REFRESH_DRIVE_INBOX
      }
      // The action may outlive the foreground service that rendered it. Start
      // with the foreground API so a stale action cannot trip Android's
      // background-service restriction; its refresh path immediately calls
      // startForeground with the rebuilt notification.
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
        startForegroundService(refreshIntent)
      } else {
        startService(refreshIntent)
      }
    } catch (e: Exception) {
      android.util.Log.w("CarnetDriveInbox", "Failed to refresh Drive Inbox: \${e.message}")
    }
  }
}
`;
}

function automotiveAppDescXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<automotiveApp>
  <!-- Notification-powered messaging only. No media, navigation, or template claim. -->
  <uses name="notification" />
</automotiveApp>
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = function withCaptureNotification(config) {
  const packageName = config.android?.package;

  // Stage 1 — manifest.
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!manifest) return cfg;

    // Permissions.
    const required = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.RECEIVE_BOOT_COMPLETED',
    ];
    if (!Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = [];
    }
    required.forEach((perm) => {
      const has = manifest['uses-permission'].some(
        (u) => u?.$?.['android:name'] === perm,
      );
      if (!has) {
        manifest['uses-permission'].push({ $: { 'android:name': perm } });
      }
    });

    const application = manifest.application?.[0];
    if (!application) return cfg;

    // Android Auto notification-powered messaging only. The pilot deliberately
    // does not claim media, navigation, or a templated car-app category.
    if (!Array.isArray(application['meta-data'])) application['meta-data'] = [];
    const carMetadataName = 'com.google.android.gms.car.application';
    const hasCarMetadata = application['meta-data'].some(
      (m) => m?.$?.['android:name'] === carMetadataName,
    );
    if (!hasCarMetadata) {
      application['meta-data'].push({
        $: {
          'android:name': carMetadataName,
          'android:resource': '@xml/automotive_app_desc',
        },
      });
    }

    // Service.
    if (!Array.isArray(application.service)) application.service = [];
    const serviceName = `${packageName}.notification.CaptureForegroundService`;
    const hasService = application.service.some(
      (s) => s?.$?.['android:name'] === serviceName,
    );
    if (!hasService) {
      application.service.push({
        $: {
          'android:name': serviceName,
          'android:exported': 'false',
          'android:foregroundServiceType': 'specialUse',
        },
        property: [
          {
            $: {
              'android:name':
                'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
              'android:value': 'capture_shortcut_notification',
            },
          },
        ],
      });
    }

    // Boot receiver.
    if (!Array.isArray(application.receiver)) application.receiver = [];
    const receiverName = `${packageName}.notification.BootReceiver`;
    const hasReceiver = application.receiver.some(
      (r) => r?.$?.['android:name'] === receiverName,
    );
    if (!hasReceiver) {
      application.receiver.push({
        $: {
          'android:name': receiverName,
          'android:exported': 'true',
          'android:enabled': 'true',
        },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
              {
                $: {
                  'android:name':
                    'android.intent.action.LOCKED_BOOT_COMPLETED',
                },
              },
              {
                $: { 'android:name': 'android.intent.action.QUICKBOOT_POWERON' },
              },
            ],
          },
        ],
      });
    }

    // Quick-idea inline-reply receiver (B5). exported=false — only ever fired by
    // this app's own notification PendingIntent (explicit component + setPackage).
    const quickReceiverName = `${packageName}.notification.QuickIdeaReceiver`;
    const hasQuickReceiver = application.receiver.some(
      (r) => r?.$?.['android:name'] === quickReceiverName,
    );
    if (!hasQuickReceiver) {
      application.receiver.push({
        $: {
          'android:name': quickReceiverName,
          'android:exported': 'false',
        },
      });
    }

    // Android Auto actions are delivered to a private Service (not a receiver)
    // so the car host can execute both reply and mark-read without launching UI.
    // Remove the pre-service receiver declaration during incremental prebuilds;
    // clean prebuilds discard it with the rest of generated android/ output.
    const driveInboxReadReceiverName = `${packageName}.notification.DriveInboxReadReceiver`;
    application.receiver = application.receiver.filter(
      (r) => r?.$?.['android:name'] !== driveInboxReadReceiverName,
    );

    const driveInboxActionServiceName = `${packageName}.notification.DriveInboxActionService`;
    const hasDriveInboxActionService = application.service.some(
      (s) => s?.$?.['android:name'] === driveInboxActionServiceName,
    );
    if (!hasDriveInboxActionService) {
      application.service.push({
        $: {
          'android:name': driveInboxActionServiceName,
          'android:exported': 'false',
        },
      });
    }

    // Headless JS task service that runs the save-first capture with the app
    // closed. exported=false — started only by QuickIdeaReceiver.
    const quickServiceName = `${packageName}.notification.QuickIdeaTaskService`;
    const hasQuickService = application.service.some(
      (s) => s?.$?.['android:name'] === quickServiceName,
    );
    if (!hasQuickService) {
      application.service.push({
        $: {
          'android:name': quickServiceName,
          'android:exported': 'false',
        },
      });
    }

    return cfg;
  });

  // Stage 2 — MainApplication.kt package registration.
  config = withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    const importLine = `import ${packageName}.notification.CaptureNotificationPackage`;

    if (!contents.includes(importLine)) {
      // Insert the import after the last existing top-level import.
      contents = contents.replace(
        /(^import [^\n]+\n)(?![\s\S]*^import [^\n]+\n)/m,
        `$1${importLine}\n`,
      );
    }

    if (!contents.includes('CaptureNotificationPackage()')) {
      // Two call shapes — they differ by which `this` is in scope:
      //   - applyAdd: inside `.apply { ... }` on the package list, `this` IS
      //     the (mutable) list, so the call is bare `add(...)`. Bare
      //     `packages.add(...)` here fails to compile with
      //     `Unresolved reference 'packages'`.
      //   - localAdd: legacy `val packages = PackageList(this).packages`
      //     shape has a named local; the call needs the `packages.` prefix.
      const applyAdd = 'add(CaptureNotificationPackage())';
      const localAdd = 'packages.add(CaptureNotificationPackage())';

      // Try patterns in order, newest SDK shape first.
      //
      // Pattern 1 — Expo SDK 54+ template: expression-bodied getPackages
      // that wraps PackageList(this).packages.apply { /* add() here */ }.
      // The template includes a commented-out example we can splice after.
      let inserted = contents.replace(
        /(\/\/ add\(MyReactNativePackage\(\)\)\n)/,
        `$1              ${applyAdd}\n`,
      );
      // Pattern 2 — same SDK 54 shape but the example comment is gone
      // (user edited it out). Inject right after the .apply { line.
      if (inserted === contents) {
        inserted = contents.replace(
          /(\.apply\s*\{\n)/,
          `$1              ${applyAdd}\n`,
        );
      }
      // Pattern 3 — legacy SDK pre-54 shape: `val packages = PackageList(this).packages`.
      if (inserted === contents) {
        inserted = contents.replace(
          /(val packages = PackageList\(this\)\.packages[^\n]*\n)/,
          `$1            ${localAdd}\n`,
        );
      }
      // Pattern 4 — alternate legacy shape: explicit override fun with body.
      if (inserted === contents) {
        inserted = contents.replace(
          /(override fun getPackages\(\):[^{]*\{[^\n]*\n\s*val packages[^\n]*\n)/,
          `$1            ${localAdd}\n`,
        );
      }
      contents = inserted;
    }

    // Postcondition: silent regex misses produce a manifest+kotlin tree
    // that LOOKS healthy but the RN bridge module is unreachable. Fail
    // prebuild loudly with a pointer to what needs updating.
    if (!contents.includes('CaptureNotificationPackage()')) {
      throw new Error(
        '[withCaptureNotification] Failed to inject `add(CaptureNotificationPackage())` ' +
          'into MainApplication.kt. Expected one of: ' +
          '(a) `// add(MyReactNativePackage())` example comment in an .apply block (SDK 54), ' +
          '(b) `.apply {` block opener (SDK 54 without the example comment), ' +
          '(c) `val packages = PackageList(this).packages` line (legacy SDK), ' +
          '(d) `override fun getPackages()` followed by `val packages` (legacy SDK). ' +
          'None matched — update the plugin for this Expo SDK MainApplication shape.',
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  // Stage 3 — emit Kotlin sources + drawable.
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const packagePath = packageName.replace(/\./g, '/');
      const javaDir = path.join(
        root,
        'app',
        'src',
        'main',
        'java',
        packagePath,
        'notification',
      );
      fs.mkdirSync(javaDir, { recursive: true });

      fs.writeFileSync(
        path.join(javaDir, 'CaptureForegroundService.kt'),
        captureForegroundServiceKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'CaptureNotificationModule.kt'),
        captureNotificationModuleKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'CaptureNotificationPackage.kt'),
        capturePackageKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'BootReceiver.kt'),
        bootReceiverKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'QuickIdeaReceiver.kt'),
        quickIdeaReceiverKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'QuickIdeaTaskService.kt'),
        quickIdeaTaskServiceKt(packageName),
        'utf8',
      );
      fs.writeFileSync(
        path.join(javaDir, 'DriveInboxActionService.kt'),
        driveInboxActionServiceKt(packageName),
        'utf8',
      );
      // An incremental prebuild can start from native output generated before
      // Drive Inbox actions moved from a receiver to a service. The old source
      // is harmless once its manifest entry is gone, but remove it so the
      // generated tree describes the current integration unambiguously.
      fs.rmSync(path.join(javaDir, 'DriveInboxReadReceiver.kt'), { force: true });

      // shortcut_audio drawable — referenced by both this plugin and the
      // widget plugin. Both plugins emit it identically so removing one
      // doesn't strand the other.
      const drawableDir = path.join(
        root,
        'app',
        'src',
        'main',
        'res',
        'drawable',
      );
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.writeFileSync(
        path.join(drawableDir, 'shortcut_audio.xml'),
        buildVectorDrawable(SHORTCUT_AUDIO_PATH_DATA),
        'utf8',
      );
      const xmlDir = path.join(root, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'automotive_app_desc.xml'),
        automotiveAppDescXml(),
        'utf8',
      );

      return cfg;
    },
  ]);

  return config;
};

// Exported for the verify script + the widget plugin to share.
module.exports.SHORTCUT_AUDIO_PATH_DATA = SHORTCUT_AUDIO_PATH_DATA;
module.exports.buildVectorDrawable = buildVectorDrawable;
// Silence the unused-helper lint — escapeXml is exported for parity with
// withAppShortcuts.js even if this plugin doesn't currently interpolate
// any user-controlled strings into XML.
module.exports.escapeXml = escapeXml;
