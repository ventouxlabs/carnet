// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

// Presentational error/status sheet for VoiceButton — props-only, no state
// or native calls of its own. Split out of VoiceButton.tsx so the sheet's
// per-errAction action-button wiring (permission / lang-unavailable /
// no-service / no-service-mic-revoked / diag) can be read and changed
// without touching the recognizer/session state machine.

import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type CarnetTheme } from '../lib/theme';
import { type ErrAction, type MicRevokedTarget } from './recognizerCatalog';

export interface VoiceErrorSheetProps {
  theme: CarnetTheme;
  errMsg: string;
  errPersist: boolean;
  errAction: ErrAction;
  micRevokedTarget: MicRevokedTarget | null;
  downloadingModel: boolean;
  onDismiss: () => void;
  onOpenAppSettings: () => void;
  onDownloadModel: () => void;
  onOpenPlayStore: (pkg: string) => void;
  onRetryDetection: () => void;
  onCopyDiagnostics: () => void;
  onOpenAppDetails: (pkg: string) => void;
}

export function VoiceErrorSheet({
  theme,
  errMsg,
  errPersist,
  errAction,
  micRevokedTarget,
  downloadingModel,
  onDismiss,
  onOpenAppSettings,
  onDownloadModel,
  onOpenPlayStore,
  onRetryDetection,
  onCopyDiagnostics,
  onOpenAppDetails,
}: VoiceErrorSheetProps) {
  return (
    <Modal
      visible={errMsg.length > 0}
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
    >
      <Pressable
        style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.7)' }]}
        onPress={errPersist ? undefined : onDismiss}
      >
        <Pressable style={[styles.sheet, { backgroundColor: theme.colors.surface }]} onPress={() => {}}>
          <Text style={[styles.errSheetTitle, { color: theme.colors.onSurface }]}>
            {errPersist ? '⚠️ Voice Input' : 'ℹ️ Voice Input'}
          </Text>
          <ScrollView style={styles.errSheetScroll} showsVerticalScrollIndicator={false}>
          {errAction === 'diag' ? (
            <ScrollView style={[styles.diagScroll, { backgroundColor: theme.colors.background }]}>
              <Text style={[styles.diagText, { color: theme.colors.onSurfaceVariant }]}>{errMsg}</Text>
            </ScrollView>
          ) : (
            <Text style={[styles.errSheetMsg, { color: theme.colors.onSurface }]}>{errMsg}</Text>
          )}
          {errAction === 'permission' && (
            <View style={styles.errActions}>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onOpenAppSettings}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Open App Settings</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Grant Microphone permission manually</Text>
              </Pressable>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onDismiss}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Try Again</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>After enabling permission, tap mic</Text>
              </Pressable>
            </View>
          )}
          {errAction === 'lang-unavailable' && (
            <View style={styles.errActions}>
              <Pressable
                style={[styles.errActionBtn, { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary, opacity: downloadingModel ? 0.6 : 1 }]}
                onPress={onDownloadModel}
                disabled={downloadingModel}
              >
                <Text style={[styles.errActionBtnText, { color: theme.colors.onPrimary }]}>{downloadingModel ? 'Downloading…' : 'Download voice model'}</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onPrimary }]}>Pull the English model on-device — no Play Store trip</Text>
              </Pressable>
              <Pressable
                style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]}
                onPress={() => onOpenPlayStore('com.google.android.tts')}
              >
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Open Speech Services by Google</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Download the English voice model</Text>
              </Pressable>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onRetryDetection}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Retry Detection</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>After downloading, rescan devices</Text>
              </Pressable>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onCopyDiagnostics}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Copy diagnostics</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Paste the scan + probe output into a bug report</Text>
              </Pressable>
            </View>
          )}
          {errAction === 'no-service' && (
            <View style={styles.errActions}>
              <Pressable
                style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]}
                onPress={() => onOpenPlayStore('com.google.android.tts')}
              >
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Install Speech Services by Google</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>com.google.android.tts — provides on-device STT</Text>
              </Pressable>
              <Pressable
                style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]}
                onPress={() => onOpenPlayStore('com.samsung.android.bixby.agent')}
              >
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Install Samsung Bixby</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>com.samsung.android.bixby.agent</Text>
              </Pressable>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onRetryDetection}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Retry Detection</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Rescan device for speech services</Text>
              </Pressable>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onCopyDiagnostics}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Copy diagnostics</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Paste the scan + probe output into a bug report</Text>
              </Pressable>
            </View>
          )}
          {errAction === 'no-service-mic-revoked' && micRevokedTarget && (
            <View style={styles.errActions}>
              <Pressable
                style={[styles.errActionBtn, { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary }]}
                onPress={() => onOpenAppDetails(micRevokedTarget.pkg)}
              >
                <Text style={[styles.errActionBtnText, { color: theme.colors.onPrimary }]}>{`Open ${micRevokedTarget.label} App info`}</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onPrimary }]}>Enable its Microphone permission, then try again</Text>
              </Pressable>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onRetryDetection}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Retry Detection</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>After enabling Microphone, rescan devices</Text>
              </Pressable>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onCopyDiagnostics}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Copy diagnostics</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Paste the scan + probe output into a bug report</Text>
              </Pressable>
            </View>
          )}
          {errAction === 'diag' && (
            <View style={styles.errActions}>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onCopyDiagnostics}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Copy again</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Writes the dump above to the clipboard</Text>
              </Pressable>
              <Pressable style={[styles.errActionBtn, { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={onRetryDetection}>
                <Text style={[styles.errActionBtnText, { color: theme.colors.onSurface }]}>Retry Detection</Text>
                <Text style={[styles.errActionBtnSub, { color: theme.colors.onSurfaceVariant }]}>Rescan device for speech services</Text>
              </Pressable>
            </View>
          )}
          </ScrollView>
          <Pressable style={[styles.errSheetBtn, { backgroundColor: theme.colors.primary }]} onPress={onDismiss}>
            <Text style={[styles.errSheetBtnText, { color: theme.colors.onPrimary }]}>
              {errAction === 'none' ? 'Got it' : 'Dismiss'}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 24, paddingBottom: 40, gap: 12, maxHeight: '85%',
  },
  errSheetTitle: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  errSheetScroll: {},
  errSheetMsg: { fontSize: 15, lineHeight: 22 },
  diagScroll: { maxHeight: 300, borderRadius: 8, padding: 10 },
  diagText: { fontSize: 12, fontFamily: 'monospace', lineHeight: 17 },
  errSheetBtn: {
    marginTop: 16, borderRadius: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  errSheetBtnText: { fontSize: 16, fontWeight: '700' },
  errActions: { gap: 10, marginTop: 12 },
  errActionBtn: {
    borderRadius: 10, padding: 14,
    borderWidth: 1,
  },
  errActionBtnText: { fontSize: 15, fontWeight: '600' },
  errActionBtnSub: { fontSize: 12, marginTop: 3 },
});
