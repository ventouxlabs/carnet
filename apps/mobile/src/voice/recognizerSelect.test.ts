// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
  orderRecognizerCandidates,
  resolveEffectivePkg,
  pinnedFailoverChain,
  composeFlush,
  isPinnedRecognizer,
  DEFAULT_RECOGNIZER_PKGS,
  SYSTEM_DEFAULT_RECOGNIZER,
} from './recognizerSelect';

const label = (pkg: string) => `label:${pkg}`;
const pkgs = (opts: { pkg: string }[]) => opts.map((o) => o.pkg);
// Build a `hasFailed` predicate from a set of already-failed packages.
const failed = (...f: string[]) => (pkg: string) => f.includes(pkg);
const [PINNED_1, PINNED_2] = DEFAULT_RECOGNIZER_PKGS; // tts, as

describe('orderRecognizerCandidates', () => {
  it('regression: a rogue third-party recognizer never shoulders out Google', () => {
    // The bug: getSpeechRecognitionServices() enumerates only the Claude app's
    // RecognitionService (and NOT Google's on-device engine), Android reports it
    // as the default, so carnet picked it and STT died. Google must still appear,
    // ranked ahead of the third-party service.
    const result = orderRecognizerCandidates(
      ['com.anthropic.claude'],
      'com.anthropic.claude',
      label,
    );
    const order = pkgs(result);
    expect(order).toContain('com.google.android.tts');
    expect(order).toContain('com.google.android.as');
    // Pinned Google recognizers come before the third-party one.
    expect(order.indexOf('com.google.android.tts')).toBeLessThan(order.indexOf('com.anthropic.claude'));
    expect(order.indexOf('com.google.android.as')).toBeLessThan(order.indexOf('com.anthropic.claude'));
  });

  it('injects the pinned recognizers even when Android enumerates none', () => {
    const order = pkgs(orderRecognizerCandidates([], '', label));
    expect(order.slice(0, DEFAULT_RECOGNIZER_PKGS.length)).toEqual([...DEFAULT_RECOGNIZER_PKGS]);
  });

  it('ranks pinned recognizers first, in their listed order', () => {
    // Android enumerates `as` first, but `tts` is pinned first → tts leads.
    const order = pkgs(orderRecognizerCandidates(['com.google.android.as'], 'com.google.android.as', label));
    expect(order[0]).toBe('com.google.android.tts');
    expect(order[1]).toBe('com.google.android.as');
  });

  it('ranks the OS default above other third-party recognizers', () => {
    const order = pkgs(
      orderRecognizerCandidates(['com.vendor.zeta', 'com.vendor.alpha'], 'com.vendor.zeta', label),
    );
    // pinned Google pkgs first, then the OS default (zeta), then alpha.
    expect(order.indexOf('com.vendor.zeta')).toBeLessThan(order.indexOf('com.vendor.alpha'));
    expect(order.indexOf('com.google.android.tts')).toBeLessThan(order.indexOf('com.vendor.zeta'));
  });

  it('dedups and appends System Default last', () => {
    const result = orderRecognizerCandidates(['com.google.android.tts'], '', label);
    const order = pkgs(result);
    // tts only once despite being both pinned and enumerated.
    expect(order.filter((p) => p === 'com.google.android.tts')).toHaveLength(1);
    expect(result[result.length - 1]).toEqual(SYSTEM_DEFAULT_RECOGNIZER);
  });

  it('labels every option via the provided labeler', () => {
    const result = orderRecognizerCandidates(['com.anthropic.claude'], '', label);
    const claude = result.find((o) => o.pkg === 'com.anthropic.claude');
    expect(claude?.label).toBe('label:com.anthropic.claude');
  });

  it('keeps pinned recognizers first even when the OS default is itself pinned', () => {
    // defaultPkg = a pinned pkg must not double-count or reorder the pinned block.
    const order = pkgs(orderRecognizerCandidates(['com.google.android.as'], 'com.google.android.tts', label));
    expect(order.slice(0, DEFAULT_RECOGNIZER_PKGS.length)).toEqual([...DEFAULT_RECOGNIZER_PKGS]);
    expect(order.filter((p) => p === 'com.google.android.tts')).toHaveLength(1);
  });

  it('preserves enumeration order among equal-rank third-party services', () => {
    // Two non-default third-party services tie on rank; stable sort keeps input order.
    const order = pkgs(orderRecognizerCandidates(['com.vendor.beta', 'com.vendor.alpha'], '', label));
    expect(order.indexOf('com.vendor.beta')).toBeLessThan(order.indexOf('com.vendor.alpha'));
  });

  it('demotes a model-less pinned recognizer below model-having pinned, still above third-party', () => {
    // `as` has no installed speech model; tts does; plus a third-party service.
    const hasModel = (pkg: string) => pkg !== 'com.google.android.as';
    const order = pkgs(
      orderRecognizerCandidates(['com.google.android.as', 'com.vendor.zeta'], '', label, hasModel),
    );
    expect(order.indexOf('com.google.android.tts')).toBeLessThan(order.indexOf('com.google.android.as'));
    // model-less pinned `as` is still ranked ABOVE the third-party service.
    expect(order.indexOf('com.google.android.as')).toBeLessThan(order.indexOf('com.vendor.zeta'));
  });

  it('prefers a model-having pinned engine over a model-less one listed earlier', () => {
    // tts is pinned FIRST but has no model; as is pinned second WITH a model → as wins.
    const hasModel = (pkg: string) => pkg === 'com.google.android.as';
    const order = pkgs(orderRecognizerCandidates([], '', label, hasModel));
    expect(order.indexOf('com.google.android.as')).toBeLessThan(order.indexOf('com.google.android.tts'));
  });

  it('default hasModel leaves ordering unchanged (pinned first, in listed order)', () => {
    const order = pkgs(orderRecognizerCandidates(['com.vendor.zeta'], 'com.vendor.zeta', label));
    expect(order.slice(0, DEFAULT_RECOGNIZER_PKGS.length)).toEqual([...DEFAULT_RECOGNIZER_PKGS]);
    expect(order.indexOf('com.google.android.as')).toBeLessThan(order.indexOf('com.vendor.zeta'));
  });
});

describe('resolveEffectivePkg', () => {
  it('resolves null ("try defaults") to the first pinned recognizer', () => {
    expect(resolveEffectivePkg(null, failed())).toBe(PINNED_1);
  });

  it('resolves "" ("system default") to the first pinned recognizer — never a bare start', () => {
    expect(resolveEffectivePkg('', failed())).toBe(PINNED_1);
  });

  it('honors an explicit package that has not failed (pinned or third-party)', () => {
    expect(resolveEffectivePkg(PINNED_2, failed())).toBe(PINNED_2);
    expect(resolveEffectivePkg('com.vendor.zeta', failed())).toBe('com.vendor.zeta');
  });

  it('swaps a failed explicit package for the first available pinned recognizer', () => {
    expect(resolveEffectivePkg('com.anthropic.claude', failed('com.anthropic.claude'))).toBe(PINNED_1);
  });

  it('falls through to the next pinned recognizer when the first pinned one failed', () => {
    expect(resolveEffectivePkg(PINNED_1, failed(PINNED_1))).toBe(PINNED_2);
  });

  it('returns null when every pinned recognizer has failed (null/"" requests)', () => {
    const allPinnedFailed = failed(...DEFAULT_RECOGNIZER_PKGS);
    expect(resolveEffectivePkg(null, allPinnedFailed)).toBeNull();
    expect(resolveEffectivePkg('', allPinnedFailed)).toBeNull();
  });

  it('returns null when a failed explicit package has no pinned recognizer left to fall back to', () => {
    const allPinnedFailed = failed(...DEFAULT_RECOGNIZER_PKGS, 'com.vendor.zeta');
    expect(resolveEffectivePkg('com.vendor.zeta', allPinnedFailed)).toBeNull();
  });

  it('still honors a working explicit third-party even when all pinned recognizers failed', () => {
    // Device without Google engines: an explicit, non-failed third-party is used as-is.
    const allPinnedFailed = failed(...DEFAULT_RECOGNIZER_PKGS);
    expect(resolveEffectivePkg('com.vendor.zeta', allPinnedFailed)).toBe('com.vendor.zeta');
  });
});

describe('isPinnedRecognizer', () => {
  it('recognizes the pinned Google packages', () => {
    expect(isPinnedRecognizer('com.google.android.tts')).toBe(true);
    expect(isPinnedRecognizer('com.google.android.as')).toBe(true);
  });
  it('rejects third-party recognizers', () => {
    expect(isPinnedRecognizer('com.anthropic.claude')).toBe(false);
    expect(isPinnedRecognizer('')).toBe(false);
  });
});

describe('pinnedFailoverChain', () => {
  const opt = (pkg: string) => ({ pkg, label: label(pkg) });

  it('queues only the other pinned recognizers, excluding the chosen one', () => {
    const realHits = [opt(PINNED_1), opt(PINNED_2), opt('com.anthropic.claude')];
    expect(pinnedFailoverChain(realHits, PINNED_1)).toEqual([PINNED_2]);
  });

  it('SECURITY: never queues a third-party RecognitionService', () => {
    // The hijack property: a rogue service that can't serve STT must never be
    // retried via failover, even when enumerated as a real hit.
    const realHits = [opt(PINNED_1), opt(PINNED_2), opt('com.vendor.zeta'), opt('com.anthropic.claude')];
    const chain = pinnedFailoverChain(realHits, PINNED_1);
    expect(chain).not.toContain('com.vendor.zeta');
    expect(chain).not.toContain('com.anthropic.claude');
    expect(chain).toEqual([PINNED_2]); // only the other pinned recognizer survives
  });

  it('returns an empty chain when the chosen pinned pkg is the only pinned hit', () => {
    expect(pinnedFailoverChain([opt(PINNED_1), opt('com.vendor.zeta')], PINNED_1)).toEqual([]);
  });
});

describe('composeFlush', () => {
  it('joins session text and the in-progress partial with a space', () => {
    expect(composeFlush('hello there', 'world now')).toBe('hello there world now');
  });
  it('returns the session text alone when there is no partial', () => {
    expect(composeFlush('hello there', '')).toBe('hello there');
  });
  it('returns the partial alone when there is no session text', () => {
    expect(composeFlush('', 'world now')).toBe('world now');
  });
  it('returns empty string when both are empty', () => {
    expect(composeFlush('', '')).toBe('');
  });
});
