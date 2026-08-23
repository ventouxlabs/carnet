// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Static recognizer catalog + AsyncStorage keys + pure label/message helpers
// for the voice module, split out of VoiceButton.tsx so this data (and the
// package→label lookup) is unit-testable without pulling in React Native /
// the native speech module. No native calls live here — see ./sttDeviceProbe
// for the async probes that talk to ExpoSpeechRecognitionModule.

import { type RecognizerOption } from './recognizerSelect';

// Tap-to-toggle max recording — Soda starts to misbehave past a few minutes; cap to 3.
export const MAX_RECORDING_MS = 3 * 60 * 1000;

// Recognizer packages to actively reject if seen in storage. Module-level so
// it doesn't re-allocate on every render. Empty by default — com.google.android.tts
// is intentionally NOT here (see notes below).
export const KNOWN_BAD_PKGS: readonly string[] = [];
// Android 16 fix: Soda's default LANGUAGE_MODEL flipped to AMBIENT_ONESHOT
// after the Sept 2025 security patch. Without web_search, dictation returns
// empty transcripts. (No standalone writeup exists for this — the full
// rationale lives in VoiceButton.tsx's startRecognizerRef comment and this one.)
export const SODA_DICTATION_MODEL = 'web_search';
export const STT_ENGINE_KEY = 'stt_engine';
export const STT_RECOGNIZER_PKG_KEY = 'stt_recognizer_pkg';
export const STT_RECOGNIZER_LABEL_KEY = 'stt_recognizer_label';

export const KNOWN_RECOGNIZERS: readonly RecognizerOption[] = [
  // Android System Intelligence — the actual on-device Google STT service. Prefer first.
  { pkg: 'com.google.android.as', label: 'Google (On-Device)' },
  // "Speech Services by Google" — the Play Store package that exposes Google STT
  // on most non-Pixel Androids (installed by anyone using Google TTS).
  { pkg: 'com.google.android.tts', label: 'Speech Services by Google' },
  { pkg: 'com.google.android.googlequicksearchbox', label: 'Google' },
  { pkg: 'com.google.android.voicesearch', label: 'Google Voice Search' },
  { pkg: 'com.google.android.apps.googleassistant', label: 'Google Assistant' },
  { pkg: 'com.samsung.android.bixby.agent', label: 'Samsung Bixby' },
  { pkg: 'com.samsung.android.speech', label: 'Samsung Voice' },
  { pkg: 'com.htc.sense.hsp', label: 'HTC Voice' },
  { pkg: 'com.nuance.android.vsuite.vsuiteapp', label: 'Nuance' },
  { pkg: 'com.iflytek.speechsuite', label: 'iFlytek' },
];

// FAILOVER_CODES moved to ./sttErrorMessage.ts (isFailoverEligibleCode) so
// it's unit-testable without pulling in this file's RN/expo native imports.
// 7 (ERROR_NO_MATCH_OR_UNAVAILABLE) is deliberately NOT in that set — it's
// handled as a silent same-recognizer restart in VoiceButton.tsx, not a
// failover trigger.

export const PREFERRED_LANG = 'en-US';

// Single canonical copy for every "no working speech service" terminal
// state (detection found nothing, failover chain exhausted post-detection,
// or a null effectivePkg with detection already run). Previously three
// near-duplicate strings existed and drifted from each other during QA
// (2026-07-11) — unify so future edits can't reintroduce the split. All
// three sites present the same 'no-service' action buttons regardless of
// wording, so one message covers every trigger path.
export const NO_SERVICE_MESSAGE =
  'No working speech service found on this device.\nInstall a speech service below, or copy diagnostics for details.';

// Discriminant for the terminal error/status sheet VoiceButton's state
// machine can put the UI into. Owned here (not by the presentational
// VoiceErrorSheet) because the state machine decides transitions between
// these values; the sheet only renders whichever one it's handed.
export type ErrAction = 'none' | 'no-service' | 'no-service-mic-revoked' | 'permission' | 'lang-unavailable' | 'diag';

// Target package/label for the mic-revoked sheet's "Open App info" deep
// link — set once a code-9 (service-not-allowed) package is still
// resolvable on the device. One shape shared by the state (VoiceButton) and
// the props that consume it (VoiceErrorSheet) so they can't drift apart.
export interface MicRevokedTarget {
  pkg: string;
  label: string;
}

export function labelForPackage(pkg: string): string {
  const known = KNOWN_RECOGNIZERS.find((r) => r.pkg === pkg);
  if (known) return known.label;
  // Fallback label: derive from last path segment, title-cased
  const seg = pkg.split('.').pop() ?? pkg;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}
