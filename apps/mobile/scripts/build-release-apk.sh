#!/usr/bin/env bash
#
# Build a release APK that runs without Metro — JS is bundled inline and the
# APK is installable on any phone.
#
# SIGNING: if a release keystore is available (env vars CARNET_KEYSTORE_FILE /
# CARNET_KEYSTORE_PASSWORD / CARNET_KEY_ALIAS / CARNET_KEY_PASSWORD, or a
# properties file at ~/.config/carnet/keystore.properties — override the path
# with CARNET_KEYSTORE_PROPS), the APK is signed with it via AGP's injected
# signing properties, giving every machine the same app identity so sideloads
# upgrade cleanly. Without one it falls back to the Android debug keystore
# (machine-specific identity; upgrades only work from the same machine).
#
# MIGRATION NOTE: a device holding a debug-signed install can't upgrade to a
# release-signed APK (INSTALL_FAILED_UPDATE_INCOMPATIBLE) — uninstall first.
# App-internal data (settings, recents, queue) is lost on uninstall; vault
# notes survive only if the capture folder points outside the app sandbox.
#
# Sequence:
#   1. Verify the prebuilt android/ folder exists; tell the user to run
#      `npx expo prebuild --platform android` if it doesn't.
#   2. Run `./gradlew assembleRelease` (Gradle handles the JS bundle via the
#      react-native-gradle-plugin tasks wired during prebuild).
#   3. Print the output path.
#   4. Install via adb to every connected device. Otherwise show the command.
#
# MULTIPLE DEVICES: all connected devices get the APK, each named as it goes.
# Set ANDROID_SERIAL=<serial> (adb's own env var) to target exactly one. A
# bare `adb install` fails with "more than one device/emulator" the moment a
# second phone is attached, which is why every call here is `adb -s`.

set -e

# --aab: build an Android App Bundle (gradlew bundleRelease) instead of an
# APK — for Google Play uploads only. The keystore below then acts as the
# Play *upload* key; Play App Signing re-signs what users download, so a
# Play install can never upgrade a GitHub/Izzy APK install (and vice versa).
# AABs aren't adb-installable, so the install step is skipped in this mode.
BUILD_AAB=0
if [ "${1:-}" = "--aab" ]; then
  BUILD_AAB=1
  shift
fi
if [ "$#" -gt 0 ]; then
  echo "Usage: $(basename "$0") [--aab]" >&2
  exit 1
fi

# Resolve to apps/mobile regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
if [ "$BUILD_AAB" -eq 1 ]; then
  GRADLE_TASK="bundleRelease"
  OUTPUT_APK="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"
else
  GRADLE_TASK="assembleRelease"
  OUTPUT_APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
fi

# ── locate Android SDK (gradle needs ANDROID_HOME or local.properties) ──
# Without this, gradle's eval phase fails with "SDK location not found"
# before it even gets to the resource merge. Mirrors the adb-locator
# fallback below — the same path serves both needs.
if [ -z "${ANDROID_HOME:-}" ]; then
  for sdk_path in "${HOME}/Android/Sdk" "/opt/android-sdk" "${HOME}/Library/Android/sdk"; do
    if [ -d "$sdk_path" ]; then
      export ANDROID_HOME="$sdk_path"
      echo "Detected ANDROID_HOME=$ANDROID_HOME"
      break
    fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "ERROR: ANDROID_HOME unset and no SDK found in standard locations." >&2
  echo "Install Android Studio + SDK, or set ANDROID_HOME=/path/to/Android/Sdk and retry." >&2
  exit 1
fi

# ── prebuild check ───────────────────────────────────────────────────
if [ ! -d "$ANDROID_DIR" ]; then
  echo "ERROR: $ANDROID_DIR doesn't exist." >&2
  echo "Run: cd $MOBILE_DIR && npx expo prebuild --platform android" >&2
  exit 1
fi

# ── locate adb (only needed for the optional install at the end) ────
if [ -n "${ANDROID_HOME:-}" ] && [ -x "${ANDROID_HOME}/platform-tools/adb" ]; then
  ADB="${ANDROID_HOME}/platform-tools/adb"
elif [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -x "${ANDROID_SDK_ROOT}/platform-tools/adb" ]; then
  ADB="${ANDROID_SDK_ROOT}/platform-tools/adb"
elif command -v adb >/dev/null 2>&1; then
  ADB="$(command -v adb)"
elif [ -x "${HOME}/Android/Sdk/platform-tools/adb" ]; then
  ADB="${HOME}/Android/Sdk/platform-tools/adb"
elif [ -x "${HOME}/Library/Android/sdk/platform-tools/adb" ]; then
  ADB="${HOME}/Library/Android/sdk/platform-tools/adb"
else
  ADB=""
fi

# ── fail fast on a bad ANDROID_SERIAL, before spending a build on it ──
# Re-checked after the build too, since devices come and go mid-build.
if [ -n "${ANDROID_SERIAL:-}" ] && [ -n "$ADB" ]; then
  if ! "$ADB" devices 2>/dev/null | awk '$2 == "device" { print $1 }' | grep -qxF "$ANDROID_SERIAL"; then
    echo "ERROR: ANDROID_SERIAL=$ANDROID_SERIAL is set but that device isn't connected." >&2
    echo "Connected:" >&2
    "$ADB" devices 2>/dev/null | awk '$2 == "device" { print "  " $1 }' >&2
    exit 1
  fi
fi

# ── release signing (optional; falls back to the debug keystore) ────
# Env mode is all-or-nothing: setting CARNET_KEYSTORE_FILE skips the
# properties file entirely, so the three companion vars must be set too.
KS_PROPS="${CARNET_KEYSTORE_PROPS:-$HOME/.config/carnet/keystore.properties}"
if [ -z "${CARNET_KEYSTORE_FILE:-}" ] && [ -f "$KS_PROPS" ]; then
  # tr strips CR so a Windows-edited properties file can't silently break
  # the [ -f ] check or feed a \r-suffixed password to Gradle.
  CARNET_KEYSTORE_FILE=$(sed -n 's/^storeFile=//p' "$KS_PROPS" | tr -d '\r')
  CARNET_KEYSTORE_PASSWORD=$(sed -n 's/^storePassword=//p' "$KS_PROPS" | tr -d '\r')
  CARNET_KEY_ALIAS=$(sed -n 's/^keyAlias=//p' "$KS_PROPS" | tr -d '\r')
  CARNET_KEY_PASSWORD=$(sed -n 's/^keyPassword=//p' "$KS_PROPS" | tr -d '\r')
fi

SIGNING_ARGS=()
if [ -n "${CARNET_KEYSTORE_FILE:-}" ] && [ ! -f "$CARNET_KEYSTORE_FILE" ]; then
  echo "ERROR: CARNET_KEYSTORE_FILE is set but does not exist: $CARNET_KEYSTORE_FILE" >&2
  exit 1
fi
if [ -n "${CARNET_KEYSTORE_FILE:-}" ] && { [ -z "${CARNET_KEYSTORE_PASSWORD:-}" ] || [ -z "${CARNET_KEY_ALIAS:-}" ] || [ -z "${CARNET_KEY_PASSWORD:-}" ]; }; then
  echo "ERROR: keystore configured but password/alias incomplete — Gradle would fail cryptically." >&2
  echo "  Provide storePassword/keyAlias/keyPassword in $KS_PROPS (or the CARNET_* env vars)." >&2
  exit 1
fi
if [ -n "${CARNET_KEYSTORE_FILE:-}" ] && [ -f "$CARNET_KEYSTORE_FILE" ]; then
  echo "Signing with release keystore: $CARNET_KEYSTORE_FILE"
  # AGP's injected signing overrides the (prebuild-generated) debug config
  # without editing android/ — survives `expo prebuild --clean`.
  SIGNING_ARGS=(
    "-Pandroid.injected.signing.store.file=$CARNET_KEYSTORE_FILE"
    "-Pandroid.injected.signing.store.password=$CARNET_KEYSTORE_PASSWORD"
    "-Pandroid.injected.signing.key.alias=$CARNET_KEY_ALIAS"
    "-Pandroid.injected.signing.key.password=$CARNET_KEY_PASSWORD"
  )
else
  echo "WARNING: no release keystore found — signing with the debug keystore."
  echo "  (machine-specific identity; see the header comment for setup)"
fi

# ── build ────────────────────────────────────────────────────────────
if [ "$BUILD_AAB" -eq 1 ]; then
  echo "Building release AAB for Play upload…"
else
  echo "Building release APK… (this packages the JS bundle into the APK, no Metro needed)"
fi
( cd "$ANDROID_DIR" && ./gradlew "$GRADLE_TASK" "${SIGNING_ARGS[@]}" )

if [ ! -f "$OUTPUT_APK" ]; then
  echo "ERROR: build completed but $OUTPUT_APK is missing." >&2
  echo "Check the Gradle output above for a non-fatal-but-suspicious error." >&2
  exit 1
fi

# ── report + offer install ───────────────────────────────────────────
SIZE=$(stat -c %s "$OUTPUT_APK" 2>/dev/null || stat -f %z "$OUTPUT_APK" 2>/dev/null || echo "?")
SIZE_MB=$(( SIZE / 1024 / 1024 ))

echo ""
echo "✓ Built: $OUTPUT_APK  (${SIZE_MB} MB)"
echo ""

if [ "$BUILD_AAB" -eq 1 ]; then
  echo "AABs can't be adb-installed — upload this file in the Play Console."
  exit 0
fi

if [ -z "$ADB" ]; then
  echo "To install on a connected device:"
  echo "  adb install -r $OUTPUT_APK"
  exit 0
fi

# Collect connected serials. "adb devices" prints a header line plus one line
# per device as "<serial>\t<state>"; only state "device" can accept an install
# (an "unauthorized" or "offline" entry would fail with a confusing error).
# while-read rather than mapfile — macOS still ships bash 3.2.
DEVICES=()
while IFS= read -r serial; do
  [ -n "$serial" ] && DEVICES+=("$serial")
done < <("$ADB" devices 2>/dev/null | awk '$2 == "device" { print $1 }')

if [ "${#DEVICES[@]}" -eq 0 ]; then
  echo "No device connected. To install:"
  echo "  adb install -r $OUTPUT_APK"
  exit 0
fi

# ANDROID_SERIAL is adb's own targeting variable, so honor it rather than
# inventing a CARNET_* one — it also works for any manual adb call afterward.
if [ -n "${ANDROID_SERIAL:-}" ]; then
  if ! printf '%s\n' "${DEVICES[@]}" | grep -qxF "$ANDROID_SERIAL"; then
    echo "ERROR: ANDROID_SERIAL=$ANDROID_SERIAL is set but that device isn't connected." >&2
    echo "Connected:" >&2
    printf '  %s\n' "${DEVICES[@]}" >&2
    exit 1
  fi
  DEVICES=("$ANDROID_SERIAL")
fi

# Don't let one device's failure abort the rest — a phone that's locked, low
# on space, or holding a debug-signed install shouldn't stop the others.
set +e
FAILED=()
for serial in "${DEVICES[@]}"; do
  model=$("$ADB" -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')
  echo ""
  echo "Installing to ${model:-unknown device} ($serial)…"
  if ! "$ADB" -s "$serial" install -r "$OUTPUT_APK"; then
    FAILED+=("${model:-unknown} ($serial)")
  fi
done
set -e

echo ""
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "Done — installed to ${#DEVICES[@]} device(s). Launch from the app drawer; no Metro needed."
else
  echo "Installed to $(( ${#DEVICES[@]} - ${#FAILED[@]} )) of ${#DEVICES[@]} device(s). Failed:" >&2
  printf '  %s\n' "${FAILED[@]}" >&2
  echo "" >&2
  echo "INSTALL_FAILED_UPDATE_INCOMPATIBLE means that device holds a differently-signed" >&2
  echo "install — uninstall it first (loses app data; see the header note)." >&2
  exit 1
fi
