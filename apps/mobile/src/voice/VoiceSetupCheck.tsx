// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Settings → Voice input → "Check voice setup". The manual, always-available
// half of STT onboarding v2: probe on-device speech readiness on demand and
// surface the same one recommended action the proactive Home banner uses, so a
// user who suspects their dictation is broken can fix it without first hitting
// the code-12 dead-end during a real capture.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, HelperText, Text, useTheme } from 'react-native-paper';

import { checkSttReadiness, triggerVoiceModelDownload } from './sttReadiness';
import { describeReadiness, type OnboardingTone, type ReadinessCopy } from './sttOnboarding';

export function VoiceSetupCheck() {
  const theme = useTheme();
  const [checking, setChecking] = useState(false);
  const [copy, setCopy] = useState<ReadinessCopy | null>(null);
  const [downloading, setDownloading] = useState(false);
  // True after a download was queued (dialog/scheduled) so the button can't be
  // re-tapped before the next check. Reset whenever a fresh check runs.
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Settings is long-lived, but the probe/download awaits can still outlive the
  // screen if the user backs out mid-call — guard setState like the banner does.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toneColor = useCallback(
    (tone: OnboardingTone): string => {
      switch (tone) {
        case 'ok':
          return theme.colors.primary;
        case 'warn':
          return theme.colors.error;
        case 'info':
          return theme.colors.onSurfaceVariant;
      }
    },
    [theme.colors],
  );

  const runCheck = useCallback(async () => {
    setChecking(true);
    setNote(null);
    setDownloadStarted(false);
    try {
      const readiness = await checkSttReadiness();
      if (!mounted.current) return;
      setCopy(describeReadiness(readiness));
    } catch {
      // checkSttReadiness already collapses native throws to 'unsupported';
      // this catch only guards an unexpected rejection so the button re-enables.
      if (!mounted.current) return;
      setCopy(null);
      setNote('Could not check voice setup. Try again.');
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, []);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const result = await triggerVoiceModelDownload('en-US');
      if (!mounted.current) return;
      if (result === 'installed') {
        setNote('English voice model installed.');
        await runCheck();
      } else if (result === 'dialog' || result === 'scheduled') {
        setDownloadStarted(true);
        setNote('Downloading the English voice model… check again in a moment.');
      } else {
        setNote(
          'Could not start the download. Open Speech Services by Google from the Play Store.',
        );
      }
    } finally {
      if (mounted.current) setDownloading(false);
    }
  }, [runCheck]);

  const openPermissionSettings = useCallback(() => {
    Linking.openSettings().catch(() => {
      setNote('Could not open app settings. Grant Microphone permission manually.');
    });
  }, []);

  return (
    <View>
      <Button
        mode="outlined"
        icon="account-voice"
        onPress={runCheck}
        disabled={checking}
        style={styles.checkBtn}
      >
        {checking ? 'Checking…' : 'Check voice setup'}
      </Button>
      {checking ? (
        <View style={styles.checkingRow}>
          <ActivityIndicator size="small" />
          <Text variant="bodySmall" style={styles.checkingText}>
            Probing on-device speech services…
          </Text>
        </View>
      ) : null}

      {copy ? (
        <View style={[styles.resultCard, { borderColor: toneColor(copy.tone) }]}>
          <Text variant="titleSmall" style={{ color: toneColor(copy.tone) }}>
            {copy.title}
          </Text>
          <Text variant="bodySmall" style={styles.resultBody}>
            {copy.body}
          </Text>
          {copy.action === 'download' ? (
            <Button
              mode="contained"
              icon="download"
              compact
              loading={downloading}
              disabled={downloading || downloadStarted}
              onPress={handleDownload}
              style={styles.resultAction}
            >
              {downloadStarted
                ? 'Download started'
                : downloading
                  ? 'Downloading…'
                  : 'Download voice model'}
            </Button>
          ) : null}
          {copy.action === 'open-permission' ? (
            <Button
              mode="contained-tonal"
              icon="cog"
              compact
              onPress={openPermissionSettings}
              style={styles.resultAction}
            >
              Open app settings
            </Button>
          ) : null}
        </View>
      ) : null}

      {note ? (
        <HelperText type="info" visible>
          {note}
        </HelperText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  checkBtn: { alignSelf: 'flex-start', marginTop: 4 },
  checkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  checkingText: { opacity: 0.7 },
  resultCard: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  resultBody: { opacity: 0.85 },
  resultAction: { alignSelf: 'flex-start', marginTop: 8 },
});
