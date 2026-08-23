// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { mapReadiness } from './sttReadiness';

// Default-everything-OK probe; spread-override per case so each test states only
// the field that matters. Mirrors the pure-helper test style of recognizerSelect.
const baseProbe = {
  recognitionAvailable: true,
  onDeviceSupported: true,
  permissionGranted: true,
  locales: ['en-US'] as readonly string[],
  installedLocales: ['en-US'] as readonly string[],
};

describe('mapReadiness', () => {
  describe('unsupported', () => {
    it('reports unsupported when recognition is unavailable', () => {
      expect(mapReadiness({ ...baseProbe, recognitionAvailable: false })).toEqual({
        state: 'unsupported',
      });
    });

    it('reports unsupported when on-device recognition is not supported', () => {
      expect(mapReadiness({ ...baseProbe, onDeviceSupported: false })).toEqual({
        state: 'unsupported',
      });
    });

    it('reports unsupported when no English locale appears anywhere', () => {
      expect(
        mapReadiness({
          ...baseProbe,
          locales: ['de-DE', 'fr-FR'],
          installedLocales: ['de-DE'],
        }),
      ).toEqual({ state: 'unsupported' });
    });

    it('reports unsupported when both locale arrays are empty', () => {
      expect(
        mapReadiness({ ...baseProbe, locales: [], installedLocales: [] }),
      ).toEqual({ state: 'unsupported' });
    });
  });

  describe('no-permission', () => {
    it('reports no-permission when the permission was not granted', () => {
      expect(
        mapReadiness({ ...baseProbe, permissionGranted: false }),
      ).toEqual({ state: 'no-permission' });
    });

    it('prioritizes unsupported over no-permission', () => {
      // unsupported is checked first: no recognition AND no permission → unsupported.
      expect(
        mapReadiness({
          ...baseProbe,
          recognitionAvailable: false,
          permissionGranted: false,
        }),
      ).toEqual({ state: 'unsupported' });
    });
  });

  describe('ready', () => {
    it('reports ready when the exact preferred locale is installed', () => {
      expect(
        mapReadiness({ ...baseProbe, locales: ['en-US'], installedLocales: ['en-US'] }),
      ).toEqual({ state: 'ready', locale: 'en-US' });
    });

    it('reports ready when a different English locale (en-GB) is installed', () => {
      // The preferred is en-US, but en-GB installed still satisfies the en- prefix.
      expect(
        mapReadiness({
          ...baseProbe,
          locales: ['en-GB'],
          installedLocales: ['en-GB'],
        }),
      ).toEqual({ state: 'ready', locale: 'en-US' });
    });

    it('matches the installed locale case-insensitively', () => {
      expect(
        mapReadiness({
          ...baseProbe,
          locales: ['EN-us'],
          installedLocales: ['EN-us'],
        }),
      ).toEqual({ state: 'ready', locale: 'en-US' });
    });

    it('honors a non-default preferred locale that is installed', () => {
      expect(
        mapReadiness(
          { ...baseProbe, locales: ['en-GB'], installedLocales: ['en-GB'] },
          'en-GB',
        ),
      ).toEqual({ state: 'ready', locale: 'en-GB' });
    });
  });

  describe('needs-model', () => {
    it('reports needs-model when English is supported but not installed', () => {
      expect(
        mapReadiness({
          ...baseProbe,
          locales: ['en-US', 'de-DE'],
          installedLocales: ['de-DE'],
        }),
      ).toEqual({ state: 'needs-model', locale: 'en-US' });
    });

    it('reports needs-model when English is supported but nothing is installed', () => {
      expect(
        mapReadiness({
          ...baseProbe,
          locales: ['en-GB'],
          installedLocales: [],
        }),
      ).toEqual({ state: 'needs-model', locale: 'en-US' });
    });
  });
});
