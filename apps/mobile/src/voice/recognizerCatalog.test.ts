// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { KNOWN_RECOGNIZERS, labelForPackage } from './recognizerCatalog';

describe('labelForPackage', () => {
  it('returns the catalog label for a known package', () => {
    expect(labelForPackage('com.google.android.as')).toBe('Google (On-Device)');
    expect(labelForPackage('com.samsung.android.bixby.agent')).toBe('Samsung Bixby');
  });

  it('derives a title-cased fallback label from the last path segment for an unknown package', () => {
    expect(labelForPackage('com.example.myrecognizer')).toBe('Myrecognizer');
  });

  it('falls back to the whole string when there is no dot segment', () => {
    expect(labelForPackage('recognizer')).toBe('Recognizer');
  });

  it('matches every catalog entry against itself', () => {
    for (const r of KNOWN_RECOGNIZERS) {
      expect(labelForPackage(r.pkg)).toBe(r.label);
    }
  });
});
