// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory AsyncStorage so the one-shot "prompted" flag can be exercised
// without a native store. Mirrors queue.test.ts's mocking style.
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

import {
  describeReadiness,
  shouldPromptProactively,
  wasOnboardingPrompted,
  markOnboardingPrompted,
  isSttModelMissingMessage,
  STT_MODEL_MISSING_MESSAGE,
  STT_ONBOARDING_PROMPTED_KEY,
  type SttEngine,
} from './sttOnboarding';
import type { SttReadiness } from './sttReadiness';

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

describe('describeReadiness', () => {
  it('reports ready with no action and surfaces the installed locale', () => {
    const copy = describeReadiness({ state: 'ready', locale: 'en-GB' });
    expect(copy.tone).toBe('ok');
    expect(copy.action).toBe('none');
    expect(copy.body).toContain('en-GB');
    expect(copy.title.length).toBeGreaterThan(0);
  });

  it('reports needs-model with the download action', () => {
    const copy = describeReadiness({ state: 'needs-model', locale: 'en-US' });
    expect(copy.tone).toBe('warn');
    expect(copy.action).toBe('download');
    expect(copy.body.length).toBeGreaterThan(0);
  });

  it('reports no-permission with the open-permission action', () => {
    const copy = describeReadiness({ state: 'no-permission' });
    expect(copy.tone).toBe('info');
    expect(copy.action).toBe('open-permission');
  });

  it('reports unsupported with no recommended action', () => {
    const copy = describeReadiness({ state: 'unsupported' });
    expect(copy.tone).toBe('info');
    expect(copy.action).toBe('none');
  });
});

describe('shouldPromptProactively', () => {
  const needsModel: SttReadiness = { state: 'needs-model', locale: 'en-US' };

  it('prompts when the model is missing, on-device engine, and not yet prompted', () => {
    expect(
      shouldPromptProactively({
        readiness: needsModel,
        alreadyPrompted: false,
        engine: 'ondevice',
      }),
    ).toBe(true);
  });

  it('does not prompt once the user has already been prompted', () => {
    expect(
      shouldPromptProactively({
        readiness: needsModel,
        alreadyPrompted: true,
        engine: 'ondevice',
      }),
    ).toBe(false);
  });

  it.each<SttReadiness>([
    { state: 'ready', locale: 'en-US' },
    { state: 'no-permission' },
    { state: 'unsupported' },
  ])('does not prompt for non-downloadable state %o', (readiness) => {
    expect(
      shouldPromptProactively({
        readiness,
        alreadyPrompted: false,
        engine: 'ondevice',
      }),
    ).toBe(false);
  });

  it('prompts for the needs-model state on the on-device engine', () => {
    const engines: SttEngine[] = ['ondevice'];
    for (const engine of engines) {
      const result = shouldPromptProactively({
        readiness: needsModel,
        alreadyPrompted: false,
        engine,
      });
      expect(result).toBe(true);
    }
  });
});

describe('isSttModelMissingMessage', () => {
  it('matches the exact message audioTranscribeOnDevice throws for a missing model', () => {
    expect(isSttModelMissingMessage(STT_MODEL_MISSING_MESSAGE)).toBe(true);
  });

  it('does not match an unrelated transcription error', () => {
    expect(isSttModelMissingMessage('On-device STT error: audio-capture')).toBe(
      false,
    );
    expect(
      isSttModelMissingMessage(
        'On-device STT returned no recognized speech (silent audio?)',
      ),
    ).toBe(false);
  });

  it('does not match a substring or reordered fragment of the real message', () => {
    expect(isSttModelMissingMessage("voice model isn't installed")).toBe(false);
    expect(isSttModelMissingMessage(STT_MODEL_MISSING_MESSAGE + ' ')).toBe(
      false,
    );
  });
});

describe('onboarding prompted flag', () => {
  it('starts false and flips to true after marking', async () => {
    expect(await wasOnboardingPrompted()).toBe(false);
    await markOnboardingPrompted();
    expect(await wasOnboardingPrompted()).toBe(true);
    expect(_store.get(STT_ONBOARDING_PROMPTED_KEY)).toBe('1');
  });

  it('fails safe to "already prompted" when the storage read throws', async () => {
    const storage = (await import('@react-native-async-storage/async-storage'))
      .default as unknown as { getItem: ReturnType<typeof vi.fn> };
    storage.getItem.mockRejectedValueOnce(new Error('keychain unavailable'));
    expect(await wasOnboardingPrompted()).toBe(true);
  });

  it('swallows a write failure without throwing', async () => {
    const storage = (await import('@react-native-async-storage/async-storage'))
      .default as unknown as { setItem: ReturnType<typeof vi.fn> };
    storage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(markOnboardingPrompted()).resolves.toBeUndefined();
  });
});
