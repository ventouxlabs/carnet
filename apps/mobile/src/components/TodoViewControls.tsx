import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Button, Searchbar, SegmentedButtons, Switch, Text } from "react-native-paper";
import type { CaptureMode } from "../lib/storage";
import { defaultTodoViewPreferences, type TodoViewPreferences } from "../lib/todoView";
import { caretProps, MIN_TAP_TARGET, useCarnetTheme } from "../lib/theme";
import { StampChip } from "./StampChip";

interface Props {
  view: TodoViewPreferences;
  options: { modes: CaptureMode[]; tags: string[] };
  disabled: boolean;
  onChange: (view: TodoViewPreferences) => void;
}

export function TodoViewControls({ view, options, disabled, onChange }: Props) {
  const theme = useCarnetTheme();
  const [expanded, setExpanded] = useState(false);
  const spacing = theme.carnet.spacing;
  const toggle = <T extends string,>(values: T[], value: T): T[] =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
  const chips = (kind: "modes" | "tags", values: string[]) => values.map((value) => (
    <Pressable key={value} disabled={disabled}
      accessibilityRole="button" accessibilityLabel={`${kind === "modes" ? "Mode" : "Tag"}: ${value}`}
      accessibilityState={{ selected: view[kind].includes(value as CaptureMode), disabled }}
      onPress={() => onChange(kind === "modes"
        ? { ...view, modes: toggle(view.modes, value as CaptureMode) }
        : { ...view, tags: toggle(view.tags, value) })}
      style={{ minHeight: MIN_TAP_TARGET, minWidth: MIN_TAP_TARGET, justifyContent: "center" }}>
      <StampChip label={value} tone={view[kind].includes(value as CaptureMode) ? "accent" : "neutral"} />
    </Pressable>
  ));
  return (
    <View style={{ padding: spacing.md, gap: spacing.sm }}>
      <Searchbar placeholder="Search tasks or source notes" accessibilityLabel="Search todos"
        value={view.query} maxLength={512} editable={!disabled} {...caretProps(theme)}
        onChangeText={(query) => onChange({ ...view, query })}
        style={{ borderRadius: theme.carnet.radius.pill }} />
      <SegmentedButtons value={view.status}
        onValueChange={(status) => onChange({ ...view, status: status as TodoViewPreferences["status"] })}
        buttons={["open", "completed", "all"].map((value) => ({ value,
          label: value === "open" ? "Open" : value === "completed" ? "Completed" : "All",
          disabled, style: { minHeight: MIN_TAP_TARGET } }))} />
      <Button disabled={disabled} icon="filter-variant" onPress={() => setExpanded(!expanded)}
        accessibilityLabel={expanded ? "Hide view options" : "View options"}
        contentStyle={{ minHeight: MIN_TAP_TARGET }}>View options{view.modes.length + view.tags.length ? ` (${view.modes.length + view.tags.length})` : ""}</Button>
      {(view.modes.length > 0 || view.tags.length > 0) && <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        { [...view.modes, ...view.tags.map((tag) => `#${tag}`)].join(", ") }
      </Text>}
      {expanded && <ScrollView style={{ maxHeight: MIN_TAP_TARGET * 6,
        backgroundColor: theme.colors.surface, borderRadius: theme.carnet.radius.card,
        borderWidth: 1, borderColor: theme.colors.outline }}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}>
        <Text variant="titleSmall">Capture modes</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>{chips("modes", options.modes)}</View>
        <Text variant="titleSmall">Tags — any selected tag</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>{chips("tags", options.tags)}</View>
        <Text variant="titleSmall">Sort by source note</Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>Newest and oldest use the source note date.</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {(["newest", "oldest", "source"] as const).map((sort) => <Button key={sort} disabled={disabled}
            mode={view.sort === sort ? "outlined" : "text"} accessibilityState={{ selected: view.sort === sort }}
            onPress={() => onChange({ ...view, sort })} contentStyle={{ minHeight: MIN_TAP_TARGET }}>
            {sort === "newest" ? "Newest" : sort === "oldest" ? "Oldest" : "Source title"}
          </Button>)}
        </View>
        <View
          style={{ flexDirection: "row", alignItems: "center", minHeight: MIN_TAP_TARGET }}>
          <Text variant="bodyMedium" style={{ flex: 1 }}>Group by source note</Text>
          <Switch accessibilityLabel="Group by source note" disabled={disabled} value={view.groupBySource} style={{ minHeight: MIN_TAP_TARGET, minWidth: MIN_TAP_TARGET }}
            onValueChange={(groupBySource) => onChange({ ...view, groupBySource })} />
        </View>
        <Button disabled={disabled} onPress={() => onChange(defaultTodoViewPreferences())}
          contentStyle={{ minHeight: MIN_TAP_TARGET }}>Reset view</Button>
      </ScrollView>}
    </View>
  );
}
