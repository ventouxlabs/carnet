// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Pure decision logic for VoiceButton's STT `error` listener, split out (like
// sttErrorMessage.ts / recognizerSelect.ts) so the numbered error-branch ladder
// is unit-testable without pulling in react-native / expo-speech-recognition /
// AsyncStorage. This module decides WHAT to do; VoiceButton keeps every side
// effect (refs, AsyncStorage, setTimeout scheduling, showErr, triggerDetection).
//
// INVARIANT (commit 3309ef6): every action that schedules or triggers a recognizer
// restart carries `keepsErrorHandlingLatched: true`. The caller must NOT reset
// errorHandlingRef when acting on those — only the restarted session's native
// `start` event (or an explicit user action) may reset it. Resetting it inside a
// deferred-restart branch lets the imminent `end` event schedule a SECOND restart
// that stomps the first; the overlapping sessions then kill each other inside
// Speech Services (surfacing as repeated code 11) until failover blacklists a
// perfectly working recognizer and lands on a false "no working speech service"
// sheet with the mic left open (observed on-device 2026-07-11: five overlapping
// starts in 1.5s after one silence timeout).

import { isFailoverEligibleCode } from './sttErrorMessage';

/**
 * Number of CONSECUTIVE silent session ends (a code-7 no-speech end, or an
 * `end` whose segment produced no new final text) that ends dictation on quiet
 * instead of auto-restarting forever. Soda's silence window is ~9s, so 2 back-
 * to-back silent ends is ~18-20s of continuous quiet — long enough to be
 * intentional, short enough not to strand an open mic until the 3-min cap. Any
 * segment that yields final text resets the count to 0.
 */
export const SILENCE_AUTO_STOP_AFTER = 2;

/**
 * Whether `consecutiveSilentEnds` (counting the current silent end) has reached
 * the auto-stop threshold. Shared by the code-7 error branch (via
 * decideSttErrorAction) and VoiceButton's `end`-listener silent-restart branch,
 * which lives outside the error ladder but must use the same threshold.
 */
export function shouldAutoStopOnSilence(consecutiveSilentEnds: number): boolean {
  return consecutiveSilentEnds >= SILENCE_AUTO_STOP_AFTER;
}

/**
 * Session-blacklist revival for USER-RECOVERABLE failures, applied at every
 * fresh user-initiated session start (dictate tap / picker selection).
 *
 * Code 9 (service-not-allowed) means the recognizer app's own RECORD_AUDIO is
 * revoked — a condition the user can fix in Settings while this app session
 * stays alive. The mic-revoked sheet explicitly tells them to "enable
 * Microphone, then try dictation again", so a fresh tap MUST re-test those
 * packages: without this, the code-9 entry in the session blacklist makes
 * every retry skip the (now working) recognizer and re-show the stale sheet —
 * an unrecoverable loop unless the user happens to tap Retry Detection
 * (observed on-device 2026-07-12 after re-granting the permission).
 *
 * Non-code-9 failures (absent package, unserviceable engine) stay blacklisted.
 * Returns a NEW set; never mutates the input.
 */
export function reviveUserRecoverablePkgs(
  sessionFailedPkgs: ReadonlySet<string>,
  code9Pkgs: ReadonlySet<string>,
): Set<string> {
  const revived = new Set(sessionFailedPkgs);
  for (const pkg of code9Pkgs) revived.delete(pkg);
  return revived;
}

/**
 * Which package a deferred-restart action should bind to when the caller acts:
 *  - 'last-attempted': the pkg of the session that just errored (a ref value)
 *  - 'saved':          re-read the persisted recognizer pkg from AsyncStorage
 */
export type RestartPkgSource = 'last-attempted' | 'saved';

/**
 * The no-service terminal sheet, classified. 'mic-revoked' is shown instead of
 * the default "install a speech service" copy when a code-9
 * (service-not-allowed) was observed this session for a package that is STILL
 * resolvable on the device — i.e. the recognizer app is installed but its own
 * RECORD_AUDIO was revoked (e.g. Android unused-app auto-revoke on
 * com.google.android.tts). Telling the user to "install" a service that IS
 * installed is wrong; the fix is to re-enable its Microphone permission.
 */
export type NoServiceSheet =
  | { variant: 'default' }
  | { variant: 'mic-revoked'; pkg: string; label: string };

/**
 * Discriminated union mirroring VoiceButton's original numbered error branches
 * exactly. The numbered comments below carry the decision that used to live
 * inline in the listener.
 */
export type SttErrorAction =
  // Inactive-session guards (pressActive === false)
  | { type: 'swallow-flushed' } // teardown error after an external stopAndFlush() — already committed
  | { type: 'swallow' } //          background silence (code 6/7) between utterances — ignore
  | { type: 'transient-toast' } //  other background error — brief transient message, no failover
  // Pre-branch: code 11 (SERVER_DISCONNECTED) single same-engine retry
  | { type: 'retry-same-engine'; delayMs: number; pkgSource: RestartPkgSource; keepsErrorHandlingLatched: true }
  // Pre-branch: code 7 (silence timeout) silent same-session restart
  | { type: 'silent-restart'; delayMs: number; pkgSource: RestartPkgSource; keepsErrorHandlingLatched: true }
  // Pre-branch: code 7 but enough consecutive silent ends accrued — end the
  // session on quiet, flushing accumulated text exactly like a manual stop tap.
  | { type: 'auto-stop-commit' }
  // 1. Failover: advance to the next queued candidate
  | { type: 'failover-next'; keepsErrorHandlingLatched: true }
  // 2. No-service / not-allowed (code 5/9) detect-or-clear ladder
  | { type: 'detect'; keepsErrorHandlingLatched: true }
  | { type: 'clear-label-and-detect'; keepsErrorHandlingLatched: true }
  | { type: 'retry-no-service'; delayMs: number; pkgSource: RestartPkgSource; keepsErrorHandlingLatched: true }
  | { type: 'clear-saved-and-detect'; resetNoServiceRetries: boolean; keepsErrorHandlingLatched: true }
  // 4. Language model unavailable — terminal sheet
  | { type: 'lang-unavailable-sheet' }
  // 4.5. Failover-eligible but chain exhausted & detection ran — terminal sheet
  | { type: 'no-service-sheet'; sheet: NoServiceSheet }
  // 5. Generic friendly error for everything else
  | { type: 'generic-error'; persist: boolean };

/**
 * Plain-data snapshot of the state VoiceButton's error handler reads. Booleans
 * stand in for ref/AsyncStorage presence so this stays free of native imports.
 */
export interface SttErrorPolicyInput {
  code: number;
  pressActive: boolean;
  flushedExternally: boolean;
  serverDisconnectRetries: number;
  noServiceRetries: number;
  failoverChainLength: number;
  detectionRan: boolean;
  /** saved recognizer pkg is non-null in AsyncStorage (only read for code 5/9) */
  hasSavedPkg: boolean;
  /** saved recognizer label is non-null in AsyncStorage (only read for code 5/9) */
  hasSavedLabel: boolean;
  /** lastAttemptedPkgRef holds a package this session */
  hasLastAttemptedPkg: boolean;
  /**
   * Count of consecutive silent session ends INCLUDING the current one (reset to
   * 0 by any segment that yields final text). Consulted only for code 7 to
   * decide silent-restart vs auto-stop. See SILENCE_AUTO_STOP_AFTER.
   */
  consecutiveSilentEnds: number;
  /**
   * A code-9 package observed this session that is STILL resolvable on the
   * device (installed but mic-permission revoked), or null. When set and the
   * decision reaches the terminal no-service sheet, the 'mic-revoked' variant
   * is chosen instead of the default install copy.
   */
  micRevoked: { pkg: string; label: string } | null;
}

/**
 * Classify the terminal no-service sheet. Exported so the detection flow — which
 * shows the same sheet without going through the error ladder — can reuse the
 * exact same decision.
 */
export function classifyNoServiceSheet(
  micRevoked: { pkg: string; label: string } | null,
): NoServiceSheet {
  return micRevoked
    ? { variant: 'mic-revoked', pkg: micRevoked.pkg, label: micRevoked.label }
    : { variant: 'default' };
}

/**
 * Decide what the STT error handler should do, mirroring VoiceButton's original
 * branch order exactly. Side effects (the sessionFailedPkgs mark, AsyncStorage
 * writes, timers, toasts, detection) are performed by the caller.
 */
export function decideSttErrorAction(input: SttErrorPolicyInput): SttErrorAction {
  const {
    code,
    pressActive,
    flushedExternally,
    serverDisconnectRetries,
    noServiceRetries,
    failoverChainLength,
    detectionRan,
    hasSavedPkg,
    hasSavedLabel,
    hasLastAttemptedPkg,
    micRevoked,
  } = input;

  // Guard: only run detection/failover when the user is actively in a session.
  // With continuous: true the recognizer restarts internally between utterances;
  // the `end` handler fires first (resetting pressActive), then a background
  // error arrives — these must not clear the saved pkg or trigger detection.
  if (!pressActive) {
    // A teardown error from an external stopAndFlush() (e.g. the picker Activity
    // grabbed audio focus) — already committed; swallow it AND clear the guard.
    if (flushedExternally) return { type: 'swallow-flushed' };
    // 6/7 = silence, expected after stop — swallow with no toast.
    if (code === 6 || code === 7) return { type: 'swallow' };
    return { type: 'transient-toast' };
  }

  // Code 11 (SERVER_DISCONNECTED) is usually a transient Soda drop, not a dead
  // recognizer. Retry the SAME engine once — BEFORE marking it failed — instead
  // of failing straight over to a possibly model-less fallback (e.g.
  // com.google.android.as with no language pack, which just returns code 12 and
  // lands on the no-service sheet). keepsErrorHandlingLatched: see 3309ef6.
  if (code === 11 && serverDisconnectRetries < 1 && hasLastAttemptedPkg) {
    return { type: 'retry-same-engine', delayMs: 400, pkgSource: 'last-attempted', keepsErrorHandlingLatched: true };
  }

  // (Caller marks lastAttemptedPkg failed here for failover-eligible codes.)

  // Code 7 (no-match / silence timeout) is benign — the recognizer heard nothing
  // during its window. Restart silently during an active session instead of
  // entering failover or the no-service handler, UNLESS enough consecutive silent
  // ends have accrued, in which case end the session on quiet (auto-stop-commit).
  // keepsErrorHandlingLatched on the restart: 3309ef6.
  if (code === 7) {
    if (shouldAutoStopOnSilence(input.consecutiveSilentEnds)) {
      return { type: 'auto-stop-commit' };
    }
    return { type: 'silent-restart', delayMs: 300, pkgSource: 'saved', keepsErrorHandlingLatched: true };
  }

  // 1. Failover: try the next candidate in the chain before giving up or
  //    re-running detection. Applies to language/server-availability errors AND
  //    no-service errors (5) — a picker-driven selection that fails should
  //    silently try the next queued candidate rather than bouncing back through
  //    detection to the same picker.
  if (isFailoverEligibleCode(code) && failoverChainLength > 0) {
    return { type: 'failover-next', keepsErrorHandlingLatched: true };
  }

  // 2. No-service / not-allowed errors — detect-or-clear flow.
  //    code 5 = client error (no service),
  //    code 9 = service-not-allowed (recognizer app's own RECORD_AUDIO revoked —
  //    e.g. Android auto-revoke on "unused" com.google.android.tts; the proxied
  //    AppOps mic check fails on the recognizer side, not the caller's).
  if (code === 5 || code === 9) {
    if (!hasSavedPkg && !hasSavedLabel) {
      return { type: 'detect', keepsErrorHandlingLatched: true };
    }
    if (!hasSavedPkg && hasSavedLabel) {
      // Stale label with no pkg (e.g. user previously picked System Default,
      // which clears pkg but sets label). Clear it and re-detect fresh.
      return { type: 'clear-label-and-detect', keepsErrorHandlingLatched: true };
    }
    // Android 16: after a continuous session ends, Soda's service is briefly
    // mid-teardown and returns ERROR_CLIENT (code 5) on immediate re-start.
    // Retry once after 700ms before wiping state and running detection.
    if (noServiceRetries < 1) {
      return { type: 'retry-no-service', delayMs: 700, pkgSource: 'saved', keepsErrorHandlingLatched: true };
    }
    return { type: 'clear-saved-and-detect', resetNoServiceRetries: true, keepsErrorHandlingLatched: true };
  }

  // 3. Failover-eligible code but chain is empty. If detection hasn't run this
  //    session, a fresh scan may surface more candidates; also clear the saved
  //    pkg since it just failed.
  if (isFailoverEligibleCode(code) && !detectionRan) {
    return { type: 'clear-saved-and-detect', resetNoServiceRetries: false, keepsErrorHandlingLatched: true };
  }

  // 4. Language-specific final error — chain exhausted, detection ran.
  if (code === 11 || code === 12) {
    return { type: 'lang-unavailable-sheet' };
  }

  // 4.5. Any other failover-eligible code (e.g. -1, the native catch-all for an
  //    absent pinned recognizer, or 13) that reaches here has an exhausted chain
  //    AND detection already ran — same terminal state as branch 3, just arrived
  //    at after detection instead of before it. Show the no-service sheet
  //    (mic-revoked variant when a resolvable code-9 pkg was seen this session).
  if (isFailoverEligibleCode(code)) {
    return { type: 'no-service-sheet', sheet: classifyNoServiceSheet(micRevoked) };
  }

  // 5. Generic friendly error for everything else. Only truly transient errors
  //    auto-dismiss (6 = no speech, 8 = busy).
  return { type: 'generic-error', persist: ![6, 8].includes(code) };
}
