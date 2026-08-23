// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// STT onboarding readiness helpers for the voice module.
//
// PROBLEM: on a fresh device the on-device speech model isn't downloaded →
// the recognizer dead-ends with code 12 (LANGUAGE_NOT_SUPPORTED) / "no service
// found", in BOTH live dictation (VoiceButton) and audio-capture transcription
// (audioTranscribeOnDevice). carnet never calls the in-app model-download API.
// These helpers probe readiness and wire `androidTriggerOfflineModelDownload`
// so the user can pull the English model from inside the app.
//
// The pure `mapReadiness` is split out (like recognizerSelect's pure helpers) so
// it can be unit-tested without pulling in React Native / the native module.

import type { ExpoSpeechRecognitionModule as ExpoSpeechRecognitionModuleType } from 'expo-speech-recognition';

// Lazily resolve the native module only inside the impure functions. A static
// `import { ExpoSpeechRecognitionModule }` would pull in expo's runtime (which
// needs `__DEV__`) at module-load time, breaking the pure `mapReadiness` unit
// tests under vitest's node env. Mirrors audioDecoder.ts's getNative() pattern.
function getModule(): typeof ExpoSpeechRecognitionModuleType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('expo-speech-recognition') as {
    ExpoSpeechRecognitionModule: typeof ExpoSpeechRecognitionModuleType;
  }).ExpoSpeechRecognitionModule;
}

export type SttReadiness =
  | { state: 'ready'; locale: string }
  | { state: 'needs-model'; locale: string }
  | { state: 'unsupported' }
  | { state: 'no-permission' };

export interface SttProbe {
  recognitionAvailable: boolean;
  onDeviceSupported: boolean;
  permissionGranted: boolean;
  locales: readonly string[];
  installedLocales: readonly string[];
}

/**
 * Pure classifier: map a readiness probe to an {@link SttReadiness} state.
 *
 * Order matters — checked top to bottom:
 *  - no recognition OR no on-device support → `unsupported` (nothing to download)
 *  - permission not granted                 → `no-permission`
 *  - an English locale already installed    → `ready`
 *  - English supported but not installed     → `needs-model` (download it)
 *  - otherwise                              → `unsupported`
 *
 * "English" matches the preferred tag exactly (case-insensitive) OR any `en-`
 * locale, because on-device Google STT installs region variants (en-US/en-GB)
 * that all satisfy dictation.
 */
export function mapReadiness(probe: SttProbe, preferred = 'en-US'): SttReadiness {
  if (!probe.recognitionAvailable || !probe.onDeviceSupported) {
    return { state: 'unsupported' };
  }
  if (!probe.permissionGranted) {
    return { state: 'no-permission' };
  }
  const wanted = preferred.toLowerCase();
  const enMatch = (list: readonly string[]): boolean =>
    list.some((l) => {
      const lc = l.toLowerCase();
      return lc === wanted || lc.startsWith('en-');
    });
  if (enMatch(probe.installedLocales)) {
    return { state: 'ready', locale: preferred };
  }
  if (enMatch(probe.locales)) {
    return { state: 'needs-model', locale: preferred };
  }
  return { state: 'unsupported' };
}

/**
 * Probe the native recognizer and classify readiness. Any native throw (Expo
 * Go, iOS, missing bridge, getSupportedLocales `package_not_found`) collapses to
 * `unsupported` — the caller then routes to manual setup.
 */
export async function checkSttReadiness(preferred = 'en-US'): Promise<SttReadiness> {
  try {
    const mod = getModule();
    const recognitionAvailable = mod.isRecognitionAvailable();
    const onDeviceSupported = mod.supportsOnDeviceRecognition();
    const permission = await mod.getPermissionsAsync();
    const { locales, installedLocales } = await mod.getSupportedLocales({});
    return mapReadiness(
      {
        recognitionAvailable,
        onDeviceSupported,
        permissionGranted: permission.granted,
        locales,
        installedLocales,
      },
      preferred,
    );
  } catch {
    return { state: 'unsupported' };
  }
}

export type VoiceModelDownloadResult = 'installed' | 'dialog' | 'scheduled' | 'failed';

/**
 * Trigger the in-app on-device voice-model download (Android 13+).
 *
 * Maps the native status to a coarse result:
 *  - `download_success`   → 'installed' (Android 14+, model is ready now)
 *  - `opened_dialog`      → 'dialog'    (Android 13, system dialog shown)
 *  - `download_scheduled` → 'scheduled' (download queued)
 *
 * Any other status or a native throw (older Android, iOS, canceled) → 'failed'.
 */
export async function triggerVoiceModelDownload(
  preferred = 'en-US',
): Promise<VoiceModelDownloadResult> {
  try {
    const result = await getModule().androidTriggerOfflineModelDownload({
      locale: preferred,
    });
    // Compare as a plain string: the installed lib (3.1.3) types `status` as
    // "download_success" | "opened_dialog" | "download_canceled" and omits
    // "download_scheduled", but we still map it defensively in case a newer
    // native side reports it. `download_canceled` (and anything else) → 'failed'.
    const status: string = result.status;
    switch (status) {
      case 'download_success':
        return 'installed';
      case 'opened_dialog':
        return 'dialog';
      case 'download_scheduled':
        return 'scheduled';
      default:
        return 'failed';
    }
  } catch {
    return 'failed';
  }
}
