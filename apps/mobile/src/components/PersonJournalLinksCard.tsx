import { StyleSheet, View } from "react-native";
import { Button, Card, IconButton, Text } from "react-native-paper";

import type { PersonJournalMatch } from "../lib/personJournalLinks";

interface Props {
  matches: readonly PersonJournalMatch[];
  onLink: (match: PersonJournalMatch) => void;
}

/** Explicit, one-way Person → journal links. Obsidian backlinks provide the
 * reverse relation without a fragile two-file transaction. */
export function PersonJournalLinksCard({ matches, onLink }: Props) {
  if (matches.length === 0) return null;
  return (
    <Card style={styles.card}>
      <Card.Title title="Journal mentions" />
      <Card.Content style={styles.list}>
        {matches.map((match) => (
          <View key={match.uri} style={styles.row}>
            <View style={styles.copy}>
              <Button mode="text" compact>{match.linkTitle}</Button>
              <Text variant="bodySmall" numberOfLines={3}>{match.excerpt}</Text>
            </View>
            <IconButton
              icon="link-plus"
              size={20}
              onPress={() => onLink(match)}
              accessibilityLabel={`Link journal ${match.linkTitle} into this person`}
            />
          </View>
        ))}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 4 },
  list: { gap: 12 },
  row: { flexDirection: "row", alignItems: "center" },
  copy: { flex: 1 },
});
