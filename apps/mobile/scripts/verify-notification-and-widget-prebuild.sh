#!/usr/bin/env bash
#
# Regression check for the withCaptureNotification + withCaptureWidget
# config plugins.
#
# Runs a clean Android prebuild and asserts that all emitted files land
# where the gradle build can find them, plus the AndroidManifest carries
# the service / receiver / permission declarations the plugins inject.
#
# Same shape as verify-shortcuts-prebuild.sh — cheaper than wiring vitest
# into the plugins/ directory for one round of snapshot tests.
#
# Exit 0 = all good. Non-zero = failures printed before exit.
#
# CAVEAT: nukes apps/mobile/android/ to guarantee a clean prebuild.
# android/ is gitignored and regenerated on every `npm run android`, so
# this is safe — but don't run it concurrently with a Gradle build.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
# Derive the package from app.json so this never goes stale on a rename/rebrand.
PKG="$(node -p "require('$MOBILE_DIR/app.json').expo.android.package")"
PKG_PATH="${PKG//.//}"

cd "$MOBILE_DIR"

echo "→ Cleaning android/ for a fresh prebuild…"
rm -rf "$ANDROID_DIR"

echo "→ Running expo prebuild --platform android…"
npx expo prebuild --platform android >/dev/null

EXIT=0

check_file() {
  local relpath="$1"
  local label="$2"
  if [ -f "$ANDROID_DIR/$relpath" ]; then
    echo "  ✓ $label"
  else
    echo "  ✗ MISSING: $label ($relpath)"
    EXIT=1
  fi
}

check_manifest_contains() {
  local needle="$1"
  local label="$2"
  if grep -q "$needle" "$ANDROID_DIR/app/src/main/AndroidManifest.xml"; then
    echo "  ✓ $label"
  else
    echo "  ✗ MISSING in manifest: $label ($needle)"
    EXIT=1
  fi
}

check_main_app_contains() {
  local needle="$1"
  local label="$2"
  local file
  file=$(find "$ANDROID_DIR/app/src/main/java" -name 'MainApplication.kt' -o -name 'MainApplication.java' 2>/dev/null | head -1)
  if [ -z "$file" ]; then
    echo "  ✗ MISSING: MainApplication source file"
    EXIT=1
    return
  fi
  if grep -q "$needle" "$file"; then
    echo "  ✓ $label"
  else
    echo "  ✗ MISSING in MainApplication: $label ($needle)"
    EXIT=1
  fi
}

echo "→ Notification plugin — emitted Kotlin sources:"
check_file "app/src/main/java/$PKG_PATH/notification/CaptureForegroundService.kt" "CaptureForegroundService.kt"
check_file "app/src/main/java/$PKG_PATH/notification/CaptureNotificationModule.kt" "CaptureNotificationModule.kt"
check_file "app/src/main/java/$PKG_PATH/notification/CaptureNotificationPackage.kt" "CaptureNotificationPackage.kt"
check_file "app/src/main/java/$PKG_PATH/notification/BootReceiver.kt" "BootReceiver.kt"
check_file "app/src/main/java/$PKG_PATH/notification/QuickIdeaReceiver.kt" "QuickIdeaReceiver.kt (B5 inline reply)"
check_file "app/src/main/java/$PKG_PATH/notification/QuickIdeaTaskService.kt" "QuickIdeaTaskService.kt (B5 headless task)"
check_file "app/src/main/java/$PKG_PATH/notification/DriveInboxReadReceiver.kt" "DriveInboxReadReceiver.kt (Android Auto mark-read)"
check_file "app/src/main/res/xml/automotive_app_desc.xml" "automotive_app_desc.xml (notification messaging only)"

echo "→ Widget plugin — emitted Kotlin + resources:"
check_file "app/src/main/java/$PKG_PATH/widget/CaptureWidgetProvider.kt" "CaptureWidgetProvider.kt"
check_file "app/src/main/res/layout/widget_capture.xml" "widget_capture.xml (4x1 layout)"
# The provider references R.layout.widget_capture_2x2 unconditionally, so a
# missing 2x2 layout breaks the Kotlin COMPILE, not just the rendering.
check_file "app/src/main/res/layout/widget_capture_2x2.xml" "widget_capture_2x2.xml (2x2 layout)"
check_file "app/src/main/res/xml/widget_capture_info.xml" "widget_capture_info.xml"

echo "→ Widget resizability + layout id parity:"
WIDGET_INFO="$ANDROID_DIR/app/src/main/res/xml/widget_capture_info.xml"
if grep -qF 'android:resizeMode="horizontal|vertical"' "$WIDGET_INFO" 2>/dev/null; then
  echo "  ✓ widget declares horizontal|vertical resize"
else
  echo "  ✗ widget_capture_info.xml must declare resizeMode=\"horizontal|vertical\" (else the 2x2 is unreachable)"
  EXIT=1
fi
# targetCell* must stay 4x1: it sets the DEFAULT drop size, so changing it
# would reshape widgets users have already placed.
if grep -qF 'android:targetCellWidth="4"' "$WIDGET_INFO" 2>/dev/null &&
  grep -qF 'android:targetCellHeight="1"' "$WIDGET_INFO" 2>/dev/null; then
  echo "  ✓ default drop size still 4x1"
else
  echo "  ✗ targetCellWidth/Height must remain 4x1 so existing placements are unaffected"
  EXIT=1
fi
# The provider binds by id without knowing which layout it got. A mismatch
# makes setOnClickPendingIntent a silent no-op — dead taps, no crash, no log —
# which no compile and no screenshot would catch.
WIDGET_4X1="$ANDROID_DIR/app/src/main/res/layout/widget_capture.xml"
WIDGET_2X2="$ANDROID_DIR/app/src/main/res/layout/widget_capture_2x2.xml"
IDS_4X1=$(grep -o 'android:id="@+id/btn_[a-z]*"' "$WIDGET_4X1" 2>/dev/null | sort)
IDS_2X2=$(grep -o 'android:id="@+id/btn_[a-z]*"' "$WIDGET_2X2" 2>/dev/null | sort)
if [ -n "$IDS_4X1" ] && [ "$IDS_4X1" = "$IDS_2X2" ]; then
  echo "  ✓ both layouts expose the same 4 button ids"
else
  echo "  ✗ layout button ids differ between 4x1 and 2x2 — taps would silently do nothing"
  EXIT=1
fi

echo "→ Shared drawable:"
check_file "app/src/main/res/drawable/shortcut_audio.xml" "shortcut_audio.xml"

echo "→ AndroidManifest declarations:"
check_manifest_contains "CaptureForegroundService" "service: CaptureForegroundService"
check_manifest_contains "foregroundServiceType=\"specialUse\"" "service type: specialUse"
check_manifest_contains "PROPERTY_SPECIAL_USE_FGS_SUBTYPE" "subtype property"
check_manifest_contains "BootReceiver" "receiver: BootReceiver"
check_manifest_contains "QuickIdeaReceiver" "receiver: QuickIdeaReceiver (B5)"
check_manifest_contains "QuickIdeaTaskService" "service: QuickIdeaTaskService (B5)"
check_manifest_contains "DriveInboxReadReceiver" "receiver: DriveInboxReadReceiver (Android Auto mark-read)"
check_manifest_contains "com.google.android.gms.car.application" "Android Auto messaging declaration"
check_manifest_contains "CaptureWidgetProvider" "receiver: CaptureWidgetProvider"
check_manifest_contains "android.appwidget.action.APPWIDGET_UPDATE" "widget intent filter"
check_manifest_contains "FOREGROUND_SERVICE_SPECIAL_USE" "permission: FOREGROUND_SERVICE_SPECIAL_USE"
check_manifest_contains "POST_NOTIFICATIONS" "permission: POST_NOTIFICATIONS"
check_manifest_contains "RECEIVE_BOOT_COMPLETED" "permission: RECEIVE_BOOT_COMPLETED"

echo "→ Inline replies — RemoteInput + explicit mutable PendingIntent (security invariant):"
NOTIF_SVC="$ANDROID_DIR/app/src/main/java/$PKG_PATH/notification/CaptureForegroundService.kt"
check_kt_source_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if [ -f "$file" ] && grep -q "$needle" "$file"; then
    echo "  ✓ $label"
  else
    echo "  ✗ MISSING: $label ($needle)"
    EXIT=1
  fi
}
check_kt_source_contains "$NOTIF_SVC" "addRemoteInput" "quick-idea action has a RemoteInput"
check_kt_source_contains "$NOTIF_SVC" "quickIdeaAction()" "quick-idea action wired into the notification"
# RemoteInput requires a mutable PendingIntent on Android 12+. Each reply is
# still explicit and targets a non-exported receiver, which prevents redirecting
# it to another app component.
check_kt_source_contains "$NOTIF_SVC" "getBroadcast" "quick-idea uses a broadcast PendingIntent"
check_kt_source_contains "$NOTIF_SVC" "FLAG_MUTABLE" "direct-reply PendingIntents are mutable"
QUICK_RCV="$ANDROID_DIR/app/src/main/java/$PKG_PATH/notification/QuickIdeaReceiver.kt"
check_kt_source_contains "$QUICK_RCV" "getResultsFromIntent" "receiver reads RemoteInput results"
check_kt_source_contains "$QUICK_RCV" "isEmpty()" "receiver drops empty submissions (no-op guard)"
check_kt_source_contains "$NOTIF_SVC" "MessagingStyle" "Drive Inbox uses messaging notification style"
check_kt_source_contains "$NOTIF_SVC" "driveInboxMarkReadAction" "Drive Inbox supplies mark-as-read"
DRIVE_READ_RCV="$ANDROID_DIR/app/src/main/java/$PKG_PATH/notification/DriveInboxReadReceiver.kt"
check_kt_source_contains "$DRIVE_READ_RCV" "ACTION_MARK_READ" "mark-read receiver validates its action"
check_kt_source_contains "$DRIVE_READ_RCV" "putLong" "mark-read is recorded without note writes"

echo "→ MainApplication package registration:"
check_main_app_contains "import ${PKG}.notification.CaptureNotificationPackage" "import line present"
# Distinct check for the add() injection — earlier versions of the plugin
# only inserted the import but silently failed the add() injection on
# SDK 54's expression-bodied MainApplication. Catching that requires
# checking for the CALL site, not just the symbol name.
check_main_app_contains "add(CaptureNotificationPackage())" "add() call site present (bridge registered)"

if [ "$EXIT" -eq 0 ]; then
  echo
  echo "✓ Notification + widget plugins are healthy — all artifacts present."
else
  echo
  echo "✗ Plugin output is incomplete. Inspect plugins/withCaptureNotification.js"
  echo "  and plugins/withCaptureWidget.js."
fi

exit "$EXIT"
