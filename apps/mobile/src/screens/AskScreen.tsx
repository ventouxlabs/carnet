/**
 * Retrospective query — ask a question about the notes currently on the Search
 * screen and read a synthesized, cited answer.
 *
 * This screen is a composition, not new logic: selection and citation
 * resolution are pure (lib/retrospective.ts), the read is bounded by the vault
 * module (readNoteBodies), the model call goes through the provider seam
 * (dispatcher.askVault), and the save is the vault's own writer. What lives
 * here is the pipeline order, the three states it can be in, and the two
 * honesty properties the feature depends on:
 *
 *  - The answer is sanitized ONCE, before it reaches either surface. The
 *    renderer is the first place model output lands, so gating only the save
 *    path would leave the screen itself unguarded.
 *  - The answer says when it was built from fewer notes than matched. A
 *    partial answer that reads as complete is the failure mode here: "your
 *    notes don't say much about this" and "the notes holding the answer were
 *    never read" are indistinguishable to the user otherwise.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ActivityIndicator, Button, Snackbar, Text } from "react-native-paper";

import {
  disclosureLine,
  orderCandidates,
  packBodies,
  pickForRead,
  resolveCitations,
  buildSynthesisNote,
  type AnswerSegment,
  type RetrievalCandidate,
  type SelectedNote,
} from "../lib/retrospective";
import { askVault } from "../lib/dispatcher";
import { askErrorMessage } from "../lib/captureErrorDecision";
import { sanitizeMarkdown } from "../lib/enrichSanitize";
import { readNoteBodies, resolveNoteEntry, upsertNoteInIndex } from "../lib/vault";
import { writeSynthesis } from "../lib/writer";
import { slugify } from "../lib/noteNaming";
import { todayLocal } from "../lib/captureLocalIds";
import type { CaptureEntry } from "../lib/storage";
import { MIN_TAP_TARGET, spacing, useCarnetTheme } from "../lib/theme";

/** Route params. Exported so App.tsx can declare `Ask: AskRouteParams` in
 * RootStackParamList without restating the shape. */
export interface AskRouteParams {
  question: string;
  candidates: RetrievalCandidate[];
}

/** Structural props rather than NativeStackScreenProps: this component is
 * written before its route exists in RootStackParamList, and it needs exactly
 * two things from navigation. The real screen props are assignable to these. */
export interface AskScreenProps {
  route: { params: AskRouteParams };
  navigation: {
    navigate: (screen: "RecentDetail", params: { entry: CaptureEntry }) => void;
  };
}

type Phase = "loading" | "answered" | "empty" | "failed";

export default function AskScreen({ route, navigation }: AskScreenProps) {
  const theme = useCarnetTheme();
  const { question, candidates } = route.params;

  const [phase, setPhase] = useState<Phase>("loading");
  const [segments, setSegments] = useState<AnswerSegment[]>([]);
  const [disclosure, setDisclosure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The sanitized answer + the notes it was actually built from, held for the
   * save path so it writes the same bytes that were rendered. */
  const answerRef = useRef<{ markdown: string; sources: SelectedNote[] } | null>(null);

  // Plain useEffect with a run-once ref, NOT useFocusEffect: re-running on
  // focus would re-ask the model (a paid, slow call) every time the user
  // returns from tapping a citation. `candidates` is a fresh array identity on
  // every render, so a dependency list alone cannot hold this to one run.
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;

    const controller = new AbortController();
    let active = true;

    const run = async () => {
      // orderCandidates wants the two streams separately (body matches
      // outrank indexed hits) and dedupes across them; Search hands over one
      // flat list, so split it back out here rather than duplicating its
      // ordering rule at the call site.
      const ordered = orderCandidates(
        candidates.filter((c) => c.fromBodyMatch),
        candidates.filter((c) => !c.fromBodyMatch),
      );
      const picked = pickForRead(ordered);

      try {
        const bodies = await readNoteBodies(
          picked.map((c) => c.uri),
          controller.signal,
        );
        if (!active) return;

        const selected = packBodies(picked, bodies);
        if (selected.length === 0) {
          setPhase("empty");
          return;
        }

        const outcome = await askVault(question, selected);
        if (!active) return;

        // Sanitize once, here — both the renderer below and the save path read
        // this string, so no route exists for raw model output to reach either.
        const sanitized = sanitizeMarkdown(outcome.result.markdown);
        answerRef.current = { markdown: sanitized, sources: selected };
        setSegments(resolveCitations(sanitized, selected));
        setDisclosure(disclosureLine(selected.length, ordered.length));
        setPhase("answered");
      } catch (e: unknown) {
        if (!active) return;
        setError(askErrorMessage(e));
        setPhase("failed");
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [question, candidates]);

  // Ref guard matches every other async action in this app (#114 pattern): a
  // double-tap must not write two synthesis notes into the vault.
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const handleSave = useCallback(async () => {
    const answer = answerRef.current;
    if (savingRef.current || !answer) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const md = buildSynthesisNote(question, answer.markdown, answer.sources, todayLocal());
      const { filepath } = await writeSynthesis(slugify(question), md);
      // No writer in writer.ts self-indexes; every call site pairs the two.
      // Without this the note is on disk but missing from Search and
      // TagBrowser until a manual pull-to-refresh, which reads as "I saved it
      // and it vanished."
      void upsertNoteInIndex(filepath, md).catch(() => undefined);
      setSaved(true);
    } catch (e: unknown) {
      setError(askErrorMessage(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [question]);

  // Ref guard for the same reason as save: a double-tap must not stack the
  // detail screen twice. Mirrors RecentDetailScreen's openRelated.
  const openingRef = useRef(false);
  const openCitation = useCallback(
    async (uri: string) => {
      if (openingRef.current) return;
      openingRef.current = true;
      try {
        const entry = await resolveNoteEntry(uri);
        // A citation can outlive its note (deleted since the index was built).
        // Navigating with a null entry would crash the detail screen.
        if (entry) navigation.navigate("RecentDetail", { entry });
      } finally {
        openingRef.current = false;
      }
    },
    [navigation],
  );

  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="titleMedium" style={styles.question}>
          {question}
        </Text>

        {phase === "loading" && (
          <View style={styles.centered}>
            <ActivityIndicator />
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Reading your notes…
            </Text>
          </View>
        )}

        {phase === "empty" && (
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            None of these notes could be read.
          </Text>
        )}

        {phase === "answered" && (
          // Segments render as sibling Text runs inside one paragraph so a
          // citation stays inline with the prose around it. Block-level
          // markdown rendering is deliberately not used: it cannot survive
          // being split across segment boundaries without losing the
          // pressable citations, which are the point of the screen.
          <Text variant="bodyLarge" style={styles.answer}>
            {segments.map((seg, i) =>
              seg.linkUri ? (
                <Pressable
                  key={i}
                  accessibilityRole="link"
                  accessibilityLabel={`Open note ${seg.text}`}
                  hitSlop={{ top: spacing.sm, bottom: spacing.sm }}
                  onPress={() => void openCitation(seg.linkUri!)}
                >
                  <Text
                    variant="bodyLarge"
                    style={{ color: theme.colors.primary, textDecorationLine: "underline" }}
                  >
                    {seg.text}
                  </Text>
                </Pressable>
              ) : (
                <Text key={i} variant="bodyLarge">
                  {seg.text}
                </Text>
              ),
            )}
          </Text>
        )}

        {disclosure !== null && (
          <Text
            variant="bodySmall"
            style={[styles.disclosure, { color: theme.colors.onSurfaceVariant }]}
          >
            {disclosure}
          </Text>
        )}
      </ScrollView>

      {phase === "answered" && (
        <View style={styles.actions}>
          <Button
            mode="contained"
            accessibilityLabel="Save answer to vault"
            onPress={() => void handleSave()}
            loading={saving}
            disabled={saving || saved}
          >
            {saved ? "Saved" : "Save to vault"}
          </Button>
        </View>
      )}

      <Snackbar visible={error !== null} onDismiss={() => setError(null)} duration={7000}>
        {error ?? ""}
      </Snackbar>
      <Snackbar visible={saved} onDismiss={() => setSaved(false)} duration={2500}>
        Saved to Notes.
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  question: { fontStyle: "italic" },
  centered: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.xxl },
  answer: { lineHeight: 24 },
  disclosure: { fontStyle: "italic" },
  actions: { padding: spacing.lg, minHeight: MIN_TAP_TARGET },
});
