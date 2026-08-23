// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Theme-aware style map for react-native-markdown-display, shared by the note
 * reading surface and the markdown editor's preview pane.
 *
 * fontFamily is intentionally omitted — some emoji and accented chars crash on
 * Android when a custom family is set, and the platform default handles them
 * cleanly. Plain objects only: no react-native import, so it stays unit
 * testable.
 */

import type { MD3Theme } from "react-native-paper";

export function markdownStyle(theme: MD3Theme) {
  return {
    body: { color: theme.colors.onSurface, fontSize: 15, lineHeight: 22 },
    heading1: {
      color: theme.colors.onSurface,
      fontWeight: "700" as const,
      marginTop: 12,
      fontSize: 22,
    },
    heading2: {
      color: theme.colors.onSurface,
      fontWeight: "600" as const,
      marginTop: 10,
      fontSize: 18,
    },
    heading3: {
      color: theme.colors.onSurface,
      fontWeight: "600" as const,
      marginTop: 8,
      fontSize: 16,
    },
    code_inline: {
      backgroundColor: theme.colors.surfaceVariant,
      color: theme.colors.onSurfaceVariant,
      padding: 2,
      borderRadius: 4,
    },
    code_block: {
      backgroundColor: theme.colors.surfaceVariant,
      color: theme.colors.onSurfaceVariant,
      padding: 8,
      borderRadius: 6,
    },
    fence: {
      backgroundColor: theme.colors.surfaceVariant,
      color: theme.colors.onSurfaceVariant,
      padding: 8,
      borderRadius: 6,
    },
    link: { color: theme.colors.primary },
    bullet_list: { marginTop: 6 },
    ordered_list: { marginTop: 6 },
  };
}
