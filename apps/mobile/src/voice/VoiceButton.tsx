// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
// NOTE: expo-intent-launcher's JS wrapper is deliberately NOT imported. Its
// Android accessor runs requireNativeModule() eagerly at import time, which
// crashes the whole capture surface at bundle eval on a client built before
// the dependency was added. openAppDetails reaches the native module via
// requireOptionalNativeModule('ExpoIntentLauncher') instead, which returns
// null (never throws) so the Linking.openSettings() fallback can run.
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Animated, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Icon } from 'react-native-paper';
import { MIN_TAP_TARGET, useCarnetTheme } from '../lib/theme';
import {
  type RecognizerOption,
  isPinnedRecognizer,
  resolveEffectivePkg,
  pinnedFailoverChain,
} from './recognizerSelect';
import { triggerVoiceModelDownload } from './sttReadiness';
import { describeSttError, isFailoverEligibleCode } from './sttErrorMessage';
import {
  classifyNoServiceSheet,
  decideSttErrorAction,
  reviveUserRecoverablePkgs,
  type NoServiceSheet,
} from './sttErrorPolicy';
import {
  EMPTY_ACCUMULATOR,
  applyResultEvent,
  composeSessionFlush,
  decideEndEvent,
  resetSegments,
  type TranscriptAccumulator,
} from './dictationSession';
import {
  MAX_RECORDING_MS,
  KNOWN_BAD_PKGS,
  SODA_DICTATION_MODEL,
  KNOWN_RECOGNIZERS,
  NO_SERVICE_MESSAGE,
  PREFERRED_LANG,
  STT_ENGINE_KEY,
  STT_RECOGNIZER_PKG_KEY,
  STT_RECOGNIZER_LABEL_KEY,
  labelForPackage,
  type ErrAction,
  type MicRevokedTarget,
} from './recognizerCatalog';
import { collectDiagnostics, detectAvailableRecognizers, pickBestLocale } from './sttDeviceProbe';
import { VoiceErrorSheet } from './VoiceErrorSheet';
import { VoiceRecognizerPicker } from './VoiceRecognizerPicker';

export { STT_ENGINE_KEY, STT_RECOGNIZER_PKG_KEY, STT_RECOGNIZER_LABEL_KEY };

// sttErrorMessage moved to ./sttErrorMessage.ts (describeSttError) so the
// numeric-code / string-enum fallback logic is unit-testable without
// pulling in this file's RN/expo native imports. Kept as a thin local alias
// so the two call sites below don't need renaming.
const sttErrorMessage = describeSttError;

interface VoiceButtonProps {
  onTranscript: (text: string, isFinal: boolean) => void;
  disabled?: boolean;
}

export interface VoiceButtonHandle {
  /** Stop recording and commit the in-progress transcript as final, instead of
   * losing it. No-op when not recording. The parent calls this before it opens
   * a picker / mutates state mid-dictation so the spoken words are saved. */
  stopAndFlush: () => void;
}

export const VoiceButton = forwardRef<VoiceButtonHandle, VoiceButtonProps>(
  function VoiceButton({ onTranscript, disabled }, ref) {
  const theme = useCarnetTheme();
  const [isListening, setIsListening] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [errPersist, setErrPersist] = useState(false);
  const [errAction, setErrAction] = useState<ErrAction>('none');
  const errPersistRef = useRef(false);
  const [detecting, setDetecting] = useState(false);
  // True while an in-app on-device voice-model download is in flight, so the
  // "Download voice model" button can disable + show progress.
  const [downloadingModel, setDownloadingModel] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerOptions, setPickerOptions] = useState<RecognizerOption[]>([]);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);
  const errTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);
  const onTranscriptRef = useRef(onTranscript);

  // Ordered list of pkg candidates to try if the current recognizer fails
  // with a failover-eligible code. Shift-from-front; empty means no more
  // fallbacks and the error is final.
  const failoverChainRef = useRef<string[]>([]);
  // True once detection has seeded the chain this session, so a later failure
  // doesn't loop back into detection indefinitely.
  const detectionRanRef = useRef(false);
  // Retry counter for code-5/7 errors: Android 16 Soda may return ERROR_CLIENT
  // immediately after a continuous session ends (mid-teardown). Retry once with
  // a short delay before concluding the service is gone. Resets on successful start.
  const noServiceRetryRef = useRef(0);
  // Last raw STT error — surfaced in the diagnostics dump so the user can
  // share it in a bug report instead of just the friendly message.
  const lastErrorRef = useRef<string | null>(null);
  // Ring buffer of recent recognizer lifecycle events. Populated by every
  // listener so diagnostics can show whether the mic ever opened, whether
  // speech was detected, how long between events, etc.
  const eventBufferRef = useRef<string[]>([]);
  // Watchdog for "recognizer started but audio never flowed" — the silent
  // hang mode where nothing errors and nothing transcribes.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when an audio/speech event is observed so the watchdog knows audio
  // flowed and skips the hang handler.
  const audioSeenRef = useRef(false);
  const errorHandlingRef = useRef(false);
  const sessionFailedPkgsRef = useRef<Set<string>>(new Set());
  const lastAttemptedPkgRef = useRef<string | null>(null);
  // Packages that raised a code 9 (service-not-allowed) this session. Used to
  // offer the mic-revoked variant of the terminal no-service sheet when such a
  // package is still resolvable on the device (installed but its own
  // RECORD_AUDIO was revoked). Cleared alongside sessionFailedPkgs in retryDetection.
  const code9PkgsRef = useRef<Set<string>>(new Set());
  // Target package for the mic-revoked sheet's "Open App info" deep link, plus
  // its label for the button copy. Set when that sheet variant is shown.
  const [micRevokedTarget, setMicRevokedTarget] = useState<MicRevokedTarget | null>(null);
  // Consecutive silent session ends (code-7 no-speech end, or an `end` with no
  // new final text). Reset to 0 by any final transcript; drives silence auto-stop.
  const consecutiveSilentEndsRef = useRef(0);

  // ── Tap-to-toggle recording state ───────────────────────────────────────
  // True while a recording session is active (between the start tap and the
  // end tap). Async paths must check this between awaits so a stop in flight
  // aborts the start.
  const pressActiveRef = useRef(false);
  // Transcript accumulator (final segments + interim + folded session text).
  // continuous: true emits multiple isFinal results during a session (Soda
  // re-arms after each utterance boundary); we accumulate, then flush on
  // stop as a single isFinal=true callback. All transitions go through the
  // pure helpers in ./dictationSession so the interplay is unit-testable.
  const accRef = useRef<TranscriptAccumulator>(EMPTY_ACCUMULATOR);
  // Set by stopAndFlush() so the `end` listener's user-stop branch doesn't
  // commit the transcript a second time after we've already flushed it.
  const flushedExternallyRef = useRef(false);
  // Recognizer auto-selected by detection but NOT yet persisted — we only write
  // it to AsyncStorage once it yields a real result (see the result listener),
  // so an enumerated-but-broken engine can't get remembered and re-fail every
  // launch. Cleared at detection-start and session-start so it can't leak.
  const pendingPersistRef = useRef<{ pkg: string; label: string } | null>(null);
  // Retry-once guard for code 11 (SERVER_DISCONNECTED), a transient Soda drop —
  // retry the same engine before failing over to a possibly model-less fallback.
  const serverDisconnectRetryRef = useRef(0);
  // Which engine the active session is using — used by handlePressOut to
  // route to stopOnDevice without re-reading AsyncStorage.
  const activeEngineRef = useRef<'ondevice' | null>(null);
  // Safety cap timer — auto-stops at MAX_RECORDING_MS so a forgotten
  // session can't pin the mic open forever.
  const maxDurationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Note: com.google.android.tts is intentionally NOT in KNOWN_BAD_PKGS (defined at module scope).
  // expo-speech-recognition docs explicitly list it as a valid getDefaultRecognitionService() return on some devices.

  // Self-heal: clear known-bad recognizer packages
  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY).then((pkg) => {
      if (!mounted) return;
      if (pkg && KNOWN_BAD_PKGS.includes(pkg)) {
        // Fire-and-forget cache eviction — a failed remove just means the
        // known-bad pkg gets re-evicted on the next mount.
        void AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
        void AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
      }
    }).catch(() => { /* ignore teardown rejections */ });
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Master unmount cleanup: stop all timers and animation loops so they
  // can't fire setState after the component (and Jest env) have torn down.
  useEffect(() => {
    return () => {
      if (errTimeout.current) { clearTimeout(errTimeout.current); errTimeout.current = null; }
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      if (maxDurationTimer.current) { clearTimeout(maxDurationTimer.current); maxDurationTimer.current = null; }
      pulseLoop.current?.stop(); pulseLoop.current = null;
      if (started.current) {
        try { ExpoSpeechRecognitionModule.stop(); } catch { /* ignore */ }
        started.current = false;
      }
    };
  }, []);

  useEffect(() => { onTranscriptRef.current = onTranscript; });

  const showErrRef = useRef((msg: string, ms = 8000, persist = false, action: ErrAction = 'none') => {
    // Guard: a persistent error must not be clobbered by a transient one.
    if (errPersistRef.current && !persist) return;
    errPersistRef.current = persist;
    setErrMsg(msg);
    setErrPersist(persist);
    setErrAction(action);
    if (errTimeout.current) clearTimeout(errTimeout.current);
    if (!persist) {
      errTimeout.current = setTimeout(() => {
        errTimeout.current = null;
        setErrMsg('');
      }, ms);
    }
  });

  const dismissErr = useCallback(() => {
    errPersistRef.current = false;
    setErrMsg('');
    setErrPersist(false);
    setErrAction('none');
  }, []);

  const openPlayStore = useCallback((pkg: string) => {
    const market = `market://details?id=${pkg}`;
    const web = `https://play.google.com/store/apps/details?id=${pkg}`;
    Linking.openURL(market).catch(() => Linking.openURL(web));
  }, []);

  const openAppSettings = useCallback(() => {
    Linking.openSettings().catch(() => {});
  }, []);

  // Deep-link to Android's App info screen for a SPECIFIC package (the recognizer
  // whose mic permission was revoked) so the user can re-enable Microphone there.
  // RN's Linking can't pass a data URI to an arbitrary settings action, so this
  // uses expo-intent-launcher's ACTION_APPLICATION_DETAILS_SETTINGS. Falls back to
  // this app's own settings if the intent can't be launched.
  const openAppDetails = useCallback((pkg: string) => {
    // requireOptionalNativeModule returns null (never throws) when the
    // installed client predates the expo-intent-launcher native module —
    // try/catch around require() is NOT enough, Metro's dev guard reports a
    // module-factory throw as fatal before the catch runs. The native method
    // is startActivity(action, params) (expo-intent-launcher's JS wrapper is
    // deliberately not imported so its eager requireNativeModule never runs).
    const launcher = requireOptionalNativeModule<{
      startActivity: (action: string, params: { data: string }) => Promise<unknown>;
    }>('ExpoIntentLauncher');
    // Guard the METHOD too, not just the module: a present-but-incompatible
    // native module without startActivity would throw synchronously, escaping
    // the promise .catch below and skipping the fallback entirely.
    if (!launcher?.startActivity) {
      Linking.openSettings().catch(() => {});
      return;
    }
    launcher
      .startActivity('android.settings.APPLICATION_DETAILS_SETTINGS', { data: `package:${pkg}` })
      .catch(() => { Linking.openSettings().catch(() => {}); });
  }, []);

  const retryDetection = useCallback(async () => {
    await AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
    await AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
    // Reassign (not .clear()) to match the revival sites' idiom — fresh Set
    // identity everywhere these refs are reset.
    sessionFailedPkgsRef.current = new Set();
    code9PkgsRef.current = new Set();
    consecutiveSilentEndsRef.current = 0;
    errorHandlingRef.current = false;
    detectionRanRef.current = false;
    dismissErr();
    await triggerDetectionRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissErr]);

  // Pull the on-device English voice model from inside the app (Android 13+),
  // the in-app fix for the code-12 / "no service found" dead-end. On success
  // we dismiss the sheet and retry dictation with the saved recognizer; for a
  // queued/dialog download we leave a hint; on failure we point at Speech Services.
  const handleDownloadModel = useCallback(async () => {
    setDownloadingModel(true);
    try {
      const result = await triggerVoiceModelDownload(PREFERRED_LANG);
      if (result === 'installed') {
        dismissErr();
        await startRecognizerRef.current(await AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY));
      } else if (result === 'dialog' || result === 'scheduled') {
        showErrRef.current('Downloading the English voice model… try dictation again in a moment.', 6000);
      } else {
        showErrRef.current('Could not start the model download. Open Speech Services to install it.', 5000);
      }
    } finally {
      setDownloadingModel(false);
    }
  }, [dismissErr]);

  const copyDiagnostics = useCallback(async () => {
    const text = await collectDiagnostics(lastErrorRef.current, [...eventBufferRef.current]);
    try { await Clipboard.setStringAsync(text); } catch { /* ignore */ }
    // Replace the current sheet with the diag view, force persistent.
    errPersistRef.current = true;
    if (errTimeout.current) { clearTimeout(errTimeout.current); errTimeout.current = null; }
    setErrMsg(text);
    setErrPersist(true);
    setErrAction('diag');
  }, []);

  const logEventRef = useRef((type: string, info?: unknown) => {
    const ts = new Date().toISOString().slice(11, 23);
    const suffix = info ? ' ' + JSON.stringify(info).slice(0, 120) : '';
    eventBufferRef.current.push(`${ts} ${type}${suffix}`);
    if (eventBufferRef.current.length > 40) eventBufferRef.current.shift();
  });

  const clearWatchdogRef = useRef(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  });

  const startWatchdogRef = useRef(() => {
    clearWatchdogRef.current();
    audioSeenRef.current = false;
    // 6s is enough that a cold recognizer has time to open the mic but short
    // enough that a genuinely-stuck one doesn't leave the user waiting.
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      if (!started.current) return;
      if (audioSeenRef.current) return;
      logEventRef.current('watchdog', { fired: true, reason: 'no-audio-6s' });
      stopListeningRef.current();
      lastErrorRef.current = 'watchdog: recognizer started but no audio captured within 6s';
      showErrRef.current(
        'Recognizer started but no audio was captured.\nThe English voice model may not be downloaded on this service, or another app is holding the mic. Tap "Copy diagnostics" to share the event log.',
        0, true, 'lang-unavailable',
      );
    }, 6000);
  });

  const startPulse = () => {
    pulseAnim.setValue(1);
    pulseLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    pulseLoop.current.start();
  };

  const stopPulse = () => {
    pulseLoop.current?.stop();
    pulseAnim.setValue(1);
  };

  const stopListening = useCallback(() => {
    if (!started.current) return;
    started.current = false;
    clearWatchdogRef.current();
    try { ExpoSpeechRecognitionModule.stop(); } catch {}
    setIsListening(false);
    stopPulse();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopListeningRef = useRef(stopListening);
  useEffect(() => { stopListeningRef.current = stopListening; });

  // Recording helpers ─────────────────────────────────────────────────────
  // Clears the per-segment state but keeps folded sessionText (see
  // resetSegments); full clears assign EMPTY_ACCUMULATOR directly.
  const resetAccumulator = useCallback(() => {
    accRef.current = resetSegments(accRef.current);
  }, []);

  const clearMaxTimer = useCallback(() => {
    if (maxDurationTimer.current) {
      clearTimeout(maxDurationTimer.current);
      maxDurationTimer.current = null;
    }
  }, []);

  // Resolve a code-9 package that is STILL enumerable on the device — installed
  // but with its own mic permission revoked — for the mic-revoked no-service
  // sheet. Cheap no-op (no native call) until a code 9 has actually been seen.
  const resolveMicRevokedPkgRef = useRef((): { pkg: string; label: string } | null => {
    if (code9PkgsRef.current.size === 0) return null;
    let services: string[] = [];
    try {
      services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices() ?? [];
    } catch { /* enumeration unavailable — treat as not resolvable */ }
    for (const pkg of code9PkgsRef.current) {
      if (services.includes(pkg)) return { pkg, label: labelForPackage(pkg) };
    }
    return null;
  });

  // Single rendering path for the terminal no-service sheet (error ladder AND
  // detection), so the mic-revoked variant surfaces wherever the sheet appears.
  const showNoServiceSheetRef = useRef((sheet: NoServiceSheet) => {
    if (sheet.variant === 'mic-revoked') {
      setMicRevokedTarget({ pkg: sheet.pkg, label: sheet.label });
      showErrRef.current(
        `${sheet.label} is installed, but its Microphone permission is turned off, so it can't record audio for dictation.\nOpen its App info and enable Microphone, then try dictation again.`,
        0, true, 'no-service-mic-revoked',
      );
      return;
    }
    setMicRevokedTarget(null);
    showErrRef.current(NO_SERVICE_MESSAGE, 0, true, 'no-service');
  });

  // End the active session on quiet, flushing accumulated text exactly like a
  // manual stop tap (composeFlush of sessionText + any final segments). With no
  // text at all, tear down silently and show a brief transient toast.
  const autoStopCommitRef = useRef(() => {
    const finalText = composeSessionFlush(accRef.current);
    if (finalText) {
      onTranscriptRef.current(finalText, true);
    } else {
      showErrRef.current('No speech detected', 2500);
    }
    accRef.current = EMPTY_ACCUMULATOR;
    pressActiveRef.current = false;
    activeEngineRef.current = null;
    consecutiveSilentEndsRef.current = 0;
    clearMaxTimer();
    stopListeningRef.current();
  });

  // Fires the native recognizer. Shared by the start-tap path, post-detection
  // auto-start, and picker auto-start — all share the same start options.
  //
  // Android 16 (Sept 2025 security patch) flipped Soda's default LANGUAGE_MODEL
  // to AMBIENT_ONESHOT, which returns empty transcripts for dictation audio.
  // The fix is to ALWAYS pin com.google.android.tts as the recognizer (Pixel's
  // settings:secure:voice_recognition_service is null by default, so unpinned
  // createSpeechRecognizer() throws code 5) AND to pass EXTRA_LANGUAGE_MODEL=
  // 'web_search' so Soda routes through the dictation pipeline.
  //
  // Do NOT reintroduce requiresOnDeviceRecognition or EXTRA_PREFER_OFFLINE here:
  // both fail or are silently ignored on Android 16.
  const startRecognizerRef = useRef(async (pkg: string | null) => {
    // pkg meanings: non-empty string = explicit package; '' ("system default")
    // and null ("try defaults") both resolve to a pinned Google recognizer. We
    // deliberately never do a bare start (which would hand STT to Android's
    // registered default recognizer — on some devices a third-party app that
    // can't serve STT). See resolveEffectivePkg for the full rationale.
    const effectivePkg = resolveEffectivePkg(pkg, (p) =>
      sessionFailedPkgsRef.current.has(p),
    );
    if (pkg && pkg.length > 0 && effectivePkg !== pkg) {
      // The requested package already failed this session and was swapped for a
      // pinned fallback (or none) — leave a breadcrumb so field logs explain the
      // swap instead of silently routing to a different recognizer.
      logEventRef.current('pkg.substituted', { requested: pkg, used: effectivePkg });
      // Stage the pinned fallback for persist-on-first-result so a stale bad
      // saved pkg (e.g. a rogue recognizer like com.anthropic.claude that's
      // still in AsyncStorage) gets OVERWRITTEN once this engine actually works.
      // Without this, the bad pkg is retried + fails every session and churns
      // through failover, because the working fallback was never persisted.
      if (effectivePkg && isPinnedRecognizer(effectivePkg)) {
        pendingPersistRef.current = {
          pkg: effectivePkg,
          label: labelForPackage(effectivePkg),
        };
      }
    }
    if (effectivePkg === null) {
      if (!detectionRanRef.current) {
        await triggerDetectionRef.current();
      } else {
        pressActiveRef.current = false;
        activeEngineRef.current = null;
        showNoServiceSheetRef.current(classifyNoServiceSheet(resolveMicRevokedPkgRef.current()));
      }
      return;
    }
    lastAttemptedPkgRef.current = effectivePkg;
    const lang = await pickBestLocale(effectivePkg);
    // Session was stopped/flushed while we were awaiting locale — abort the
    // pending start so we don't open the mic with no active session. (Dropped
    // the `&& activeEngineRef==='ondevice'` qualifier: stopAndFlush clears the
    // engine ref, and only on-device starts reach here anyway.)
    if (!pressActiveRef.current) return;
    logEventRef.current('start.request', { pkg: effectivePkg, lang });
    try {
      ExpoSpeechRecognitionModule.start({
        lang,
        interimResults: true,
        maxAlternatives: 1,
        continuous: true,
        androidRecognitionServicePackage: effectivePkg,
        androidIntentOptions: { EXTRA_LANGUAGE_MODEL: SODA_DICTATION_MODEL },
      });
      started.current = true;
      setIsListening(true);
      startPulse();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      startWatchdogRef.current();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logEventRef.current('start.throw', { msg });
      sessionFailedPkgsRef.current.add(effectivePkg);
      showErrRef.current(`STT start failed: ${msg}`, 0, true);
    }
  });

  // Detection flow — called from error handler (inside effect), so use ref
  const triggerDetectionRef = useRef(async () => {
    setDetecting(true);
    // Fresh detection supersedes any persist staged by a prior auto-select.
    pendingPersistRef.current = null;
    showErrRef.current(`Scanning ${KNOWN_RECOGNIZERS.length} speech services…`, 20000);
    try {
      const available = await detectAvailableRecognizers();
      setDetecting(false);
      setErrMsg('');
      detectionRanRef.current = true;

      // A result of "only System Default" means the legacy probe didn't surface
      // any real package — System Default is appended unconditionally. Treating
      // that as a successful detection causes the app to auto-start with no
      // explicit pkg, which is exactly what just failed — an infinite loop.
      // Skip straight to the no-service sheet (with diagnostics) instead.
      const realHits = available.filter((o) => o.pkg !== '' && !sessionFailedPkgsRef.current.has(o.pkg));

      // Prefer a known-good pinned recognizer (Google's on-device engine) over
      // any third-party RecognitionService that happens to be installed. Auto-use
      // it without a picker and queue the rest as failover. This is the fix for an
      // installed app (e.g. another assistant) registering a recognizer that
      // getSpeechRecognitionServices() surfaces but that can't actually serve STT.
      const pinnedHit = realHits.find((o) => isPinnedRecognizer(o.pkg));
      if (pinnedHit) {
        // Stage the persist rather than writing it now: we only remember this
        // recognizer once it yields a real result (see the result listener), so a
        // pinned engine that's enumerated-but-broken on some non-Google device
        // can't get persisted and then re-fail every launch. Safe to defer here
        // because auto-restart resolves a missing saved pkg back to the same
        // pinned engine (null -> firstAvailablePinned in resolveEffectivePkg).
        pendingPersistRef.current = { pkg: pinnedHit.pkg, label: pinnedHit.label };
        showErrRef.current(`Using ${pinnedHit.label}`, 1500);
        // Failover only among other pinned (Google) recognizers — never queue a
        // third-party RecognitionService that can't serve STT.
        failoverChainRef.current = pinnedFailoverChain(realHits, pinnedHit.pkg);
        await startRecognizerRef.current(pinnedHit.pkg);
        return;
      }

      if (realHits.length === 0) {
        failoverChainRef.current = [];
        showNoServiceSheetRef.current(classifyNoServiceSheet(resolveMicRevokedPkgRef.current()));
        return;
      }

      if (realHits.length === 1) {
        const hit = realHits[0];
        await AsyncStorage.setItem(STT_RECOGNIZER_PKG_KEY, hit.pkg);
        await AsyncStorage.setItem(STT_RECOGNIZER_LABEL_KEY, hit.label);
        showErrRef.current(`Using ${hit.label}`, 1500);
        failoverChainRef.current = [''];
        await startRecognizerRef.current(hit.pkg);
        return;
      }

      // Multi-service: seed the failover chain with every detected package
      // (minus the one we'll show the picker for) so that, once the user
      // picks, subsequent failures can transparently try the rest.
      // Keep the System Default sentinel ('') in the failover chain as an internal
      // last resort, but don't offer it in the picker: with the pinned-recognizer
      // hardening it no longer does a bare start (it resolves to a pinned Google
      // engine), so presenting it as a distinct "System Default" choice would mislead.
      failoverChainRef.current = available.map((o) => o.pkg);
      setPickerOptions(available.filter((o) => o.pkg !== ''));
      setPickerVisible(true);
    } catch (e: unknown) {
      setDetecting(false);
      const msg = e instanceof Error ? e.message : String(e);
      showErrRef.current(`Detection failed: ${msg}`, 0, true);
    }
  });

  useEffect(() => {
    const resultSub = ExpoSpeechRecognitionModule.addListener(
      'result',
      (event: ExpoSpeechRecognitionResultEvent) => {
        const transcript = event.results[0]?.transcript;
        logEventRef.current('result', { isFinal: event.isFinal, len: transcript?.length ?? 0 });
        audioSeenRef.current = true;
        serverDisconnectRetryRef.current = 0; // recognizer produced output — recovered
        clearWatchdogRef.current();
        // Accumulation decision (dictationSession.ts): drops trailing results
        // after an external stopAndFlush and empty transcripts; otherwise
        // collects finals / overwrites the interim and composes the non-final
        // display update. The single final commit happens in 'end' (on stop).
        const outcome = applyResultEvent(accRef.current, {
          transcript,
          isFinal: event.isFinal,
          flushedExternally: flushedExternallyRef.current,
        });
        if (outcome.type !== 'accumulate') return;
        accRef.current = outcome.acc;
        // First real transcript proves this recognizer can serve STT — commit any
        // persist staged by the pinnedHit auto-select now, so we only ever
        // remember an engine that actually works.
        if (pendingPersistRef.current) {
          const { pkg, label } = pendingPersistRef.current;
          pendingPersistRef.current = null;
          void AsyncStorage.setItem(STT_RECOGNIZER_PKG_KEY, pkg).catch(() => { /* best-effort */ });
          void AsyncStorage.setItem(STT_RECOGNIZER_LABEL_KEY, label).catch(() => { /* best-effort */ });
        }
        // A segment yielded final text — the session is not silent; reset the
        // silence auto-stop counter so quiet only accrues from here on.
        if (outcome.resetsSilentEnds) consecutiveSilentEndsRef.current = 0;
        onTranscriptRef.current(outcome.display, false);
      }
    );
    // Lifecycle listeners. expo-speech-recognition emits these on Android;
    // if any is unsupported on iOS/older versions, addListener will still
    // return a subscription and just never fire — safe no-op.
    const lifecycleSubs = [
      ExpoSpeechRecognitionModule.addListener('start', () => {
        logEventRef.current('start');
        noServiceRetryRef.current = 0;
        errorHandlingRef.current = false;
      }),
      ExpoSpeechRecognitionModule.addListener('audiostart', () => {
        logEventRef.current('audiostart');
        audioSeenRef.current = true;
        clearWatchdogRef.current();
      }),
      ExpoSpeechRecognitionModule.addListener('audioend', () => {
        logEventRef.current('audioend');
      }),
      ExpoSpeechRecognitionModule.addListener('speechstart', () => {
        logEventRef.current('speechstart');
        audioSeenRef.current = true;
        clearWatchdogRef.current();
      }),
      ExpoSpeechRecognitionModule.addListener('speechend', () => {
        logEventRef.current('speechend');
      }),
      ExpoSpeechRecognitionModule.addListener('nomatch', () => {
        logEventRef.current('nomatch');
      }),
    ];
    const errorSub = ExpoSpeechRecognitionModule.addListener(
      'error',
      async (event: ExpoSpeechRecognitionErrorEvent) => {
        clearWatchdogRef.current();
        stopListeningRef.current();
        errorHandlingRef.current = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (event as any).code ?? -1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nativeMsg = (event as any).message;
        lastErrorRef.current = `code=${code} error=${event.error}${nativeMsg ? ' msg=' + nativeMsg : ''}`;
        logEventRef.current('error', { code, error: event.error });

        // Record every code-9 (service-not-allowed) package this session so the
        // terminal no-service sheet can offer the mic-revoked variant (recognizer
        // installed but its own RECORD_AUDIO revoked). See sttErrorPolicy.
        if (code === 9 && lastAttemptedPkgRef.current) {
          code9PkgsRef.current.add(lastAttemptedPkgRef.current);
        }

        // Count this end toward silence auto-stop before deciding what to do:
        // code 7 is a no-speech timeout. (A segment that produced final text
        // already reset the counter in the result listener.)
        // Only count silence during an active session — a background code-7
        // (silence after a manual stop, common with continuous: true) was a
        // pure no-op pre-extraction and must stay side-effect-free.
        if (code === 7 && pressActiveRef.current) consecutiveSilentEndsRef.current += 1;

        // The saved recognizer pkg/label are consulted ONLY by the code-5/9
        // detect-or-clear ladder, which is reached only for an active session
        // whose failover chain is empty — read AsyncStorage exactly there so no
        // other error path touches it (matching the original branch gating).
        let savedPkg: string | null = null;
        let hasSavedPkg = false;
        let hasSavedLabel = false;
        if (
          pressActiveRef.current &&
          (code === 5 || code === 9) &&
          failoverChainRef.current.length === 0
        ) {
          const [sp, sl] = await Promise.all([
            AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY),
            AsyncStorage.getItem(STT_RECOGNIZER_LABEL_KEY),
          ]);
          savedPkg = sp;
          hasSavedPkg = sp !== null;
          hasSavedLabel = sl !== null;
        }

        const action = decideSttErrorAction({
          code,
          pressActive: pressActiveRef.current,
          flushedExternally: flushedExternallyRef.current,
          serverDisconnectRetries: serverDisconnectRetryRef.current,
          noServiceRetries: noServiceRetryRef.current,
          failoverChainLength: failoverChainRef.current.length,
          detectionRan: detectionRanRef.current,
          hasSavedPkg,
          hasSavedLabel,
          hasLastAttemptedPkg: lastAttemptedPkgRef.current !== null,
          micRevoked: resolveMicRevokedPkgRef.current(),
          consecutiveSilentEnds: consecutiveSilentEndsRef.current,
        });

        // Mirror the original ordering: the attempted pkg is marked failed for
        // every failover-eligible error that gets past the code-11 single retry
        // and the inactive-session guard — i.e. every action except
        // retry-same-engine and the three inactive-session (!pressActive) ones.
        if (
          isFailoverEligibleCode(code) &&
          lastAttemptedPkgRef.current &&
          action.type !== 'retry-same-engine' &&
          action.type !== 'swallow-flushed' &&
          action.type !== 'swallow' &&
          action.type !== 'transient-toast'
        ) {
          sessionFailedPkgsRef.current.add(lastAttemptedPkgRef.current);
        }

        switch (action.type) {
          case 'swallow-flushed':
            // Teardown error after an external stopAndFlush() — already committed;
            // clear the guard here since `end` may not arrive on the error path.
            flushedExternallyRef.current = false;
            return;
          case 'swallow':
            return;
          case 'transient-toast': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawMsg = `${event.error}${(event as any).message ? ': ' + (event as any).message : ''} (code ${code})`;
            showErrRef.current(sttErrorMessage(code, event.error, rawMsg), 4000);
            return;
          }
          case 'retry-same-engine': {
            // keepsErrorHandlingLatched (3309ef6): do NOT reset errorHandlingRef —
            // the retried session's native `start` event resets it. Resetting here
            // lets the imminent `end` schedule a second, overlapping restart.
            serverDisconnectRetryRef.current += 1;
            const retryPkg = lastAttemptedPkgRef.current;
            showErrRef.current('Reconnecting…', 1500);
            setTimeout(async () => {
              if (!pressActiveRef.current) return;
              await startRecognizerRef.current(retryPkg);
            }, action.delayMs);
            return;
          }
          case 'silent-restart':
            // keepsErrorHandlingLatched (3309ef6): same double-restart hazard.
            setTimeout(async () => {
              if (!pressActiveRef.current) return;
              const restartPkg = await AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY);
              await startRecognizerRef.current(restartPkg);
            }, action.delayMs);
            return;
          case 'auto-stop-commit':
            // Enough consecutive silent ends — end the session on quiet, flushing
            // accumulated text exactly like a manual stop tap.
            autoStopCommitRef.current();
            return;
          case 'failover-next': {
            const nextPkg = failoverChainRef.current.shift()!;
            // '' is the terminal sentinel: resolveEffectivePkg maps it back to a
            // pinned engine, so it only does anything if a pinned pkg has since
            // recovered this session; otherwise it no-ops into the no-service
            // sheet. Intentionally kept in the chain, not dead code.
            const label = nextPkg ? labelForPackage(nextPkg) : 'System Default';
            showErrRef.current(`Retrying with ${label}…`, 2000);
            await startRecognizerRef.current(nextPkg);
            return;
          }
          case 'detect':
            await triggerDetectionRef.current();
            return;
          case 'clear-label-and-detect':
            await AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
            await triggerDetectionRef.current();
            return;
          case 'retry-no-service':
            noServiceRetryRef.current += 1;
            await new Promise<void>(r => setTimeout(r, action.delayMs));
            if (!pressActiveRef.current) return;
            await startRecognizerRef.current(savedPkg);
            return;
          case 'clear-saved-and-detect':
            if (action.resetNoServiceRetries) noServiceRetryRef.current = 0;
            await AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
            await AsyncStorage.removeItem(STT_RECOGNIZER_LABEL_KEY);
            await triggerDetectionRef.current();
            return;
          case 'lang-unavailable-sheet':
            showErrRef.current(
              'English voice model not installed on any speech service.\nOpen Speech Services by Google to download it.',
              0, true, 'lang-unavailable',
            );
            return;
          case 'no-service-sheet':
            showNoServiceSheetRef.current(action.sheet);
            return;
          case 'generic-error': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawMsg = `${event.error}${(event as any).message ? ': ' + (event as any).message : ''} (code ${code})`;
            showErrRef.current(sttErrorMessage(code, event.error, rawMsg), 8000, action.persist);
            return;
          }
        }
      }
    );
    const endSub = ExpoSpeechRecognitionModule.addListener('end', () => {
      logEventRef.current('end');
      clearWatchdogRef.current();

      // KNOWN EDGE (deferred): a native `end` for a flushed/stopped session can
      // arrive AFTER a new session has started — the picker that triggers
      // stopAndFlush backgrounds the app and delays `end`. flushedExternallyRef
      // is reset at session start to self-heal, which leaves a small window where
      // a stale `end` could be misread as the new session's. A session epoch would
      // close it (bump a sessionEpochRef at each start, capture it per start(),
      // and bail here if it has moved), but that needs threading through the
      // result/end/error listeners plus on-device verification, so it's deferred.
      // Low probability in practice: stopOnDevice() usually delivers `end` before
      // the user can return from the picker and re-tap.

      // Branch decision lives in dictationSession.ts (decideEndEvent); this
      // listener only applies the side effects each outcome asks for.
      const outcome = decideEndEvent(accRef.current, {
        pressActive: pressActiveRef.current,
        activeEngineOnDevice: activeEngineRef.current === 'ondevice',
        errorHandlingLatched: errorHandlingRef.current,
        flushedExternally: flushedExternallyRef.current,
        consecutiveSilentEnds: consecutiveSilentEndsRef.current,
      });

      // Shared session teardown for the two terminal outcomes below.
      const teardown = () => {
        accRef.current = EMPTY_ACCUMULATOR;
        pressActiveRef.current = false;
        activeEngineRef.current = null;
        if (maxDurationTimer.current) {
          clearTimeout(maxDurationTimer.current);
          maxDurationTimer.current = null;
        }
        stopListeningRef.current();
      };

      switch (outcome.type) {
        case 'ignore-latched':
          // Error listener owns this end — it already scheduled any restart
          // (3309ef6: acting here too causes overlapping sessions).
          return;
        case 'fold-and-restart':
        case 'restart-after-silence':
          // Soda ended on its own (silence/timeout) mid-session: fold/keep the
          // accumulated text and re-arm the recognizer after a brief delay.
          accRef.current = outcome.acc;
          consecutiveSilentEndsRef.current = outcome.consecutiveSilentEnds;
          started.current = false;
          setIsListening(false);
          stopPulse();
          setTimeout(async () => {
            if (!pressActiveRef.current) return;
            const savedPkg = await AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY);
            await startRecognizerRef.current(savedPkg);
          }, outcome.restartDelayMs);
          return;
        case 'auto-stop-commit':
          // Enough consecutive silent ends — end the session on quiet.
          // autoStopCommitRef recomputes the same finalText from accRef.
          autoStopCommitRef.current();
          return;
        case 'teardown-flushed':
          // Already committed by an external stopAndFlush() — just tear down,
          // don't emit the transcript a second time.
          flushedExternallyRef.current = false;
          teardown();
          return;
        case 'commit-final':
          // User tapped stop (or max-duration) — send accumulated + final.
          if (outcome.finalText) onTranscriptRef.current(outcome.finalText, true);
          teardown();
          return;
      }
    });

    return () => {
      resultSub.remove();
      errorSub.remove();
      endSub.remove();
      lifecycleSubs.forEach((s) => s.remove());
      // Refs (not deps) on purpose throughout this effect — see below.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- clearWatchdogRef is a stable function ref; reading .current at cleanup time is the intent
      clearWatchdogRef.current();
      if (started.current) ExpoSpeechRecognitionModule.stop();
    };
    // Mount-once on purpose: re-running this effect re-subscribes the native
    // recognizer events mid-session — the exact restart-race minefield
    // sttErrorPolicy's latching exists to prevent. Everything mutable is
    // reached through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePickRecognizer = async (option: RecognizerOption) => {
    setPickerVisible(false);
    if (option.pkg) {
      await AsyncStorage.setItem(STT_RECOGNIZER_PKG_KEY, option.pkg);
    } else {
      await AsyncStorage.removeItem(STT_RECOGNIZER_PKG_KEY);
    }
    await AsyncStorage.setItem(STT_RECOGNIZER_LABEL_KEY, option.label);
    // Remove the picked package from the failover chain so we don't retry it
    // immediately if it fails — next-best candidates remain queued.
    failoverChainRef.current = failoverChainRef.current.filter(
      (p) => p !== option.pkg,
    );
    showErrRef.current(`Using ${option.label}`, 1500);
    // Arm the same session state handlePressIn would set so the 3-min safety cap
    // and stop-tap routing apply to picker-started sessions too. Picker is on-device only.
    pressActiveRef.current = true;
    activeEngineRef.current = 'ondevice';
    consecutiveSilentEndsRef.current = 0;
    // Same code-9 revival as handleToggle's first tap: a picker-started
    // session is also a fresh user-initiated attempt.
    sessionFailedPkgsRef.current = reviveUserRecoverablePkgs(
      sessionFailedPkgsRef.current,
      code9PkgsRef.current,
    );
    code9PkgsRef.current = new Set();
    clearMaxTimer();
    maxDurationTimer.current = setTimeout(() => {
      maxDurationTimer.current = null;
      if (pressActiveRef.current) {
        logEventRef.current('recording.max-duration');
        pressActiveRef.current = false;
        activeEngineRef.current = null;
        stopOnDevice();
      }
    }, MAX_RECORDING_MS);
    await startRecognizerRef.current(option.pkg || null);
  };

  const requestRecordAudio = useCallback(async (): Promise<boolean> => {
    try {
      const current = await ExpoSpeechRecognitionModule.getPermissionsAsync();
      if (current.granted) return true;
      if (!current.canAskAgain) return false;
      const next = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      return next.granted;
    } catch {
      return false;
    }
  }, []);

  // ── On-device recording (Android SpeechRecognizer) ──────────────────────

  const startOnDevice = useCallback(async () => {
    setErrMsg('');
    const granted = await requestRecordAudio();
    if (!pressActiveRef.current) return;
    if (!granted) {
      showErrRef.current(
        'Microphone permission is required for voice input.\nIf the system dialog did not appear, enable it manually in App Settings.',
        0, true, 'permission',
      );
      return;
    }
    const pkg = await AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY);
    if (!pressActiveRef.current) return;
    failoverChainRef.current = [];
    detectionRanRef.current = false;
    resetAccumulator();
    await startRecognizerRef.current(pkg);
  }, [requestRecordAudio, resetAccumulator]);

  const stopOnDevice = useCallback(() => {
    // The 'end' listener flushes the composed transcript, so we just need to
    // ask Soda to wrap up. stopListening() is called from the end listener.
    if (started.current) {
      try { ExpoSpeechRecognitionModule.stop(); } catch { /* ignore */ }
    } else {
      // Race: user released before Soda started. Nothing to flush; clear.
      resetAccumulator();
    }
  }, [resetAccumulator]);

  // ── External stop+flush (parent calls this before opening a picker etc.) ──
  // Commits the in-progress transcript as final NOW (synchronously, from JS
  // state) rather than relying on the native `end` round-trip, which can be
  // suspended when the picker Activity backgrounds the app — the exact path
  // that was dropping the partial. No-op when not recording.
  const stopAndFlush = useCallback(() => {
    if (!pressActiveRef.current) {
      logEventRef.current('flush.noop', { reason: 'not-active' });
      return;
    }
    clearMaxTimer();
    // Tear the session down BEFORE running any parent code below, so a throw
    // from onTranscript can't strand the mic or wedge pressActiveRef.
    pressActiveRef.current = false;
    activeEngineRef.current = null;
    const text = composeSessionFlush(accRef.current);
    // Diagnostics: len=0 means STT captured no transcript to flush (e.g. a Soda
    // nomatch), NOT that the flush dropped it. session = chars already folded
    // from prior auto-restarted segments.
    logEventRef.current('flush.ondevice', {
      len: text.length,
      session: accRef.current.sessionText.length,
    });
    flushedExternallyRef.current = true; // suppress the end-listener re-commit
    accRef.current = EMPTY_ACCUMULATOR;
    stopOnDevice(); // release the mic; `end` fires and short-circuits on the flag
    // Emit LAST and contained: teardown is done and the mic is released, so a
    // throwing parent callback can't leave the recognizer running.
    if (text) {
      try {
        onTranscriptRef.current(text, true);
        logEventRef.current('flush.emit', { len: text.length });
      } catch (e: unknown) {
        logEventRef.current('flush.emit.throw', {
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      logEventRef.current('flush.empty');
    }
  }, [clearMaxTimer, stopOnDevice]);

  useImperativeHandle(ref, () => ({ stopAndFlush }), [stopAndFlush]);

  // ── Tap-to-toggle router (tap once to start, tap again to stop) ─────────

  const handleToggle = useCallback(async () => {
    if (detecting || disabled) return;

    // Second tap — stop recording
    if (pressActiveRef.current) {
      pressActiveRef.current = false;
      clearMaxTimer();
      const engine = activeEngineRef.current;
      activeEngineRef.current = null;
      if (engine === 'ondevice') {
        stopOnDevice();
      }
      return;
    }

    // First tap — start recording
    pressActiveRef.current = true;
    errorHandlingRef.current = false;
    consecutiveSilentEndsRef.current = 0;
    // Give code-9 (mic-revoked) packages another chance on every fresh tap —
    // the user may have just re-enabled the permission, exactly as the
    // mic-revoked sheet instructed. See reviveUserRecoverablePkgs.
    sessionFailedPkgsRef.current = reviveUserRecoverablePkgs(
      sessionFailedPkgsRef.current,
      code9PkgsRef.current,
    );
    code9PkgsRef.current = new Set();
    accRef.current = { ...accRef.current, sessionText: '' };
    // Self-heal the external-flush guard at the start of every session so a
    // prior session whose `end` never arrived can't make this one skip its
    // real commit.
    flushedExternallyRef.current = false;
    // Drop any persist staged by a prior session that never produced a result,
    // so this session can't accidentally commit the wrong recognizer.
    pendingPersistRef.current = null;
    serverDisconnectRetryRef.current = 0;
    // Full error-UI reset (errMsg + errPersist + errAction/micRevokedTarget
    // pairing) — the modal is gated on errMsg alone, but leaving errAction
    // stale made that invariant implicit. dismissErr makes it explicit.
    dismissErr();
    clearMaxTimer();
    maxDurationTimer.current = setTimeout(() => {
      maxDurationTimer.current = null;
      if (pressActiveRef.current) {
        logEventRef.current('recording.max-duration');
        pressActiveRef.current = false;
        stopOnDevice();
        activeEngineRef.current = null;
      }
    }, MAX_RECORDING_MS);

    if (!pressActiveRef.current) return;
    activeEngineRef.current = 'ondevice';
    await startOnDevice();
  }, [detecting, disabled, clearMaxTimer, stopOnDevice, startOnDevice, dismissErr]);

  return (
    <View>
      {/* Recognizer picker sheet */}
      <VoiceRecognizerPicker
        theme={theme}
        visible={pickerVisible}
        options={pickerOptions}
        onDismiss={() => setPickerVisible(false)}
        onPick={handlePickRecognizer}
      />

      {/* Error / status popup sheet */}
      <VoiceErrorSheet
        theme={theme}
        errMsg={errMsg}
        errPersist={errPersist}
        errAction={errAction}
        micRevokedTarget={micRevokedTarget}
        downloadingModel={downloadingModel}
        onDismiss={dismissErr}
        onOpenAppSettings={openAppSettings}
        onDownloadModel={handleDownloadModel}
        onOpenPlayStore={openPlayStore}
        onRetryDetection={retryDetection}
        onCopyDiagnostics={copyDiagnostics}
        onOpenAppDetails={openAppDetails}
      />

      <View style={styles.orbContainer}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <Pressable
            onPress={handleToggle}
            disabled={disabled || detecting}
            style={({ pressed }: { pressed: boolean }) => [
              styles.btn,
              { borderColor: theme.colors.outline, backgroundColor: theme.colors.surface },
              pressed && { backgroundColor: theme.colors.surfaceVariant },
              // Solid-fill CTA while recording: the deep teal (carnet.fill),
              // not colors.primary — on dark, primary is the brightened text
              // tone and reads wrong as a fill (DESIGN.md).
              isListening && { backgroundColor: theme.carnet.fill, borderColor: theme.carnet.fill },
              (disabled || detecting) && styles.btnDisabled,
            ]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={isListening ? 'Stop dictation' : 'Start dictation'}
          >
            <Icon
              source={detecting ? 'dots-horizontal' : isListening ? 'stop' : 'microphone'}
              size={22}
              color={isListening ? theme.carnet.onFill : theme.colors.primary}
            />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
});

VoiceButton.displayName = 'VoiceButton';

const styles = StyleSheet.create({
  btn: {
    width: MIN_TAP_TARGET, height: MIN_TAP_TARGET,
    borderRadius: MIN_TAP_TARGET / 2,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.35 },
  orbContainer: {
    width: MIN_TAP_TARGET,
    height: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
