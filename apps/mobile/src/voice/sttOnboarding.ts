// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// STT onboarding v2 — proactive readiness presentation + first-run gating.
//
// #50 added the readiness PROBE (checkSttReadiness) and the model-download
// trigger, but only wired them REACTIVELY: the "Download voice model" button
// surfaces inside VoiceButton's error sheet AFTER dictation dead-ends with
// code 12. This module is the proactive half — it turns a SttReadiness into
// user-facing copy + a single recommended action, and gates a one-shot
// first-run prompt so we can offer the download BEFORE the user hits the error.
//
// Everything here is pure except the tiny AsyncStorage-backed "prompted" flag,
// and crucially imports NO react-native / expo runtime, so the decision logic
// stays unit-testable under vitest's node env (mirrors sttReadiness's split:
// the `SttReadiness` type is a type-only import, fully erased at compile time).

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SttReadiness } from './sttReadiness';

/**
 * Which speech engine the user has selected. On-device is the only engine —
 * kept as a named type so the readiness/onboarding surfaces stay explicit.
 */
export type SttEngine = 'ondevice';

export type OnboardingTone = 'ok' | 'warn' | 'info';

/**
 * The single recommended next step for a given readiness state. The UI maps
 * each to a concrete control (the download trigger, an app-settings deep link,
 * or nothing).
 */
export type OnboardingAction = 'download' | 'open-permission' | 'none';

export interface ReadinessCopy {
  tone: OnboardingTone;
  title: string;
  body: string;
  action: OnboardingAction;
}

/**
 * Pure: map a readiness probe to display copy + one recommended action. Shared
 * by the Settings "Check voice setup" action and the Home first-run banner so
 * both surfaces speak with one voice.
 */
export function describeReadiness(readiness: SttReadiness): ReadinessCopy {
  switch (readiness.state) {
    case 'ready':
      return {
        tone: 'ok',
        title: 'Voice input is ready',
        body: `The on-device English model is installed (${readiness.locale}). Dictation works offline.`,
        action: 'none',
      };
    case 'needs-model':
      return {
        tone: 'warn',
        title: 'Voice model not downloaded',
        body: "Your device supports offline dictation, but the English voice model isn't installed yet. Download it now to avoid a dead-end mid-dictation.",
        action: 'download',
      };
    case 'no-permission':
      return {
        tone: 'info',
        title: 'Microphone permission needed',
        body: 'Carnet needs microphone access for voice input. Grant it in app settings, or just tap the mic and accept the system prompt.',
        action: 'open-permission',
      };
    case 'unsupported':
      return {
        tone: 'info',
        title: 'On-device dictation unavailable',
        body: 'This device has no on-device speech service for English. Install Speech Services by Google (or another recognizer) to enable dictation.',
        action: 'none',
      };
  }
}

/**
 * Shared source of truth for the "on-device voice model missing" error text
 * thrown by `audioTranscribeOnDevice.ts`'s recognizer error handler. Kept
 * here (not duplicated) so the audio-capture screen's error banner can
 * detect this specific failure class — via {@link isSttModelMissingMessage}
 * — and offer the same "download the model" recovery VoiceButton's dictation
 * flow already has, instead of a dead-end error string.
 */
export const STT_MODEL_MISSING_MESSAGE =
  "On-device voice model isn't installed. Open Journal voice dictation to download it.";

/**
 * True when an error message is the on-device-model-missing class thrown by
 * `transcribeOnDevice`'s recognizer error handler. Exact match against the
 * shared constant, not a heuristic — the message text is only ever produced
 * by that one call site, sourced from the same constant.
 */
export function isSttModelMissingMessage(message: string): boolean {
  return message === STT_MODEL_MISSING_MESSAGE;
}

export interface ProactivePromptInput {
  readiness: SttReadiness;
  alreadyPrompted: boolean;
  engine: SttEngine;
}

/**
 * Pure: should the one-shot first-run banner be shown?
 *
 * Only when there is a downloadable model we can pull on the user's behalf and
 * they have not been nudged before. Every other state is handled elsewhere:
 * 'no-permission' is requested at capture time, 'unsupported' has nothing to
 * download, and 'ready' needs no nudge.
 */
export function shouldPromptProactively(input: ProactivePromptInput): boolean {
  return (
    input.engine === 'ondevice' &&
    !input.alreadyPrompted &&
    input.readiness.state === 'needs-model'
  );
}

/**
 * One-shot flag: set once the first-run model nudge has been shown (and either
 * acted on or dismissed) so we never nag again. Versioned so a future
 * onboarding revision can re-prompt the whole base by bumping the suffix.
 */
export const STT_ONBOARDING_PROMPTED_KEY = 'stt_onboarding_prompted_v1';

/**
 * True once the first-run voice-model nudge has been shown. A storage read
 * failure fails safe toward "already prompted" so a flaky read can't resurrect
 * the banner on every launch.
 */
export async function wasOnboardingPrompted(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(STT_ONBOARDING_PROMPTED_KEY)) !== null;
  } catch {
    return true;
  }
}

/** Record that the first-run nudge has been shown. Best-effort — worst case
 * the banner reappears on the next launch. */
export async function markOnboardingPrompted(): Promise<void> {
  try {
    await AsyncStorage.setItem(STT_ONBOARDING_PROMPTED_KEY, '1');
  } catch {
    // Swallow — a failed write only risks one extra prompt next launch.
  }
}
