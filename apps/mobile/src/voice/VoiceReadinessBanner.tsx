// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

// The proactive half of STT onboarding v2: a one-shot Home banner that offers
// to download the on-device English voice model BEFORE the user hits the
// code-12 dead-end mid-dictation. It only appears when the model is genuinely
// missing (state 'needs-model'), the on-device engine is selected, and the user
// hasn't been nudged before — every other case is handled by the reactive
// VoiceButton sheet or the manual Settings check. Either action (download or
// dismiss) flips the persisted one-shot flag so it never nags again; the
// recurring path is Settings → "Check voice setup".

import { useEffect, useRef, useState } from 'react';
import { Banner, Snackbar } from 'react-native-paper';

import { checkSttReadiness, triggerVoiceModelDownload } from './sttReadiness';
import {
  describeReadiness,
  markOnboardingPrompted,
  shouldPromptProactively,
  wasOnboardingPrompted,
} from './sttOnboarding';

export function VoiceReadinessBanner() {
  const [visible, setVisible] = useState(false);
  const [body, setBody] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Run the readiness probe once per mount, gated by the persisted one-shot
    // flag. We deliberately do NOT set the flag here for a no-op outcome (e.g.
    // permission not yet granted), so a later launch can still catch the
    // model-missing window once the user has dictated at least once.
    void (async () => {
      try {
        if (await wasOnboardingPrompted()) return;
        // checkSttReadiness collapses any native throw (iOS, Expo Go, missing
        // bridge) to 'unsupported', so on non-Android-13+ devices this resolves
        // to a no-op and the banner stays inert by design — carnet's code-12
        // model-download fix is Android-only.
        const readiness = await checkSttReadiness();
        if (!mounted.current) return;
        if (shouldPromptProactively({ readiness, alreadyPrompted: false, engine: 'ondevice' })) {
          setBody(describeReadiness(readiness).body);
          setVisible(true);
          // Spend the one-shot the moment we decide to show it — not on action —
          // so a Home remount before the user taps can't re-probe and re-show.
          // Trade-off: a user who never interacts won't be re-nudged; the
          // recurring path is Settings → "Check voice setup".
          void markOnboardingPrompted();
        }
      } catch {
        // Best-effort onboarding — never block Home on a probe failure.
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  // The one-shot flag is already persisted when the banner is shown (see the
  // mount effect), so the action handlers only need to drive the UI.
  const handleDismiss = () => {
    setVisible(false);
  };

  const handleDownload = () => {
    setDownloading(true);
    void (async () => {
      try {
        const result = await triggerVoiceModelDownload('en-US');
        if (!mounted.current) return;
        if (result === 'installed') {
          setSnack('English voice model installed — dictation is ready.');
        } else if (result === 'dialog' || result === 'scheduled') {
          setSnack('Downloading the English voice model…');
        } else {
          setSnack('Could not start the download. Try Settings → Check voice setup.');
        }
      } finally {
        if (mounted.current) {
          setDownloading(false);
          setVisible(false);
        }
      }
    })();
  };

  return (
    <>
      <Banner
        visible={visible}
        icon="microphone-message"
        actions={[
          {
            label: downloading ? 'Downloading…' : 'Download model',
            onPress: handleDownload,
            disabled: downloading,
          },
          {
            label: 'Not now',
            onPress: handleDismiss,
            disabled: downloading,
          },
        ]}
      >
        {body}
      </Banner>
      <Snackbar
        visible={snack !== null}
        onDismiss={() => setSnack(null)}
        duration={4000}
      >
        {snack ?? ''}
      </Snackbar>
    </>
  );
}
