/**
 * Receiver screen for "Share to carnet" intents (Android share sheet).
 *
 * Phase 2: accepts a context note (text + voice) and saves the shared
 * payload to the vault.
 *   - Image share → binary written to Photos/{slug}.{ext} + a markdown
 *     note Photos/{slug}.md that references the image and embeds the
 *     user's context.
 *   - URL / text share → markdown note in Ideas/{slug}.md with the
 *     shared content + context.
 *
 * No OmniRoute vision/enrichment yet — that's phase 3. Raw save first
 * so the offline path is solid before we layer LLM calls on top.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Image, ScrollView, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  HelperText,
  Text,
  TextInput,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useShareIntentContext } from "expo-share-intent";

import type { RootStackParamList } from "../../App";
import { VoiceButton } from "../voice/VoiceButton";
import { recordCapture } from "../lib/storage";
import {
  extFromMime,
  injectImageEmbed,
  slugify,
  updateNote,
  writeBinary,
  writeIdea,
} from "../lib/writer";
import {
  autoTranscribeIfEnabled,
  enrichSharedImage,
  enrichSharedLink,
} from "../lib/dispatcher";
import { sanitizeMarkdown } from "../lib/enrichSanitize";
import {
  assertBase64UnderLimit,
  MAX_SHARED_IMAGE_BYTES,
} from "../lib/llmClient";
import {
  BASE64_EXPANSION,
  MAX_SAFE_SHARE_BYTES,
  readShareFileAsBase64,
  shareFileReadUri,
  sanitizeShareString,
  yamlQuote,
} from "../lib/shareHelpers";
import { caretProps, useCarnetTheme } from "../lib/theme";
import { deriveTitle } from "@carnet/shared";
import { getSettings } from "../lib/settings";
import { resolveActiveProvider, UNKNOWN_PROVIDER_LABEL } from "../lib/llmProviders";
import { captureVaultContext, type VaultContext } from "../lib/vaultContext";
import { resolveContextRoot } from "../lib/vaultRoot";

type Props = NativeStackScreenProps<RootStackParamList, "ShareReceive">;

type Phase = "input" | "saving" | "saved";

/** Captured inputs for a save() pass — kept in state so the saved-phase
 * Re-enrich can re-run the same enrichment without re-reading from the
 * source share intent (which the user may have already cancelled). */
type SaveSource =
  | { kind: "image"; base64: string; mime: string; imageName: string }
  | { kind: "link"; url: string; text: string };

/** YYYYMMDD-HHMMSS local-time stamp used as the slug for shared captures. */
function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Generate non-crypto local id for the recents history. */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function ShareReceiveScreen({ navigation }: Props) {
  const theme = useCarnetTheme();
  const { shareIntent, resetShareIntent } = useShareIntentContext();

  // If the screen OPENS without a shareIntent (deep link mishap), bail.
  // Scoped to the opening state only: cancel()/Done call resetShareIntent()
  // (nulling the context) and then goBack() themselves — without this guard
  // the null re-renders the still-mounted screen and this effect fires a
  // SECOND goBack(), popping past Home (timing-dependent).
  const openedEmpty = useRef(shareIntent == null);
  useEffect(() => {
    if (openedEmpty.current && !shareIntent) {
      navigation.goBack();
    }
  }, [shareIntent, navigation]);

  // Active provider's display label for the "enriching + saving…" label —
  // read once on mount so it never claims a hardcoded provider.
  const [providerLabel, setProviderLabel] = useState(UNKNOWN_PROVIDER_LABEL);
  useEffect(() => {
    void getSettings()
      .then((s) => {
        if (Array.isArray(s.llmProviders) && s.llmProviders.length > 0) {
          setProviderLabel(
            resolveActiveProvider(s.llmProviders, s.activeProviderId).label,
          );
        }
      })
      .catch(() => {});
  }, []);

  const [context, setContext] = useState("");
  const [transcript, setTranscript] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [error, setError] = useState<string | null>(null);
  const [savedFilepath, setSavedFilepath] = useState<string | null>(null);
  /** Honest sub-state shown under the "saving" spinner. Starts at
   * "Fetching link preview…" for URL shares, flips to the enrichment
   * message once the preview promise settles. */
  const [savingDetail, setSavingDetail] = useState<string>(
    `${providerLabel} is enriching + saving…`,
  );
  /** Surfaced as a banner on the saved screen when AI enrichment failed and
   * we fell back to a stub note. Carries the sanitized error message so the
   * user can see auth / model issues they can act on. */
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  /** Guards against fast double-taps on Save. `setPhase("saving")` schedules
   * a re-render but does not block the next event synchronously — a second
   * tap before the unmount can trigger writeBinary+writeIdea twice and land
   * two paired notes for one share. */
  const savingRef = useRef(false);
  /** Snapshot of the inputs used by the most recent enrichment, kept in
   * state so the saved-phase Re-enrich can replay them. */
  const [saveSource, setSaveSource] = useState<SaveSource | null>(null);
  /** Auto-transcribe (Settings → AI behavior toggle) — only fired on the
   * audio branch of save(). Inline indicator on the saved screen. */
  const [autoTranscribing, setAutoTranscribing] = useState(false);
  const [autoTranscribeError, setAutoTranscribeError] = useState<string | null>(
    null,
  );
  // Mounted guard — user can tap Done before the fire-and-forget
  // transcription finishes. The disk write still completes; only the
  // setStates are skipped to avoid React's unmount warning.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Combined text from typed context + accepted voice transcript. */
  const combinedContext = useMemo(() => {
    const parts = [context, transcript].map((s) => s.trim()).filter(Boolean);
    return parts.join("\n\n");
  }, [context, transcript]);

  const cancel = () => {
    resetShareIntent();
    navigation.goBack();
  };

  const save = async () => {
    if (!shareIntent) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setError(null);
    setDegradedReason(null);
    setSavingDetail(`${providerLabel} is enriching + saving…`);
    setPhase("saving");
    // A share may take several awaits to read, enrich and write. Keep its
    // binary and note pair in the vault selected when Save was tapped.
    let vaultContext: VaultContext | undefined;
    try {
      vaultContext = captureVaultContext(await getSettings());
    } catch {
      // The individual writer fallbacks preserve the existing recoverable
      // behavior when settings storage is unavailable.
    }
    const root = vaultContext ? resolveContextRoot(vaultContext) : undefined;
    // Tracked across the branch to gate auto-transcribe — only fires on
    // the audio branch, not on image / link / other-file shares.
    let wasAudioBranch = false;
    try {
      const slugFallback = timestampSlug();
      const files = shareIntent.files ?? [];
      const text = shareIntent.text ?? "";
      const url = shareIntent.webUrl ?? "";
      const ctx = combinedContext;

      const imageFile = files.find((f) => f.mimeType?.startsWith("image/"));
      const audioFile = files.find((f) => f.mimeType?.startsWith("audio/"));
      // Generic-file: anything carrying bytes that isn't image or audio.
      // Falsy mimeType also lands here so shares that arrive without a
      // declared type still get persisted (ext falls back to "bin").
      const otherFile = files.find(
        (f) => !f.mimeType?.startsWith("image/") && !f.mimeType?.startsWith("audio/"),
      );

      let filepath: string;
      let title: string;
      const mode: "idea" = "idea";

      if (imageFile) {
        // Cap up-front: vision models reject large payloads and the in-memory
        // peak (base64 + JSON-encoded data URL) can OOM the phone.
        if (imageFile.size && imageFile.size > MAX_SHARED_IMAGE_BYTES) {
          const mb = Math.round(imageFile.size / 1024 / 1024);
          throw new Error(
            `Image is ${mb} MB — carnet caps shares at ${Math.round(MAX_SHARED_IMAGE_BYTES / 1024 / 1024)} MB. Downscale or crop before sharing.`,
          );
        }
        const mime = imageFile.mimeType ?? "image/jpeg";

        // shareFileReadUri prefers the OS-granted content:// handle (the raw
        // file path may be unreadable under scoped storage);
        // readShareFileAsBase64 picks SAF vs the legacy FileSystem API based
        // on the scheme.
        const base64 = await readShareFileAsBase64(shareFileReadUri(imageFile));
        // Belt-and-suspenders: some content:// providers don't populate
        // `imageFile.size`, so the early check above is skipped. Recheck
        // against the actual decoded byte count before sending to the
        // vision model.
        assertBase64UnderLimit(base64);

        // Vision enrichment. If it fails (auth, missing key, wrong model,
        // offline), surface the reason via a degraded-banner on the saved
        // screen — still save a stub so the share isn't dropped, but never
        // silently.
        let enrichedMd: string;
        try {
          const result = await enrichSharedImage({ base64, mimeType: mime, context: ctx });
          enrichedMd = result.markdown;
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn("[ShareReceive] vision enrichment failed:", reason);
          setDegradedReason(reason);
          // sanitizeMarkdown runs on the LLM path inside executeChat; this
          // degraded stub skips the LLM, so it must sanitize here — the vault
          // is a Dataview/Templater execution surface (see enrichSanitize.ts).
          enrichedMd = sanitizeMarkdown(
            `---\ncreated: ${new Date().toISOString()}\nkind: shared-image\ntags: [shared, image]\n---\n# Shared image ${slugFallback}\n\n## What's in this\n(Vision enrichment unavailable — see image.)\n\n## Context\n${ctx || "(none provided)"}`,
          );
        }

        title = deriveTitle(enrichedMd) || `Shared image ${slugFallback}`;
        const desiredSlug = slugify(title) || `shared-image-${slugFallback}`;

        const ext = extFromMime(mime);
        const { finalName } = await writeBinary("Photos", `${desiredSlug}.${ext}`, base64, mime, root);

        // Share the collision-bumped stem so .jpg and .md stay paired. If
        // writeBinary returned `foo-3.jpg`, the .md is forced to start from
        // `foo-3` (Ideas/ may still collide independently and bump further,
        // but the link to the photo is preserved correctly).
        const sharedStem = finalName.replace(/\.[^.]+$/, "");
        const withImage = injectImageEmbed(enrichedMd, `../Photos/${finalName}`);
        const { filepath: mdPath } = await writeIdea(sharedStem, withImage, root);
        filepath = mdPath;
        setSaveSource({ kind: "image", base64, mime, imageName: finalName });
      } else if (audioFile) {
        // Audio share: persist the binary + a deterministic stub note. No LLM
        // enrichment — keeps latency low and avoids sending audio bytes to a
        // vision-only model. Transcription is the planned v0.3 follow-up.
        //
        // mime + fileName come from a third-party app via the share intent.
        // sanitize once at the top so every downstream interpolation (H1,
        // link text, YAML frontmatter, recordCapture title) sees safe values.
        const mime = sanitizeShareString(audioFile.mimeType ?? "application/octet-stream");
        const fileName = sanitizeShareString(audioFile.fileName ?? `audio-${slugFallback}`);

        // Pre-check known size. base64 read + writeBinary serialization can
        // peak above 3× file size in JS heap, enough to OOM-kill the process
        // on a 4GB phone with no error surfaced. Hard-throw above the cap
        // with a user-actionable message.
        if (typeof audioFile.size === "number" && audioFile.size > MAX_SAFE_SHARE_BYTES) {
          const mb = Math.round(audioFile.size / 1024 / 1024);
          const capMb = MAX_SAFE_SHARE_BYTES / 1024 / 1024;
          throw new Error(
            `File is ${mb} MB — carnet caps shares at ${capMb} MB to avoid running out of memory. Save the file locally and link to it instead.`,
          );
        }

        const base64 = await readShareFileAsBase64(shareFileReadUri(audioFile));
        // Belt-and-suspenders: some content:// providers don't populate
        // audioFile.size, so the early check above is skipped. Recheck
        // against the decoded byte count expressed via base64 inflation.
        if (base64.length > MAX_SAFE_SHARE_BYTES * BASE64_EXPANSION) {
          const capMb = MAX_SAFE_SHARE_BYTES / 1024 / 1024;
          throw new Error(
            `File exceeds the ${capMb} MB share cap (size only known after reading). Save locally and link instead.`,
          );
        }

        const ext = extFromMime(mime);
        const baseName = fileName.replace(/\.[^.]+$/, "");
        const desiredSlug = slugify(baseName) || `shared-audio-${slugFallback}`;
        const { finalName } = await writeBinary("Audio", `${desiredSlug}.${ext}`, base64, mime, root);
        const sharedStem = finalName.replace(/\.[^.]+$/, "");

        title = `Shared audio: ${fileName}`;
        // size=0 is a real value (empty file), not unknown — strict typeof
        // check distinguishes it from undefined.
        const sizeStr =
          typeof audioFile.size === "number" ? String(audioFile.size) : "unknown";
        const mdNote =
          `---\n` +
          `created: ${new Date().toISOString()}\n` +
          `kind: shared-audio\n` +
          `source: ${yamlQuote(fileName)}\n` +
          `mime: ${yamlQuote(mime)}\n` +
          `size: ${sizeStr}\n` +
          `tags: [shared, audio]\n` +
          `---\n` +
          `# Shared audio: ${fileName}\n\n` +
          `## File\n[${fileName}](../Audio/${finalName})\n\n` +
          `## Context\n${ctx || "(none provided)"}\n`;

        // No LLM on this branch, so the executeChat sanitizer never runs —
        // fileName comes from an arbitrary sharing app and reaches the H1 and
        // link text (sanitizeShareString only strips CR/LF; a Templater
        // `<%…%>` filename would execute in Obsidian). The link TARGET
        // (finalName) is slugified, so pairing survives sanitization.
        const { filepath: mdPath } = await writeIdea(
          sharedStem,
          sanitizeMarkdown(mdNote),
          root,
        );
        filepath = mdPath;
        wasAudioBranch = true;
      } else if (otherFile) {
        // Generic-file share: PDFs, docs, archives, anything that isn't an
        // image or audio file. Same shape as the audio branch — see comments
        // there for the sanitization, size-cap, and YAML-quoting rationale.
        const mime = sanitizeShareString(otherFile.mimeType ?? "application/octet-stream");
        const fileName = sanitizeShareString(otherFile.fileName ?? `file-${slugFallback}`);

        if (typeof otherFile.size === "number" && otherFile.size > MAX_SAFE_SHARE_BYTES) {
          const mb = Math.round(otherFile.size / 1024 / 1024);
          const capMb = MAX_SAFE_SHARE_BYTES / 1024 / 1024;
          throw new Error(
            `File is ${mb} MB — carnet caps shares at ${capMb} MB to avoid running out of memory. Save the file locally and link to it instead.`,
          );
        }

        const base64 = await readShareFileAsBase64(shareFileReadUri(otherFile));
        if (base64.length > MAX_SAFE_SHARE_BYTES * BASE64_EXPANSION) {
          const capMb = MAX_SAFE_SHARE_BYTES / 1024 / 1024;
          throw new Error(
            `File exceeds the ${capMb} MB share cap (size only known after reading). Save locally and link instead.`,
          );
        }

        const ext = extFromMime(mime);
        const baseName = fileName.replace(/\.[^.]+$/, "");
        const desiredSlug = slugify(baseName) || `shared-file-${slugFallback}`;
        const { finalName } = await writeBinary("Files", `${desiredSlug}.${ext}`, base64, mime, root);
        const sharedStem = finalName.replace(/\.[^.]+$/, "");

        title = `Shared file: ${fileName}`;
        const sizeStr =
          typeof otherFile.size === "number" ? String(otherFile.size) : "unknown";
        const mdNote =
          `---\n` +
          `created: ${new Date().toISOString()}\n` +
          `kind: shared-file\n` +
          `source: ${yamlQuote(fileName)}\n` +
          `mime: ${yamlQuote(mime)}\n` +
          `size: ${sizeStr}\n` +
          `tags: [shared, file]\n` +
          `---\n` +
          `# Shared file: ${fileName}\n\n` +
          `## File\n[${fileName}](../Files/${finalName})\n\n` +
          `## Context\n${ctx || "(none provided)"}\n`;

        // Same rule as the audio branch: non-LLM body with an untrusted
        // filename in H1/link text — sanitize before it reaches the vault.
        const { filepath: mdPath } = await writeIdea(
          sharedStem,
          sanitizeMarkdown(mdNote),
          root,
        );
        filepath = mdPath;
      } else if (url || text) {
        // URL/text share: text-only enrichment.
        let enrichedMd: string;
        try {
          // Honest spinner copy: previews can take up to 8s on slow
          // networks. Once the preview settles, flip the message so
          // the user knows the slower model call is now in flight.
          if (url) {
            setSavingDetail("Fetching link preview…");
          }
          const result = await enrichSharedLink({
            url,
            text,
            context: ctx,
            onPreviewSettled: () =>
              setSavingDetail(`${providerLabel} is enriching + saving…`),
          });
          enrichedMd = result.markdown;
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn("[ShareReceive] link enrichment failed:", reason);
          setDegradedReason(reason);
          const head = url ? "Shared link" : "Shared text";
          // Degraded stub bypasses the LLM (where sanitizeMarkdown normally
          // runs) and interpolates ATTACKER-CONTROLLED share text into the
          // body — sanitize here or a shared dataviewjs/Templater payload
          // lands in the vault verbatim and executes in Obsidian.
          enrichedMd = sanitizeMarkdown(
            `---\ncreated: ${new Date().toISOString()}\nkind: ${url ? "shared-link" : "shared-text"}\ntags: [shared]\n---\n# ${head} ${slugFallback}\n\n${url ? `## Source\n<${url}>\n\n` : ""}${text && text !== url ? `## Excerpt\n${text}\n\n` : ""}## Context\n${ctx || "(none provided)"}`,
          );
        }

        title = deriveTitle(enrichedMd) || (url ? `Shared link ${slugFallback}` : `Shared text ${slugFallback}`);
        const slug = slugify(title) || `shared-${slugFallback}`;
        const { filepath: mdPath } = await writeIdea(slug, enrichedMd, root);
        filepath = mdPath;
        setSaveSource({ kind: "link", url, text });
      } else {
        throw new Error("Nothing to save — empty share payload");
      }

      // Recents history is best-effort. If AsyncStorage fails after the
      // files are already on disk, surface a console warning but still
      // transition to "saved" — retrying would re-write the binary +
      // markdown as a duplicate (collision-bumped to slug-2.jpg/.md).
      try {
        await recordCapture(
          {
            id: localId(),
            mode,
            title,
            filepath,
            createdAt: Date.now(),
          },
          vaultContext?.profileId,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[ShareReceive] recordCapture failed (files saved):", msg);
      }
      setSavedFilepath(filepath);
      setPhase("saved");

      // Fire-and-forget auto-transcribe — audio branch only. No-ops when
      // the toggle is off; helper never throws by contract.
      if (wasAudioBranch) {
        const transcribePath = filepath;
        setAutoTranscribing(true);
        setAutoTranscribeError(null);
        void autoTranscribeIfEnabled(transcribePath).then((errMsg) => {
          if (!mountedRef.current) return;
          setAutoTranscribing(false);
          if (errMsg) setAutoTranscribeError(errMsg);
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[ShareReceive] save failed:", msg, e);
      setError(msg);
      setPhase("input");
    } finally {
      savingRef.current = false;
    }
  };

  /** Re-run enrichment after a stub-fallback save. Overwrites the saved
   * .md in place via updateNote; the .jpg on disk is untouched. Mirrors
   * PhotoCaptureScreen's reEnrichSaved — useful when the first enrichment
   * failed because the LLM endpoint was unreachable (e.g. VPN dropped). */
  const reEnrichSaved = async (): Promise<void> => {
    if (!saveSource || !savedFilepath) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setError(null);
    setPhase("saving");
    try {
      const ctx = combinedContext;
      let newMd: string;
      if (saveSource.kind === "image") {
        const result = await enrichSharedImage({
          base64: saveSource.base64,
          mimeType: saveSource.mime,
          context: ctx,
        });
        newMd = injectImageEmbed(
          result.markdown,
          `../Photos/${saveSource.imageName}`,
        );
      } else {
        const result = await enrichSharedLink({
          url: saveSource.url,
          text: saveSource.text,
          context: ctx,
        });
        newMd = result.markdown;
      }
      await updateNote(savedFilepath, newMd);
      setDegradedReason(null);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[ShareReceive] re-enrich failed:", reason);
      setDegradedReason(reason);
    } finally {
      savingRef.current = false;
      setPhase("saved");
    }
  };

  if (!shareIntent) return null;

  const files = shareIntent.files ?? [];
  const text = shareIntent.text ?? "";
  const url = shareIntent.webUrl ?? "";

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card style={styles.card}>
        <Card.Title title="Shared with carnet" />
        <Card.Content>
          {url ? (
            <View style={styles.section}>
              <Text variant="labelMedium">URL</Text>
              <Text selectable style={styles.body}>{url}</Text>
            </View>
          ) : null}

          {text && text !== url ? (
            <View style={styles.section}>
              <Text variant="labelMedium">Text</Text>
              <Text selectable style={styles.body}>{text}</Text>
            </View>
          ) : null}

          {files.length > 0 ? (
            <View style={styles.section}>
              <Text variant="labelMedium">Files ({files.length})</Text>
              {files.map((f, i) => (
                <View key={`${f.path}-${i}`} style={styles.fileRow}>
                  {f.mimeType?.startsWith("image/") ? (
                    <Image source={{ uri: f.path }} style={styles.thumb} />
                  ) : null}
                  <View style={styles.fileMeta}>
                    <Text variant="bodySmall">{f.fileName ?? f.path}</Text>
                    <Text variant="bodySmall" style={styles.dim}>
                      {f.mimeType ?? "?"} • {f.size ? `${Math.round(f.size / 1024)} KB` : "?"}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </Card.Content>
      </Card>

      <Card style={styles.card}>
        <Card.Title title="Add context" subtitle="Optional — what is this about?" />
        <Card.Content style={styles.section}>
          <View style={styles.voiceRow}>
            <VoiceButton
              onTranscript={(t, isFinal) => {
                if (isFinal) {
                  setTranscript((prev) => (prev ? `${prev}\n${t}`.trim() : t));
                }
              }}
            />
            <Text variant="bodySmall" style={styles.voiceHint}>
              Tap to dictate
            </Text>
          </View>
          {transcript ? (
            <TextInput
              {...caretProps(theme)}
              label="Transcript"
              mode="outlined"
              multiline
              numberOfLines={3}
              value={transcript}
              onChangeText={setTranscript}
            />
          ) : null}
          <TextInput
            {...caretProps(theme)}
            label="Notes"
            mode="outlined"
            multiline
            numberOfLines={4}
            value={context}
            onChangeText={setContext}
            placeholder="Type any extra context here"
          />
        </Card.Content>
      </Card>

      {phase === "saving" ? (
        <View style={styles.loading}>
          <ActivityIndicator />
          <Text variant="bodyMedium" style={styles.dim}>
            {savingDetail}
          </Text>
        </View>
      ) : phase === "saved" ? (
        <Card style={styles.card}>
          <Card.Title title="Saved to vault" />
          <Card.Content>
            {degradedReason ? (
              <Banner visible icon="alert" actions={[]} style={styles.degradedBanner}>
                {`AI enrichment failed — saved as a stub note. ${degradedReason}`}
              </Banner>
            ) : null}
            <Text variant="bodySmall" selectable style={styles.body}>
              {savedFilepath ?? "(no path)"}
            </Text>
            {autoTranscribing ? (
              <View style={styles.transcribeRow}>
                <ActivityIndicator size="small" />
                <Text variant="bodySmall" style={styles.dim}>
                  Transcribing audio…
                </Text>
              </View>
            ) : autoTranscribeError ? (
              <HelperText type="error" visible>
                {`Auto-transcribe failed: ${autoTranscribeError}`}
              </HelperText>
            ) : (
              <HelperText type="info" visible>
                Open Obsidian (or your editor) on the synced folder to read
                and edit. Carnet is intake-only.
              </HelperText>
            )}
          </Card.Content>
          <Card.Actions>
            {degradedReason ? (
              <Button mode="text" onPress={reEnrichSaved}>
                Re-enrich
              </Button>
            ) : null}
            <Button
              mode="contained"
              onPress={() => {
                resetShareIntent();
                navigation.goBack();
              }}
            >
              Done
            </Button>
          </Card.Actions>
        </Card>
      ) : (
        <View style={styles.actions}>
          <Button mode="text" onPress={cancel}>
            Cancel
          </Button>
          <Button mode="contained" onPress={save}>
            Save to vault
          </Button>
        </View>
      )}

      {error ? (
        <HelperText type="error" visible style={styles.errMsg}>
          {error}
        </HelperText>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { marginTop: 4 },
  section: { marginTop: 12, gap: 8 },
  body: { fontSize: 14, lineHeight: 20 },
  dim: { opacity: 0.6 },
  fileRow: { flexDirection: "row", gap: 12, alignItems: "center", marginTop: 8 },
  thumb: { width: 64, height: 64, borderRadius: 6, backgroundColor: "#0001" },
  fileMeta: { flex: 1, gap: 2 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  voiceHint: { opacity: 0.7 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  loading: { paddingVertical: 32, alignItems: "center", gap: 8 },
  errMsg: { textAlign: "center" },
  degradedBanner: { marginBottom: 8 },
  transcribeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 8,
  },
});
