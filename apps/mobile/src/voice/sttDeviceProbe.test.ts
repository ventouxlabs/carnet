// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const _store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _store.delete(k);
    }),
  },
}));

vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    getSupportedLocales: vi.fn(async () => ({ locales: ['en-US'], installedLocales: ['en-US'] })),
    getSpeechRecognitionServices: vi.fn(() => ['com.google.android.tts', 'com.google.android.as']),
    getDefaultRecognitionService: vi.fn(() => ({ packageName: 'com.google.android.tts' })),
  },
}));

import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { collectDiagnostics, detectAvailableRecognizers, pickBestLocale } from './sttDeviceProbe';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockModule = ExpoSpeechRecognitionModule as any;

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
  mockModule.getSupportedLocales.mockResolvedValue({ locales: ['en-US'], installedLocales: ['en-US'] });
  mockModule.getSpeechRecognitionServices.mockReturnValue(['com.google.android.tts', 'com.google.android.as']);
  mockModule.getDefaultRecognitionService.mockReturnValue({ packageName: 'com.google.android.tts' });
});

describe('pickBestLocale', () => {
  it('prefers an installed exact match', async () => {
    mockModule.getSupportedLocales.mockResolvedValue({
      locales: ['en-US', 'fr-FR'],
      installedLocales: ['en-US'],
    });
    expect(await pickBestLocale('com.google.android.tts')).toBe('en-US');
  });

  it('falls back to the preferred tag when the probe throws', async () => {
    mockModule.getSupportedLocales.mockRejectedValue(new Error('boom'));
    expect(await pickBestLocale('com.google.android.tts', 'en-US')).toBe('en-US');
  });

  it('falls back to any en- locale when no exact match is installed or claimed', async () => {
    mockModule.getSupportedLocales.mockResolvedValue({
      locales: ['en-GB'],
      installedLocales: [],
    });
    expect(await pickBestLocale('com.google.android.tts', 'en-US')).toBe('en-GB');
  });
});

describe('detectAvailableRecognizers', () => {
  it('returns pinned + enumerated recognizers when getSpeechRecognitionServices succeeds', async () => {
    const result = await detectAvailableRecognizers();
    expect(result.some((r) => r.pkg === 'com.google.android.tts')).toBe(true);
    expect(result.some((r) => r.pkg === 'com.google.android.as')).toBe(true);
  });

  it('falls back to the legacy per-package probe when getSpeechRecognitionServices returns empty', async () => {
    mockModule.getSpeechRecognitionServices.mockReturnValue([]);
    mockModule.getSupportedLocales.mockImplementation(async ({ androidRecognitionServicePackage }: { androidRecognitionServicePackage: string }) =>
      androidRecognitionServicePackage === 'com.google.android.as'
        ? { locales: ['en-US'] }
        : Promise.reject(new Error('no service')),
    );
    const result = await detectAvailableRecognizers();
    expect(result.some((r) => r.pkg === 'com.google.android.as')).toBe(true);
  });
});

describe('collectDiagnostics', () => {
  it('includes the last error and saved state', async () => {
    _store.set('stt_recognizer_pkg', 'com.google.android.as');
    const text = await collectDiagnostics('code=5 error=client', ['12:00:00.000 start']);
    expect(text).toContain('Last error: code=5 error=client');
    expect(text).toContain('Saved pkg: com.google.android.as');
    expect(text).toContain('12:00:00.000 start');
  });

  it('reports no captured events when the buffer is empty', async () => {
    const text = await collectDiagnostics(null);
    expect(text).toContain('(none captured)');
    expect(text).toContain('Last error: (none)');
  });
});
