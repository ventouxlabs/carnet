import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, HelperText, List, Text, TextInput } from "react-native-paper";

import type { PromptOverrides } from "../lib/settings";
import {
  buildEnhanceProsePrompt,
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildRetrospectivePrompt,
  buildSharedImagePrompt,
  buildSharedLinkPrompt,
} from "../lib/prompts";
import { caretProps, useCarnetTheme } from "../lib/theme";

const PROMPT_MODES = [
  { key: "idea", label: "Idea", icon: "lightbulb-on" },
  { key: "journal", label: "Journal", icon: "microphone" },
  { key: "person", label: "Contact", icon: "account" },
  { key: "sharedImage", label: "Photo + Image", icon: "camera" },
  { key: "sharedLink", label: "Link + Text", icon: "link" },
  // Not a capture mode — this one runs post-hoc, from a saved note's ⋮ sheet.
  { key: "enhanceProse", label: "Enhance prose", icon: "feather" },
  // Not a capture mode either — this one runs from Search, synthesizing an
  // answer over many retrieved notes rather than processing one capture.
  { key: "retrospective", label: "Retrospective query", icon: "history" },
] as const;

type PromptModeKey = (typeof PROMPT_MODES)[number]["key"];

/** Render the default system prompt for a mode by invoking the builder
 * with placeholder args. Used to populate the "Copy default" button so
 * the user has a starting point for tweaking. */
function defaultPromptFor(mode: PromptModeKey): string {
  switch (mode) {
    case "idea":
      return buildIdeaPrompt("placeholder").system;
    case "journal":
      return buildJournalPrompt("placeholder", "").system;
    case "person":
      return buildPersonPrompt("placeholder", "").system;
    case "sharedImage":
      return buildSharedImagePrompt("").system;
    case "sharedLink":
      return buildSharedLinkPrompt("", "", "", null).system;
    case "enhanceProse":
      return buildEnhanceProsePrompt("placeholder").system;
    case "retrospective":
      return buildRetrospectivePrompt("placeholder", []).system;
  }
}

interface PromptOverridesSectionProps {
  overrides: PromptOverrides;
  onChange: (next: PromptOverrides) => void;
}

/**
 * The "Advanced" settings section: per-capture-mode system-prompt overrides,
 * one collapsible editor per mode. Extracted from SettingsScreen (which was
 * over the repo's file-size norm) — pure presentation; persistence stays with
 * the parent's form state + Save.
 */
export function PromptOverridesSection({
  overrides,
  onChange,
}: PromptOverridesSectionProps) {
  const theme = useCarnetTheme();
  // Which editor is open. Null = all collapsed. Screen-local UI state.
  const [expanded, setExpanded] = useState<PromptModeKey | null>(null);

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={styles.title}>
        Advanced · Prompt overrides
      </Text>
      <HelperText type="info" visible>
        Override how your active provider structures each capture mode. Leave a section
        empty to use the default. Removing the frontmatter format or injection
        guard can drop captures to a stub note — use "Reset to default" to
        recover.
      </HelperText>
      {PROMPT_MODES.map(({ key, label, icon }) => {
        const isExpanded = expanded === key;
        const value = overrides[key] ?? "";
        const isCustomized = value.trim().length > 0;
        return (
          <View key={key}>
            <List.Item
              title={label}
              description={isCustomized ? "customized" : "using default"}
              left={(p) => <List.Icon {...p} icon={icon} />}
              right={(p) => (
                <List.Icon
                  {...p}
                  icon={isExpanded ? "chevron-up" : "chevron-down"}
                />
              )}
              onPress={() => setExpanded(isExpanded ? null : key)}
              style={styles.row}
            />
            {isExpanded ? (
              <View style={styles.editor}>
                <TextInput
                  {...caretProps(theme)}
                  mode="outlined"
                  multiline
                  numberOfLines={10}
                  value={value}
                  onChangeText={(v) => onChange({ ...overrides, [key]: v })}
                  placeholder="(empty — using the default. Tap Copy default to start editing)"
                  style={styles.input}
                />
                <View style={styles.actions}>
                  <Button
                    mode="text"
                    compact
                    onPress={() =>
                      onChange({ ...overrides, [key]: defaultPromptFor(key) })
                    }
                  >
                    Copy default
                  </Button>
                  {isCustomized ? (
                    <Button
                      mode="text"
                      compact
                      onPress={() => onChange({ ...overrides, [key]: "" })}
                    >
                      Reset to default
                    </Button>
                  ) : null}
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 16 },
  title: { paddingHorizontal: 0, paddingTop: 8 },
  row: { paddingHorizontal: 0 },
  editor: { paddingHorizontal: 0, paddingBottom: 8, gap: 4 },
  input: { fontFamily: "monospace" },
  actions: { flexDirection: "row", gap: 8 },
});
