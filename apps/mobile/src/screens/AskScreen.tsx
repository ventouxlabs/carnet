/**
 * Retrospective query — ask a question about the notes currently on the Search
 * screen and read a synthesized, cited answer.
 *
 * This screen is a composition, not new logic: selection and citation
 * resolution are pure (lib/retrospective.ts), the read is bounded by the vault
 * module (readNoteBodies), the model call goes through the provider seam
 * (dispatcher.askVault), and the save is the vault's own writer. What lives
 * here is the pipeline order, the four states it can be in (loading, answered,
 * empty, failed), and the honesty properties the feature depends on:
 *
 *  - The answer is sanitized ONCE, before it reaches either surface. The
 *    renderer is the first place model output lands, so gating only the save
 *    path would leave the screen itself unguarded.
 *  - The answer says when it was built from fewer notes than matched. A
 *    partial answer that reads as complete is the failure mode here: "your
 *    notes don't say much about this" and "the notes holding the answer were
 *    never read" are indistinguishable to the user otherwise.
 *  - An empty answer is a failure, never a blank note offered for saving.
 *  - A save reports what actually happened: a write that lands on disk but
 *    fails to index says so, rather than claiming a plain success.
 *
 * Every FAILED state renders a Retry rather than leaving the question on
 * screen with nothing under it — a read error, a provider error, and an empty
 * answer all land in `phase === "failed"` and are one tap from another go.
 * The "empty" phase deliberately does not: it means no note in the set could
 * be read at all, so a Retry would re-read the same uris and land straight
 * back here. Its recovery is the back button, to a Search that can offer a
 * different set.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ActivityIndicator, Button, Snackbar, Text } from "react-native-paper";

import {
  disclosureLine,
  normalizeLeadingMarkdown,
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

/** Trimmed from enhanceProse's "The model returned nothing — the note was left
 * unchanged." The second clause doesn't apply here: there is no note yet. */
const EMPTY_ANSWER = "The model returned nothing.";
const SAVED_OK = "Saved to Notes.";
const SAVED_NOT_INDEXED = "Saved to Notes, but Search needs a refresh to show it.";

export default function AskScreen({ route, navigation }: AskScreenProps) {
  const theme = useCarnetTheme();
  const { question, candidates } = route.params;

  const [phase, setPhase] = useState<Phase>("loading");
  const [segments, setSegments] = useState<AnswerSegment[]>([]);
  const [disclosure, setDisclosure] = useState<string | null>(null);
  /** Why the ask failed. Rendered in the body (with Retry), NOT in a Snackbar:
   * a self-clearing toast would leave the screen showing the question and
   * nothing else, with no way to try again. Distinct from `error` below, which
   * is transient feedback about an action the user just took. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The sanitized answer + the notes it was actually built from, held for the
   * save path. Deliberately the sanitized-but-NOT-flattened text: the vault
   * gets real markdown, `segments` gets the display-flattened form. */
  const answerRef = useRef<{ markdown: string; sources: SelectedNote[] } | null>(null);

  // Plain useEffect keyed to an attempt counter, NOT useFocusEffect: re-running
  // on focus would re-ask the model (a paid, slow call) every time the user
  // returns from tapping a citation.
  //
  // The deps below are in fact stable — React Navigation hands back the same
  // `route.params` object across re-renders — so the effect does not re-fire
  // on its own today. The ref is belt-and-braces around that: it makes "ask
  // exactly once per attempt" a property of this file rather than of
  // navigation's identity semantics, which is what a paid, slow, one-shot
  // call wants. Do NOT read it as evidence the deps churn; if they did, the
  // cleanup below would abort the in-flight run while the ref blocked any
  // restart, pinning the screen on "Reading your notes…" with no Retry.
  // Retry bumps `attempt`, which is the only thing that lets the effect body
  // run a second time.
  const [attempt, setAttempt] = useState(0);
  const ranForAttemptRef = useRef(-1);
  useEffect(() => {
    if (ranForAttemptRef.current === attempt) return;
    ranForAttemptRef.current = attempt;

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

        // An empty answer is a failure, not an answer. Arming Save on it would
        // offer to write a blank synthesis note into the vault. Note this is
        // checked AFTER sanitizing: an answer consisting only of neutralized
        // content is empty too.
        if (sanitized.trim() === "") {
          setLoadError(EMPTY_ANSWER);
          setPhase("failed");
          return;
        }

        // The vault copy keeps the model's real markdown; only the DISPLAY copy
        // is flattened. Obsidian renders `## ` and `- ` natively, so saving the
        // flattened form would degrade the note the user keeps.
        answerRef.current = { markdown: sanitized, sources: selected };
        // Normalized before segmentation, not per segment: a segment's text
        // does not necessarily begin at a line start (`See [[A]] ## later`), so
        // a per-segment pass would strip mid-line markers it shouldn't. Here
        // line starts are unambiguous, and the normalizer never touches
        // `[[...]]`, so citations resolve exactly as before.
        setSegments(resolveCitations(normalizeLeadingMarkdown(sanitized), selected));
        setDisclosure(disclosureLine(selected.length, ordered.length));
        setPhase("answered");
      } catch (e: unknown) {
        if (!active) return;
        setLoadError(askErrorMessage(e));
        setPhase("failed");
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, question, candidates]);

  const handleRetry = useCallback(() => {
    setLoadError(null);
    setDisclosure(null);
    setPhase("loading");
    setAttempt((a) => a + 1);
  }, []);

  // Ref guard matches every other async action in this app (#114 pattern): a
  // double-tap must not write two synthesis notes into the vault.
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  /** PERMANENT latch — the answer has been written, so Save must never re-arm.
   * Deliberately separate from `toast` below: when these were one flag, Paper's
   * auto-dismiss re-enabled the button 2.5s after a save, and writeSynthesis
   * collision-resolves rather than overwrites, so the next tap wrote a
   * duplicate note. savingRef only guards CONCURRENT taps, not sequential ones. */
  const [saved, setSaved] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const handleSave = useCallback(async () => {
    const answer = answerRef.current;
    if (savingRef.current || saved || !answer) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const md = buildSynthesisNote(question, answer.markdown, answer.sources, todayLocal());
      // `|| "synthesis"`: slugify keeps only ASCII alphanumerics, so a question
      // written entirely in CJK/Cyrillic/Greek/Arabic — or "???" — slugs to "",
      // and an empty stem makes findCollisionFreeName write a file named ".md":
      // a hidden dotfile, invisible in Obsidian, saved "successfully". Every
      // other slugify call site in this repo pairs it with a fallback stem.
      const { filepath } = await writeSynthesis(slugify(question) || "synthesis", md);
      // The file is on disk from here on, so latch Save closed no matter how
      // indexing goes — re-saving would duplicate the note, not repair it.
      setSaved(true);
      // No writer in writer.ts self-indexes; every call site pairs the two.
      // DELIBERATE DEVIATION: the other call sites fire-and-forget this
      // (`void upsertNoteInIndex(...).catch(() => undefined)`, CaptureScreen.tsx)
      // because there the index is a nicety. Here index visibility IS the
      // acceptance criterion — a swallowed failure leaves the note on disk and
      // absent from Search, which is precisely the "I saved it and it vanished"
      // outcome this pairing exists to prevent. So: await it, and if it fails,
      // still confirm the write but say the note needs a refresh to appear.
      // Please don't "fix" this back to fire-and-forget.
      try {
        await upsertNoteInIndex(filepath, md);
        setToast(SAVED_OK);
      } catch {
        setToast(SAVED_NOT_INDEXED);
      }
    } catch (e: unknown) {
      setError(askErrorMessage(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [question, saved]);

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

        {phase === "failed" && loadError !== null && (
          <View style={styles.failed}>
            <Text variant="bodyMedium">{loadError}</Text>
            <Button mode="outlined" accessibilityLabel="Retry" onPress={handleRetry}>
              Try again
            </Button>
          </View>
        )}

        {phase === "answered" && (
          // Segments render as sibling Text runs inside one paragraph so a
          // citation stays inline with the prose around it. Block-level
          // markdown rendering is deliberately not used: it cannot survive
          // being split across segment boundaries without losing the
          // tappable citations, which are the point of the screen.
          //
          // A citation is a Text with onPress, NOT a Pressable: an inline view
          // nested in RN Text needs measurable dimensions on Android, and
          // hitSlop on such a child isn't reliably honored. Nothing in this
          // repo has proven the nested-Pressable pattern on-device, and jsdom
          // cannot catch the difference — so use the form that is known to work.
          <Text variant="bodyLarge" style={styles.answer}>
            {segments.map((seg, i) =>
              seg.linkUri ? (
                <Text
                  key={i}
                  variant="bodyLarge"
                  accessibilityRole="link"
                  accessibilityLabel={`Open note ${seg.text}`}
                  onPress={() => void openCitation(seg.linkUri!)}
                  style={{ color: theme.colors.primary, textDecorationLine: "underline" }}
                >
                  {seg.text}
                </Text>
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
      <Snackbar
        visible={toast !== null}
        onDismiss={() => setToast(null)}
        // The not-indexed variant asks the user to do something — give it time
        // to be read, per RecentDetailSnackbars' precedent.
        duration={toast === SAVED_NOT_INDEXED ? 7000 : 2500}
      >
        {toast ?? ""}
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
  failed: { gap: spacing.lg, alignItems: "flex-start" },
  disclosure: { fontStyle: "italic" },
  actions: { padding: spacing.lg, minHeight: MIN_TAP_TARGET },
});
