// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Async device probes for the voice module — talk to
// ExpoSpeechRecognitionModule/AsyncStorage to pick a locale, enumerate
// installed recognizers, and gather bug-report diagnostics. Split out of
// VoiceButton.tsx so this orchestration is unit-testable (with the native
// module mocked) without rendering the component itself.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import {
  type RecognizerOption,
  SYSTEM_DEFAULT_RECOGNIZER,
  DEFAULT_RECOGNIZER_PKGS,
  orderRecognizerCandidates,
} from './recognizerSelect';
import {
  KNOWN_RECOGNIZERS,
  PREFERRED_LANG,
  STT_ENGINE_KEY,
  STT_RECOGNIZER_PKG_KEY,
  STT_RECOGNIZER_LABEL_KEY,
  labelForPackage,
} from './recognizerCatalog';

// Returns the best locale the given recognizer can serve, preferring an
// already-installed match over a claimed-but-not-downloaded one. Falls back
// to the preferred tag when the probe throws (old Android or missing perm).
export async function pickBestLocale(pkg: string | null, preferred = PREFERRED_LANG): Promise<string> {
  try {
    const opts = pkg ? { androidRecognitionServicePackage: pkg } : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await ExpoSpeechRecognitionModule.getSupportedLocales(opts)) as any;
    const locales: string[] = Array.isArray(res?.locales) ? res.locales : [];
    const installed: string[] = Array.isArray(res?.installedLocales) ? res.installedLocales : [];
    const lower = preferred.toLowerCase();
    const exact = (list: string[]) => list.find((l) => l.toLowerCase() === lower);
    const anyEn = (list: string[]) => list.find((l) => l.toLowerCase().startsWith('en-'));
    return exact(installed) ?? exact(locales) ?? anyEn(installed) ?? anyEn(locales) ?? preferred;
  } catch {
    return preferred;
  }
}

// Gather everything we know about the device's STT state. Returned as plain
// text so the user can paste it into a bug report.
export async function collectDiagnostics(
  lastError: string | null,
  eventBuffer: string[] = [],
): Promise<string> {
  const lines: string[] = [];
  const ts = new Date().toISOString();
  lines.push(`carnet voice diagnostics @ ${ts}`);
  lines.push('');
  // getSpeechRecognitionServices
  try {
    const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices();
    lines.push(`getSpeechRecognitionServices() → [${(services ?? []).join(', ') || '(empty)'}]`);
  } catch (e: unknown) {
    lines.push(`getSpeechRecognitionServices() threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  // getDefaultRecognitionService
  try {
    const def = ExpoSpeechRecognitionModule.getDefaultRecognitionService();
    lines.push(`getDefaultRecognitionService() → ${def?.packageName || '(empty)'}`);
  } catch (e: unknown) {
    lines.push(`getDefaultRecognitionService() threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Per-package probes
  lines.push('');
  lines.push('Per-package getSupportedLocales probe:');
  for (const r of KNOWN_RECOGNIZERS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await ExpoSpeechRecognitionModule.getSupportedLocales({
        androidRecognitionServicePackage: r.pkg,
      })) as any;
      const locales: string[] = Array.isArray(res?.locales) ? res.locales : [];
      const installed: string[] = Array.isArray(res?.installedLocales) ? res.installedLocales : [];
      lines.push(`  ${r.pkg}: ${locales.length} locales, ${installed.length} installed`);
    } catch (e: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (e as any)?.code ?? (e as any)?.nativeErrorCode;
      const msg = e instanceof Error ? e.message : String(e);
      lines.push(`  ${r.pkg}: ERROR code=${code ?? '?'} msg=${msg.slice(0, 80)}`);
    }
  }
  // Saved state
  lines.push('');
  const [savedPkg, savedLabel, savedEngine] = await Promise.all([
    AsyncStorage.getItem(STT_RECOGNIZER_PKG_KEY),
    AsyncStorage.getItem(STT_RECOGNIZER_LABEL_KEY),
    AsyncStorage.getItem(STT_ENGINE_KEY),
  ]);
  lines.push(`Saved engine: ${savedEngine ?? '(unset, defaults to on-device)'}`);
  lines.push(`Saved pkg: ${savedPkg ?? '(null)'}`);
  lines.push(`Saved label: ${savedLabel ?? '(null)'}`);
  lines.push(`Last error: ${lastError ?? '(none)'}`);
  lines.push('');
  lines.push(`Recent events (${eventBuffer.length}):`);
  if (eventBuffer.length === 0) {
    lines.push('  (none captured)');
  } else {
    for (const line of eventBuffer) lines.push('  ' + line);
  }
  return lines.join('\n');
}

export async function detectAvailableRecognizers(): Promise<RecognizerOption[]> {
  // Primary: ask Android directly which recognizer services are installed.
  // This bypasses Android 11+ <queries> visibility issues and Android 13+
  // ERROR_LANGUAGE_UNAVAILABLE false negatives that the per-package probe hits.
  try {
    const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices();
    if (services && services.length > 0) {
      let defaultPkg = '';
      try {
        defaultPkg = ExpoSpeechRecognitionModule.getDefaultRecognitionService()?.packageName ?? '';
      } catch {
        // non-fatal
      }
      // Probe installed language models so a pinned engine with no on-device
      // speech pack (e.g. a com.google.android.as that only returns code 12)
      // ranks below a model-having one. Unknown/timeout → treat as has-model so
      // a slow probe never wrongly demotes a working recognizer.
      const candidates = Array.from(new Set([...DEFAULT_RECOGNIZER_PKGS, ...services]));
      const modelByPkg = new Map<string, boolean>();
      await Promise.all(
        candidates.map(async (pkg) => {
          try {
            const res = (await Promise.race([
              ExpoSpeechRecognitionModule.getSupportedLocales({ androidRecognitionServicePackage: pkg }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
            ])) as { installedLocales?: string[] } | undefined;
            const installed = Array.isArray(res?.installedLocales) ? res.installedLocales : [];
            modelByPkg.set(pkg, installed.length > 0);
          } catch {
            modelByPkg.set(pkg, true); // unknown → don't demote
          }
        }),
      );
      // Always include our pinned Google recognizers (ranked first), even when
      // Android doesn't enumerate them — otherwise a device whose only
      // *enumerated* RecognitionService is a third-party app (e.g. an installed
      // assistant that can't actually serve STT) has no Google fallback, so that
      // app's recognizer gets picked and STT dies with code 5/9.
      return orderRecognizerCandidates(
        services,
        defaultPkg,
        labelForPackage,
        (pkg) => modelByPkg.get(pkg) ?? true,
      );
    }
  } catch {
    // fall through to legacy probe
  }

  // Fallback: legacy per-package probe for when getSpeechRecognitionServices
  // is unavailable or returns empty.
  const confirmed: RecognizerOption[] = [];
  const tentative: RecognizerOption[] = [];
  for (const r of KNOWN_RECOGNIZERS) {
    try {
      const result = await ExpoSpeechRecognitionModule.getSupportedLocales({
        androidRecognitionServicePackage: r.pkg,
      });
      if (result?.locales && result.locales.length > 0) {
        confirmed.push(r);
      }
    } catch (e: unknown) {
      const code = (e as { code?: number; nativeErrorCode?: number })?.code
        ?? (e as { code?: number; nativeErrorCode?: number })?.nativeErrorCode;
      const msg = e instanceof Error ? e.message : String(e);
      if (code === 14 || msg.includes('14')) {
        tentative.push(r);
      }
    }
  }
  const found = confirmed.length > 0 ? confirmed : tentative;
  return [...found, SYSTEM_DEFAULT_RECOGNIZER];
}
