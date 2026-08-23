// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  classifyNoServiceSheet,
  decideSttErrorAction,
  reviveUserRecoverablePkgs,
  shouldAutoStopOnSilence,
  SILENCE_AUTO_STOP_AFTER,
  type SttErrorPolicyInput,
} from './sttErrorPolicy';

// Base snapshot: an ACTIVE session with no retries, no chain, nothing saved.
// Each test overrides only the fields that matter, mirroring how VoiceButton's
// error handler is entered.
function input(overrides: Partial<SttErrorPolicyInput> = {}): SttErrorPolicyInput {
  return {
    code: -1,
    pressActive: true,
    flushedExternally: false,
    serverDisconnectRetries: 0,
    noServiceRetries: 0,
    failoverChainLength: 0,
    detectionRan: false,
    hasSavedPkg: false,
    hasSavedLabel: false,
    hasLastAttemptedPkg: true,
    micRevoked: null,
    consecutiveSilentEnds: 0,
    ...overrides,
  };
}

describe('decideSttErrorAction — inactive session (pressActive === false)', () => {
  it('swallows a teardown error after an external flush', () => {
    expect(decideSttErrorAction(input({ pressActive: false, flushedExternally: true, code: 3 })))
      .toEqual({ type: 'swallow-flushed' });
  });

  // (f) !pressActive codes 6/7 → swallow (no toast)
  it.each([6, 7])('swallows background silence code %i with no toast', (code) => {
    expect(decideSttErrorAction(input({ pressActive: false, code })))
      .toEqual({ type: 'swallow' });
  });

  // (f) !pressActive other codes → transient-toast
  it.each([1, 3, 5, 9, 11])('shows a transient toast for background code %i', (code) => {
    expect(decideSttErrorAction(input({ pressActive: false, code })))
      .toEqual({ type: 'transient-toast' });
  });

  it('prefers swallow-flushed over the code check when both apply', () => {
    // flushedExternally wins even for a code that would otherwise toast.
    expect(decideSttErrorAction(input({ pressActive: false, flushedExternally: true, code: 5 })))
      .toEqual({ type: 'swallow-flushed' });
  });
});

describe('decideSttErrorAction — code 11 server-disconnect single retry', () => {
  // (b) code 11 first occurrence with a last-attempted pkg → retry-same-engine, latched
  it('retries the same engine on the first code-11 with a last-attempted pkg', () => {
    expect(decideSttErrorAction(input({ code: 11, serverDisconnectRetries: 0, hasLastAttemptedPkg: true })))
      .toEqual({ type: 'retry-same-engine', delayMs: 400, pkgSource: 'last-attempted', keepsErrorHandlingLatched: true });
  });

  it('does not retry-same-engine without a last-attempted pkg', () => {
    // Falls through to the failover-eligible ladder (chain empty, detection not
    // run) → clear saved + detect.
    expect(decideSttErrorAction(input({ code: 11, serverDisconnectRetries: 0, hasLastAttemptedPkg: false })))
      .toEqual({ type: 'clear-saved-and-detect', resetNoServiceRetries: false, keepsErrorHandlingLatched: true });
  });

  // (c) code 11 second occurrence → failover path (chain non-empty → advance)
  it('advances failover on the second code-11 when the chain still has candidates', () => {
    expect(decideSttErrorAction(input({ code: 11, serverDisconnectRetries: 1, failoverChainLength: 2 })))
      .toEqual({ type: 'failover-next', keepsErrorHandlingLatched: true });
  });

  it('second code-11 with empty chain + detection run → lang-unavailable sheet', () => {
    expect(decideSttErrorAction(input({ code: 11, serverDisconnectRetries: 1, failoverChainLength: 0, detectionRan: true })))
      .toEqual({ type: 'lang-unavailable-sheet' });
  });

  it('second code-11 with empty chain + detection NOT run → clear saved + detect', () => {
    expect(decideSttErrorAction(input({ code: 11, serverDisconnectRetries: 1, failoverChainLength: 0, detectionRan: false })))
      .toEqual({ type: 'clear-saved-and-detect', resetNoServiceRetries: false, keepsErrorHandlingLatched: true });
  });
});

describe('decideSttErrorAction — code 7 silence timeout', () => {
  // (a) code 7 with pressActive → silent-restart, latched
  it('restarts silently and stays latched', () => {
    expect(decideSttErrorAction(input({ code: 7 })))
      .toEqual({ type: 'silent-restart', delayMs: 300, pkgSource: 'saved', keepsErrorHandlingLatched: true });
  });

  it('takes precedence over failover even when a chain exists', () => {
    expect(decideSttErrorAction(input({ code: 7, failoverChainLength: 3 })))
      .toEqual({ type: 'silent-restart', delayMs: 300, pkgSource: 'saved', keepsErrorHandlingLatched: true });
  });
});

describe('decideSttErrorAction — code 7 silence auto-stop (Task 3)', () => {
  it('1st silent end (count 1) → silent restart', () => {
    expect(decideSttErrorAction(input({ code: 7, consecutiveSilentEnds: 1 })))
      .toEqual({ type: 'silent-restart', delayMs: 300, pkgSource: 'saved', keepsErrorHandlingLatched: true });
  });

  it('2nd consecutive silent end (count 2) → auto-stop-commit', () => {
    expect(decideSttErrorAction(input({ code: 7, consecutiveSilentEnds: 2 })))
      .toEqual({ type: 'auto-stop-commit' });
  });

  it('threshold matches SILENCE_AUTO_STOP_AFTER (restart just below, stop at)', () => {
    expect(decideSttErrorAction(input({ code: 7, consecutiveSilentEnds: SILENCE_AUTO_STOP_AFTER - 1 })).type)
      .toBe('silent-restart');
    expect(decideSttErrorAction(input({ code: 7, consecutiveSilentEnds: SILENCE_AUTO_STOP_AFTER })).type)
      .toBe('auto-stop-commit');
  });
});

describe('shouldAutoStopOnSilence (Task 3)', () => {
  it('is false below the threshold and true at/above it', () => {
    expect(shouldAutoStopOnSilence(0)).toBe(false);
    expect(shouldAutoStopOnSilence(SILENCE_AUTO_STOP_AFTER - 1)).toBe(false);
    expect(shouldAutoStopOnSilence(SILENCE_AUTO_STOP_AFTER)).toBe(true);
    expect(shouldAutoStopOnSilence(SILENCE_AUTO_STOP_AFTER + 1)).toBe(true);
  });
});

describe('decideSttErrorAction — failover advance (branch 1)', () => {
  it.each([-1, 5, 9, 12, 13])('advances the chain for failover-eligible code %i', (code) => {
    expect(decideSttErrorAction(input({ code, failoverChainLength: 1 })))
      .toEqual({ type: 'failover-next', keepsErrorHandlingLatched: true });
  });

  it('does not advance for a non-failover-eligible code even with a chain', () => {
    // code 3 (audio error) is not failover-eligible → generic error.
    expect(decideSttErrorAction(input({ code: 3, failoverChainLength: 5 })))
      .toEqual({ type: 'generic-error', persist: true });
  });
});

describe('decideSttErrorAction — code 5/9 detect-or-clear ladder (branch 2)', () => {
  // (d) the full ladder for both codes, chain empty so branch 2 is reached
  it.each([5, 9])('code %i: nothing saved → detect', (code) => {
    expect(decideSttErrorAction(input({ code, hasSavedPkg: false, hasSavedLabel: false })))
      .toEqual({ type: 'detect', keepsErrorHandlingLatched: true });
  });

  it.each([5, 9])('code %i: label saved but no pkg → clear label + detect', (code) => {
    expect(decideSttErrorAction(input({ code, hasSavedPkg: false, hasSavedLabel: true })))
      .toEqual({ type: 'clear-label-and-detect', keepsErrorHandlingLatched: true });
  });

  it.each([5, 9])('code %i: saved pkg, first retry → retry-no-service (700ms)', (code) => {
    expect(decideSttErrorAction(input({ code, hasSavedPkg: true, hasSavedLabel: true, noServiceRetries: 0 })))
      .toEqual({ type: 'retry-no-service', delayMs: 700, pkgSource: 'saved', keepsErrorHandlingLatched: true });
  });

  it.each([5, 9])('code %i: saved pkg, retry exhausted → clear saved + detect (reset retries)', (code) => {
    expect(decideSttErrorAction(input({ code, hasSavedPkg: true, hasSavedLabel: true, noServiceRetries: 1 })))
      .toEqual({ type: 'clear-saved-and-detect', resetNoServiceRetries: true, keepsErrorHandlingLatched: true });
  });

  it('code 5/9 with a non-empty chain advances failover before the ladder', () => {
    expect(decideSttErrorAction(input({ code: 9, failoverChainLength: 1, hasSavedPkg: true })))
      .toEqual({ type: 'failover-next', keepsErrorHandlingLatched: true });
  });
});

describe('decideSttErrorAction — terminal states (branches 3, 4, 4.5, 5)', () => {
  it('branch 3: failover-eligible, chain empty, detection NOT run → clear saved + detect', () => {
    expect(decideSttErrorAction(input({ code: 13, failoverChainLength: 0, detectionRan: false })))
      .toEqual({ type: 'clear-saved-and-detect', resetNoServiceRetries: false, keepsErrorHandlingLatched: true });
  });

  it.each([11, 12])('branch 4: language code %i, chain empty, detection run → lang-unavailable sheet', (code) => {
    // serverDisconnectRetries: 1 so code 11 skips its earlier single retry.
    expect(decideSttErrorAction(input({ code, serverDisconnectRetries: 1, failoverChainLength: 0, detectionRan: true })))
      .toEqual({ type: 'lang-unavailable-sheet' });
  });

  // (e) chain-exhausted + detectionRan + failover-eligible → no-service-sheet
  it.each([-1, 13])('branch 4.5: failover-eligible code %i, chain exhausted, detection run → no-service sheet', (code) => {
    expect(decideSttErrorAction(input({ code, failoverChainLength: 0, detectionRan: true })))
      .toEqual({ type: 'no-service-sheet', sheet: { variant: 'default' } });
  });

  it('branch 4.5: mic-revoked variant when a resolvable code-9 pkg was seen', () => {
    expect(decideSttErrorAction(input({
      code: -1,
      failoverChainLength: 0,
      detectionRan: true,
      micRevoked: { pkg: 'com.google.android.tts', label: 'Speech Services by Google' },
    }))).toEqual({
      type: 'no-service-sheet',
      sheet: { variant: 'mic-revoked', pkg: 'com.google.android.tts', label: 'Speech Services by Google' },
    });
  });

  it('branch 5: generic persistent error for a non-transient, non-failover code', () => {
    expect(decideSttErrorAction(input({ code: 3 })))
      .toEqual({ type: 'generic-error', persist: true });
  });

  it.each([6, 8])('branch 5: generic transient (auto-dismiss) for code %i', (code) => {
    expect(decideSttErrorAction(input({ code })))
      .toEqual({ type: 'generic-error', persist: false });
  });
});

describe('classifyNoServiceSheet', () => {
  it('returns the default variant when no mic-revoked pkg was observed', () => {
    expect(classifyNoServiceSheet(null)).toEqual({ variant: 'default' });
  });

  it('returns the mic-revoked variant carrying the pkg + label', () => {
    expect(classifyNoServiceSheet({ pkg: 'com.google.android.tts', label: 'Speech Services by Google' }))
      .toEqual({ variant: 'mic-revoked', pkg: 'com.google.android.tts', label: 'Speech Services by Google' });
  });
});

describe('reviveUserRecoverablePkgs', () => {
  const TTS = 'com.google.android.tts';
  const AS = 'com.google.android.as';

  // Regression (observed on-device 2026-07-12): after a code-9 the user fixes
  // the recognizer's mic permission, taps dictate again, and must NOT be
  // routed around the now-working recognizer by the stale session blacklist.
  it('removes code-9 pkgs from the session blacklist so a fresh tap re-tests them', () => {
    const revived = reviveUserRecoverablePkgs(new Set([TTS, AS]), new Set([TTS]));
    expect(revived).toEqual(new Set([AS]));
  });

  it('keeps non-code-9 failures blacklisted', () => {
    const revived = reviveUserRecoverablePkgs(new Set([AS]), new Set());
    expect(revived).toEqual(new Set([AS]));
  });

  it('is a no-op on empty inputs', () => {
    expect(reviveUserRecoverablePkgs(new Set(), new Set())).toEqual(new Set());
  });

  it('returns a new set and never mutates the input', () => {
    const original = new Set([TTS]);
    const revived = reviveUserRecoverablePkgs(original, new Set([TTS]));
    expect(original).toEqual(new Set([TTS]));
    expect(revived).not.toBe(original);
  });
});
