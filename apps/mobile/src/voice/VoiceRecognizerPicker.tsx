// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

// Presentational "choose a voice recognizer" sheet for VoiceButton —
// props-only, no state of its own. Split out of VoiceButton.tsx alongside
// VoiceErrorSheet so the picker's markup can be read independently of the
// detection/session state machine that decides when to show it.

import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type CarnetTheme } from '../lib/theme';
import { type RecognizerOption } from './recognizerSelect';

export interface VoiceRecognizerPickerProps {
  theme: CarnetTheme;
  visible: boolean;
  options: RecognizerOption[];
  onDismiss: () => void;
  onPick: (option: RecognizerOption) => void;
}

export function VoiceRecognizerPicker({ theme, visible, options, onDismiss, onPick }: VoiceRecognizerPickerProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.7)' }]} onPress={onDismiss}>
        <View style={[styles.sheet, { backgroundColor: theme.colors.surface }]}>
          <Text style={[styles.sheetTitle, { color: theme.colors.onSurface }]}>Choose voice recognizer</Text>
          <Text style={[styles.sheetSub, { color: theme.colors.onSurfaceVariant }]}>Multiple speech services found on this device</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {options.map((opt) => (
              <Pressable key={opt.pkg} style={[styles.sheetOption, { marginBottom: 12, backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant }]} onPress={() => onPick(opt)}>
                <Text style={[styles.sheetOptionLabel, { color: theme.colors.onSurface }]}>{opt.label}</Text>
                <Text style={[styles.sheetOptionPkg, { color: theme.colors.onSurfaceVariant }]}>{opt.pkg}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
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
  sheetTitle: { fontSize: 17, fontWeight: '700' },
  sheetSub: { fontSize: 13, marginBottom: 4 },
  sheetOption: {
    borderRadius: 10, padding: 16,
    borderWidth: 1,
  },
  sheetOptionLabel: { fontSize: 15, fontWeight: '600' },
  sheetOptionPkg: { fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
});
