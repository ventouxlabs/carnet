import { StyleSheet, View } from "react-native";
import { Banner, Button, IconButton, Portal, Text } from "react-native-paper";

import { DiscardEditsDialog } from "./DiscardEditsDialog";
import { TagInput } from "./TagInput";
import { WysiwygEditor, type WysiwygEditorRef } from "./WysiwygEditor";
import type { CarnetTheme } from "../lib/theme";
import type { Root } from "../lib/vaultRoot";

interface RichNoteEditorProps {
  theme: CarnetTheme;
  editorRef: React.RefObject<WysiwygEditorRef | null>;
  /** Body-only seed: frontmatter is split off before the editor ever sees it. */
  seed: string;
  rootOverride?: Root;
  editError: string | null;
  saving: boolean;
  tags: string[];
  onTagsChange: (next: string[]) => void;
  knownTags: string[];
  onInsertImage: () => void;
  onCancel: () => void;
  onSave: () => void;
  discardVisible: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

/**
 * Full-screen rich (WYSIWYG) note editing surface.
 *
 * Takes the whole screen so TenTap's formatting toolbar can dock above the
 * keyboard. Frontmatter is split off and reattached on save, so the editor only
 * shows the body — the path/attachments cards aren't needed here, and the
 * scrolling card layout would trap the toolbar in a small box.
 */
export function RichNoteEditor({
  theme,
  editorRef,
  seed,
  rootOverride,
  editError,
  saving,
  tags,
  onTagsChange,
  knownTags,
  onInsertImage,
  onCancel,
  onSave,
  discardVisible,
  onKeepEditing,
  onDiscard,
}: RichNoteEditorProps) {
  return (
    <View style={[styles.richRoot, { backgroundColor: theme.colors.background }]}>
      {editError ? (
        <Banner visible icon="alert" actions={[]}>
          {`Save failed: ${editError}`}
        </Banner>
      ) : null}
      <View
        style={[styles.richBar, { borderBottomColor: theme.colors.outlineVariant }]}
      >
        <Text variant="titleMedium">Editing · Rich text</Text>
        <View style={styles.richBarActions}>
          <IconButton
            icon="image-plus"
            size={22}
            onPress={onInsertImage}
            disabled={saving}
            accessibilityLabel="Insert image"
          />
          <Button onPress={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button mode="contained" onPress={onSave} loading={saving} disabled={saving}>
            Save
          </Button>
        </View>
      </View>
      <View style={styles.richTags}>
        <TagInput tags={tags} onChange={onTagsChange} knownTags={knownTags} />
      </View>
      <View style={styles.richEditor}>
        <WysiwygEditor ref={editorRef} value={seed} rootOverride={rootOverride} />
      </View>
      <Portal>
        <DiscardEditsDialog
          theme={theme}
          visible={discardVisible}
          onKeepEditing={onKeepEditing}
          onDiscard={onDiscard}
        />
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  // Full-screen rich-edit layout. The toolbar docks at the top of the editor
  // (Android edge-to-edge can't lift it above the keyboard — see WysiwygEditor).
  richRoot: { flex: 1 },
  richBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  richBarActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  richTags: { paddingHorizontal: 16, paddingBottom: 4 },
  richEditor: { flex: 1 },
});
