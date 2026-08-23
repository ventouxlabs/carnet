// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Pure STT error-message translation, split out of VoiceButton.tsx (like
// recognizerSelect.ts's pure helpers) so it's unit-testable without pulling
// in expo-av / expo-speech-recognition / react-native-paper at import time.

/**
 * expo-speech-recognition's numeric `event.code` field, mapped to friendly
 * copy. Android SpeechRecognizer error constants (ERROR_NETWORK_TIMEOUT=1,
 * ERROR_AUDIO=3, etc.) — see VoiceButton.tsx's FAILOVER_CODES for the subset
 * that trigger recognizer failover instead of a terminal error message.
 */
const CODE_MESSAGES: Record<number, string> = {
  1: "Network error — check your connection",
  2: "Network timeout — try again",
  3: "Audio recording error — try again",
  4: "Server error — try again later",
  5: "No speech service found on device",
  6: "No speech detected — speak closer to mic",
  7: "No speech detected — try again",
  8: "Speech service busy — wait and retry",
  9: "Speech service not allowed — trying another",
  11: "Language not supported by this service",
  13: "Speech service unavailable",
};

/**
 * String-keyed fallback for expo-speech-recognition's `event.error` enum
 * (ExpoSpeechRecognitionErrorEvent.error — always populated, unlike `code`).
 * The library's own type docs say `code` can be -1 "when native code is not
 * available" — without this fallback, that leaves CODE_MESSAGES unable to
 * translate the error and the raw enum string (e.g. "audio-capture") leaks
 * straight into the error sheet untranslated. Covers every
 * ExpoSpeechRecognitionErrorCode value from the library's type definitions.
 */
const STRING_MESSAGES: Record<string, string> = {
  aborted: "Recording stopped",
  "audio-capture":
    "Audio recording error — check nothing else is using the microphone, then try again",
  interrupted: "Interrupted by a call or another app — try again",
  "bad-grammar": "Speech recognition grammar error",
  "language-not-supported": "Language not supported by this service",
  network: "Network error — check your connection",
  "no-speech": "No speech detected — speak closer to mic",
  "not-allowed": "Microphone permission denied",
  "service-not-allowed": "Speech service not allowed — trying another",
  busy: "Speech service busy — wait and retry",
  client: "No speech service found on device",
  "speech-timeout": "No speech detected — try again",
  unknown: "Speech service unavailable",
};

/**
 * Translate a speech-recognition error into user-facing copy.
 *
 * Tries the numeric `code` map first (existing behavior — the numbers drive
 * VoiceButton's failover/retry branching too, so keeping them primary avoids
 * behavior drift there). Falls back to the string `error` enum when the
 * code misses (commonly -1, per the library's own docs). Falls back to the
 * raw event text only if neither map has an entry, so an error the app
 * doesn't recognize still shows something rather than a blank message.
 */
export function describeSttError(code: number, error: string, raw: string): string {
  if (CODE_MESSAGES[code]) return `${CODE_MESSAGES[code]} (${code})`;
  const stringMsg = STRING_MESSAGES[error];
  if (stringMsg) return `${stringMsg} (${error})`;
  return raw || `Speech error ${code}`;
}

/**
 * Error codes where the *current* recognizer can't serve the request but
 * another recognizer might — VoiceButton uses this to decide whether to
 * advance its failover chain (try the next pinned candidate / re-run
 * detection) instead of showing a terminal dead-end message.
 *
 * 5 = ERROR_CLIENT (no-service variant), 9 = ERROR_INSUFFICIENT_PERMISSIONS
 * (service-not-allowed — seen when the recognizer app itself has its
 * RECORD_AUDIO revoked, e.g. by Android's unused-app auto-revoke; the
 * proxied AppOps mic check fails on the recognizer side even though the
 * caller's grant is fine), 11 = ERROR_LANGUAGE_UNAVAILABLE,
 * 12 = ERROR_LANGUAGE_NOT_SUPPORTED, 13 = ERROR_SERVER_UNAVAILABLE.
 *
 * -1 = expo-speech-recognition's native catch-all: ExpoSpeechService.kt's
 * start() wraps recognizer creation in a try/catch and reports EVERY
 * exception (including "No service found for package <pkg>" — a pinned
 * recognizer that isn't actually registered on this device) as
 * {error: "audio-capture", code: -1}. Without failover eligibility here, a
 * genuinely-absent pinned recognizer (e.g. com.google.android.tts on a
 * device that doesn't ship it) is never marked failed, so the same broken
 * package gets re-selected on every retry — every tap hits the identical
 * dead-end error instead of falling through to the next pinned candidate
 * or the no-service UI.
 */
const FAILOVER_CODES = new Set([-1, 5, 9, 11, 12, 13]);

export function isFailoverEligibleCode(code: number): boolean {
  return FAILOVER_CODES.has(code);
}
