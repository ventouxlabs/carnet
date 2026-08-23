// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

// Pure transcript-accumulator + `result`/`end` listener decision logic for
// VoiceButton, split out (like sttErrorPolicy.ts / recognizerSelect.ts) so the
// error-before-end ordering, silence auto-stop, and flush interplay are
// unit-testable without react-native / expo-speech-recognition. This module
// decides WHAT happens to the session state; VoiceButton keeps every side
// effect (native stop, timers, haptics, pulse animation, AsyncStorage,
// onTranscript emission).
//
// INVARIANT (commit 3309ef6, mirrored from sttErrorPolicy): when the error
// listener has latched errorHandlingRef, the `end` listener must do NOTHING
// for an active on-device session — the error ladder owns the restart. Acting
// here too schedules a second overlapping restart; the sessions then kill each
// other inside Speech Services (code 11 storm) until failover blacklists a
// working recognizer. decideEndEvent encodes that as 'ignore-latched'.

import { composeFlush } from './recognizerSelect';
import { shouldAutoStopOnSilence } from './sttErrorPolicy';

/** Delay before re-arming the recognizer after a self-terminated segment
 * (Soda silence/timeout end during an active tap-to-toggle session). */
export const SEGMENT_RESTART_DELAY_MS = 500;

/**
 * The three pieces of transcript state a dictation session accumulates:
 *  - finalSegments: per-utterance final results of the CURRENT recognizer
 *    session (continuous: true emits several per session);
 *  - interim: latest in-progress (isFinal=false) transcript of the current
 *    utterance, overwritten by each non-final result;
 *  - sessionText: text folded from PRIOR auto-restarted recognizer segments
 *    of the same dictation session (survives resetSegments).
 */
export interface TranscriptAccumulator {
  readonly finalSegments: readonly string[];
  readonly interim: string;
  readonly sessionText: string;
}

export const EMPTY_ACCUMULATOR: TranscriptAccumulator = {
  finalSegments: [],
  interim: '',
  sessionText: '',
};

/** Clear the per-recognizer-session segments while keeping the text already
 * folded from prior segments (used between auto-restarted segments). */
export function resetSegments(acc: TranscriptAccumulator): TranscriptAccumulator {
  return { finalSegments: [], interim: '', sessionText: acc.sessionText };
}

/** Current recognizer-session text: finals joined, plus the trailing interim. */
export function composeText(acc: TranscriptAccumulator): string {
  const finals = acc.finalSegments.join(' ').trim();
  const interim = acc.interim.trim();
  if (finals && interim) return `${finals} ${interim}`;
  return finals || interim;
}

/**
 * The full transcript to commit when a dictation session ends (manual stop
 * tap, external stopAndFlush, or silence auto-stop): prior folded segments +
 * the current segment's text, promoting any in-progress interim to final.
 */
export function composeSessionFlush(acc: TranscriptAccumulator): string {
  return composeFlush(acc.sessionText, composeText(acc));
}

/** The non-final display string emitted while dictating. */
export function composeDisplay(acc: TranscriptAccumulator): string {
  const current = composeText(acc);
  return acc.sessionText ? `${acc.sessionText} ${current}` : current;
}

export interface ResultEventInput {
  /** results[0]?.transcript — may be undefined/empty on some recognizers. */
  transcript: string | undefined;
  isFinal: boolean;
  /** stopAndFlush() already committed this session — trailing results from the
   * native teardown must not re-accumulate or emit. */
  flushedExternally: boolean;
}

export type ResultOutcome =
  /** Trailing result after an external flush — drop it entirely. */
  | { type: 'ignore-flushed' }
  /** Empty transcript — nothing to accumulate. */
  | { type: 'ignore-empty' }
  /** Real transcript: caller stores `acc`, commits any staged recognizer
   * persist (first real result proves the engine works), resets the silent-end
   * counter when `resetsSilentEnds`, and emits `display` as a non-final update. */
  | {
      type: 'accumulate';
      acc: TranscriptAccumulator;
      display: string;
      resetsSilentEnds: boolean;
    };

/** Mirror of the `result` listener's accumulation logic. */
export function applyResultEvent(
  acc: TranscriptAccumulator,
  input: ResultEventInput,
): ResultOutcome {
  if (input.flushedExternally) return { type: 'ignore-flushed' };
  if (!input.transcript) return { type: 'ignore-empty' };
  const next: TranscriptAccumulator = input.isFinal
    ? {
        finalSegments: [...acc.finalSegments, input.transcript],
        interim: '',
        sessionText: acc.sessionText,
      }
    : { ...acc, interim: input.transcript };
  return {
    type: 'accumulate',
    acc: next,
    display: composeDisplay(next),
    // A final segment proves the session is not silent; interim updates don't
    // count until they finalize.
    resetsSilentEnds: input.isFinal,
  };
}

export interface EndEventInput {
  /** Tap-to-toggle session still active (user hasn't tapped stop). */
  pressActive: boolean;
  /** The active session is the on-device engine. */
  activeEngineOnDevice: boolean;
  /** The error listener latched errorHandlingRef — it owns any restart. */
  errorHandlingLatched: boolean;
  /** stopAndFlush() already committed this session. */
  flushedExternally: boolean;
  /** Consecutive silent ends BEFORE this end event. */
  consecutiveSilentEnds: number;
}

export type EndOutcome =
  /** Error ladder owns this end (3309ef6 invariant) — do nothing. */
  | { type: 'ignore-latched' }
  /** Segment produced text: caller stores `acc` (text folded into sessionText,
   * segments cleared), zeroes the silent-end counter, tears down the segment
   * UI (isListening/pulse) and schedules a restart. */
  | {
      type: 'fold-and-restart';
      acc: TranscriptAccumulator;
      consecutiveSilentEnds: 0;
      restartDelayMs: number;
    }
  /** Silent end, below the auto-stop threshold: caller stores `acc` and the
   * incremented counter, then restarts like fold-and-restart. */
  | {
      type: 'restart-after-silence';
      acc: TranscriptAccumulator;
      consecutiveSilentEnds: number;
      restartDelayMs: number;
    }
  /** Enough consecutive silent ends — end the session on quiet. `finalText`
   * ('' when nothing was ever said) is what the auto-stop commit flushes. */
  | { type: 'auto-stop-commit'; finalText: string }
  /** `end` arriving after an external stopAndFlush — already committed; caller
   * clears the flushed guard and tears the session down without emitting. */
  | { type: 'teardown-flushed' }
  /** User tapped stop (or max-duration fired): commit `finalText` (skip the
   * emit when empty) and tear the session down. */
  | { type: 'commit-final'; finalText: string };

/** Mirror of the `end` listener's branch order exactly. */
export function decideEndEvent(
  acc: TranscriptAccumulator,
  input: EndEventInput,
): EndOutcome {
  const text = composeText(acc);

  if (input.pressActive && input.activeEngineOnDevice) {
    if (input.errorHandlingLatched) return { type: 'ignore-latched' };
    if (text) {
      return {
        type: 'fold-and-restart',
        acc: {
          finalSegments: [],
          interim: '',
          sessionText: acc.sessionText ? `${acc.sessionText} ${text}` : text,
        },
        consecutiveSilentEnds: 0,
        restartDelayMs: SEGMENT_RESTART_DELAY_MS,
      };
    }
    const silentEnds = input.consecutiveSilentEnds + 1;
    if (shouldAutoStopOnSilence(silentEnds)) {
      // No new text this segment, so the flush is just the folded sessionText.
      return { type: 'auto-stop-commit', finalText: composeSessionFlush(acc) };
    }
    return {
      type: 'restart-after-silence',
      acc: resetSegments(acc),
      consecutiveSilentEnds: silentEnds,
      restartDelayMs: SEGMENT_RESTART_DELAY_MS,
    };
  }

  if (input.flushedExternally) return { type: 'teardown-flushed' };

  return { type: 'commit-final', finalText: composeSessionFlush(acc) };
}
