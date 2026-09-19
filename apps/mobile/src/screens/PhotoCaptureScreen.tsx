/**
 * In-app photo capture mode for carnet.
 *
 * Mirrors ShareReceiveScreen's enrich + paired-stem write pipeline, but the
 * image comes from expo-camera instead of a share intent. Phase machine:
 *   input      — camera live OR (after Capture) thumbnail + context inputs
 *   submitting — vision call in flight
 *   preview    — generated markdown shown; user can Save or Retake
 *   saved      — Photos/*.jpg + Ideas/*.md written; degraded banner on fallback
 *
 * The vision pipeline (enrichSharedImage), binary writer (writeBinary), and
 * markdown writer (writeIdea) are shared with the share-target path so any
 * future change benefits both entry points.
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
import { CameraView, useCameraPermissions } from "expo-camera";

import type { RootStackParamList } from "../../App";
import { VoiceButton } from "../voice/VoiceButton";
import { recordCapture } from "../lib/storage";
import {
  injectImageEmbed,
  slugify,
  updateNote,
  writeBinary,
  writeIdea,
} from "../lib/writer";
import { enrichSharedImage } from "../lib/dispatcher";
import { assertBase64UnderLimit } from "../lib/llmClient";
import { caretProps, useCarnetTheme } from "../lib/theme";
import { deriveTitle } from "@carnet/shared";
import { getSettings } from "../lib/settings";
import { captureVaultContext, type VaultContext } from "../lib/vaultContext";
import { resolveActiveProvider, UNKNOWN_PROVIDER_LABEL } from "../lib/llmProviders";
import { captureVaultSnapshot } from "../lib/captureVaultSnapshot";

type Props = NativeStackScreenProps<RootStackParamList, "PhotoCapture">;

type Phase = "input" | "submitting" | "preview" | "saved";

/** YYYYMMDD-HHMMSS local-time stamp used as the slug fallback. */
function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Non-crypto local id for recents history. */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function PhotoCaptureScreen({ navigation }: Props) {
  const theme = useCarnetTheme();
  const cameraRef = useRef<CameraView>(null);
  /** Guards against fast double-taps on Save. `setPhase("submitting")`
   * schedules a re-render but does not block the next event synchronously —
   * a second tap before unmount would re-fire writeBinary+writeIdea and
   * land two paired notes for one photo. */
  const savingRef = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();

  const [phase, setPhase] = useState<Phase>("input");
  const [base64, setBase64] = useState<string | null>(null);
  const [thumbUri, setThumbUri] = useState<string | null>(null);
  const [context, setContext] = useState("");
  const [transcript, setTranscript] = useState("");
  const [enrichedMd, setEnrichedMd] = useState<string>("");
  const [savedFilepath, setSavedFilepath] = useState<string | null>(null);
  /** Image filename in the Photos/ subdir at the time of save. Kept so the
   * saved-phase Re-enrich can rebuild the correct `../Photos/{name}` embed
   * — the .md may have been collision-bumped independently of the .jpg. */
  const [savedImageName, setSavedImageName] = useState<string | null>(null);
  /** Frozen at Send so a profile switch during vision enrichment cannot make
   * another vault's cached tag vocabulary part of this capture's prompt. */
  const [enrichmentVaultContext, setEnrichmentVaultContext] = useState<VaultContext | undefined>();
  /** Surfaced as a banner on the saved screen when AI enrichment failed and
   * we fell back to a stub note. */
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Active provider's display label for the "structuring the photo…" label
  // — read once on mount so it never claims a hardcoded provider.
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

  const combinedContext = useMemo(() => {
    const parts = [context, transcript].map((s) => s.trim()).filter(Boolean);
    return parts.join("\n\n");
  }, [context, transcript]);

  const grant = async (): Promise<void> => {
    try {
      const result = await requestPermission();
      if (!result.granted) {
        setError("Camera permission denied");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Permission request failed: ${msg}`);
    }
  };

  const capture = async (): Promise<void> => {
    if (!cameraRef.current) {
      setError("Camera not ready — try again in a moment");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.6,
      });
      // Guard against undefined when the user backgrounds the app mid-shoot.
      if (!photo?.base64) {
        throw new Error("No image captured");
      }
      // `quality: 0.6` controls JPEG compression but NOT resolution — a 50 MP
      // sensor can still bust the vision-model byte cap. Gate explicitly.
      assertBase64UnderLimit(photo.base64);
      setBase64(photo.base64);
      setThumbUri(photo.uri ?? null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Return to the input phase keeping the captured photo, so the user can
   * tweak context and resend after a stub-fallback enrichment. */
  const reEnrich = (): void => {
    setEnrichedMd("");
    setDegradedReason(null);
    setError(null);
    setPhase("input");
  };

  const retake = (): void => {
    setBase64(null);
    setThumbUri(null);
    setEnrichedMd("");
    setDegradedReason(null);
    setError(null);
    setEnrichmentVaultContext(undefined);
    setPhase("input");
  };

  const send = async (): Promise<void> => {
    if (!base64) return;
    setError(null);
    setDegradedReason(null);
    setPhase("submitting");
    const slugFallback = timestampSlug();
    const ctx = combinedContext;
    let vaultContext: VaultContext | undefined;
    try {
      vaultContext = captureVaultContext(await getSettings());
      setEnrichmentVaultContext(vaultContext);
    } catch {
      // Enrichment stays available when settings are transiently unreadable;
      // dispatcher falls back to its ordinary active-cache lookup.
    }
    try {
      const result = await enrichSharedImage(
        { base64, mimeType: "image/jpeg", context: ctx },
        { vaultContext },
      );
      setEnrichedMd(result.markdown);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      setDegradedReason(reason);
      setEnrichedMd(
        `---\ncreated: ${new Date().toISOString()}\nkind: photo\ntags: [photo]\n---\n# Photo ${slugFallback}\n\n## What's in this\n(Vision enrichment unavailable — see image.)\n\n## Context\n${ctx || "(none provided)"}`,
      );
    }
    setPhase("preview");
  };

  const save = async (): Promise<void> => {
    if (!base64 || !enrichedMd) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setError(null);
    setPhase("submitting");
    try {
      const vault = await captureVaultSnapshot();
      const root = vault?.root;
      const slugFallback = timestampSlug();
      const title = deriveTitle(enrichedMd) || `Photo ${slugFallback}`;
      const desiredSlug = slugify(title) || `photo-${slugFallback}`;

      const { finalName } = await writeBinary(
        "Photos",
        `${desiredSlug}.jpg`,
        base64,
        "image/jpeg",
        root,
      );

      // Share the collision-bumped stem so .jpg and .md stay paired.
      const sharedStem = finalName.replace(/\.[^.]+$/, "");
      const withImage = injectImageEmbed(enrichedMd, `../Photos/${finalName}`);
      const { filepath } = await writeIdea(sharedStem, withImage, root);

      // Recents history is best-effort. If AsyncStorage fails after the
      // files are already on disk, surface a console warning but still
      // transition to "saved" — retrying would write `slug-2.jpg` +
      // `slug-2.md` as duplicates.
      try {
        await recordCapture(
          { id: localId(), mode: "photo", title, filepath, createdAt: Date.now() },
          vault?.context.profileId,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[PhotoCapture] recordCapture failed (files saved):", msg);
      }
      setSavedFilepath(filepath);
      setSavedImageName(finalName);
      setPhase("saved");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase("preview");
    } finally {
      savingRef.current = false;
    }
  };

  /** Re-run vision enrichment after a stub-fallback save. Overwrites the
   * existing .md in place via updateNote; the .jpg on disk is untouched.
   * Useful when the first enrichment failed because the LLM endpoint was
   * unreachable (e.g. VPN dropped) and the user has since fixed it. */
  const reEnrichSaved = async (): Promise<void> => {
    if (!base64 || !savedFilepath || !savedImageName) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setError(null);
    setPhase("submitting");
    try {
      const result = await enrichSharedImage(
        { base64, mimeType: "image/jpeg", context: combinedContext },
        { vaultContext: enrichmentVaultContext },
      );
      const withImage = injectImageEmbed(
        result.markdown,
        `../Photos/${savedImageName}`,
      );
      await updateNote(savedFilepath, withImage);
      setEnrichedMd(withImage);
      setDegradedReason(null);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      setDegradedReason(reason);
    } finally {
      savingRef.current = false;
      setPhase("saved");
    }
  };

  // ── Render branches ────────────────────────────────────────────────────────

  if (!permission) {
    return (
      <View style={styles.permissionGate}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionGate}>
        <Text variant="bodyMedium" style={styles.permissionText}>
          Camera permission required to capture photos.
        </Text>
        <Button mode="contained" onPress={grant} style={styles.grantBtn}>
          Allow camera
        </Button>
        {error ? (
          <HelperText type="error" visible>
            {error}
          </HelperText>
        ) : null}
      </View>
    );
  }

  if (phase === "submitting") {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" />
        <Text variant="bodyMedium" style={styles.dim}>
          {providerLabel} is structuring the photo…
        </Text>
      </View>
    );
  }

  if (phase === "saved") {
    return (
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card style={styles.card}>
          <Card.Title title="Saved to vault" />
          <Card.Content>
            {degradedReason ? (
              <Banner
                visible
                icon="alert"
                actions={[]}
                style={styles.degradedBanner}
              >
                {`AI enrichment failed — saved as a stub note. ${degradedReason}`}
              </Banner>
            ) : null}
            <Text variant="bodySmall" selectable style={styles.body}>
              {savedFilepath ?? "(no path)"}
            </Text>
            <HelperText type="info" visible>
              Open Obsidian (or your editor) on the synced folder to read and
              edit. Carnet is intake-only.
            </HelperText>
          </Card.Content>
          <Card.Actions>
            {degradedReason ? (
              <Button mode="text" onPress={reEnrichSaved}>
                Re-enrich
              </Button>
            ) : null}
            <Button mode="contained" onPress={() => navigation.goBack()}>
              Done
            </Button>
          </Card.Actions>
        </Card>
      </ScrollView>
    );
  }

  if (phase === "preview") {
    return (
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card style={styles.card}>
          <Card.Title title="Preview" subtitle="Review before saving" />
          <Card.Content>
            {degradedReason ? (
              <Banner
                visible
                icon="alert"
                actions={[]}
                style={styles.degradedBanner}
              >
                {`AI enrichment failed — saving as a stub. ${degradedReason}`}
              </Banner>
            ) : null}
            {thumbUri ? (
              <Image source={{ uri: thumbUri }} style={styles.previewImage} />
            ) : null}
            <Text selectable style={styles.previewMarkdown}>
              {enrichedMd}
            </Text>
          </Card.Content>
          <Card.Actions>
            <Button mode="text" onPress={retake}>
              Retake
            </Button>
            <Button mode="text" onPress={reEnrich}>
              Re-enrich
            </Button>
            <Button mode="contained" onPress={save}>
              Save
            </Button>
          </Card.Actions>
          {error ? (
            <Card.Content>
              <HelperText type="error" visible>
                {error}
              </HelperText>
            </Card.Content>
          ) : null}
        </Card>
      </ScrollView>
    );
  }

  // phase === "input"
  if (base64 && thumbUri) {
    // Capture done — show thumbnail + context inputs + Retake / Send.
    return (
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card style={styles.card}>
          <Card.Title title="Captured" subtitle="Add context, then send" />
          <Card.Content>
            <Image source={{ uri: thumbUri }} style={styles.previewImage} />
          </Card.Content>
        </Card>

        <Card style={styles.card}>
          <Card.Title
            title="Add context"
            subtitle="Optional — what is this about?"
          />
          <Card.Content style={styles.section}>
            <View style={styles.voiceRow}>
              <VoiceButton
                onTranscript={(t, isFinal) => {
                  if (isFinal) {
                    setTranscript((prev) =>
                      prev ? `${prev}\n${t}`.trim() : t,
                    );
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

        <View style={styles.actions}>
          <Button mode="text" onPress={retake}>
            Retake
          </Button>
          <Button mode="contained" onPress={send}>
            Send
          </Button>
        </View>
        {error ? (
          <HelperText type="error" visible style={styles.errMsg}>
            {error}
          </HelperText>
        ) : null}
      </ScrollView>
    );
  }

  // Camera live view.
  return (
    <View style={styles.cameraWrap}>
      <CameraView ref={cameraRef} style={styles.camera} facing="back" />
      <View style={styles.cameraActions}>
        <Button
          mode="contained"
          icon="camera"
          onPress={capture}
          loading={busy}
          disabled={busy}
        >
          Capture
        </Button>
        {error ? (
          <HelperText type="error" visible>
            {error}
          </HelperText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  card: { marginTop: 4 },
  section: { marginTop: 12, gap: 8 },
  body: { fontSize: 14, lineHeight: 20 },
  dim: { opacity: 0.6 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  voiceHint: { opacity: 0.7 },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 8,
  },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  errMsg: { textAlign: "center" },
  degradedBanner: { marginBottom: 8 },
  permissionGate: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  permissionText: { textAlign: "center" },
  grantBtn: { marginTop: 8 },
  cameraWrap: { flex: 1, backgroundColor: "black" },
  camera: { flex: 1 },
  cameraActions: { padding: 16, gap: 8, backgroundColor: "black" },
  previewImage: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: 8,
    backgroundColor: "#0001",
    marginTop: 8,
  },
  previewMarkdown: { fontSize: 13, lineHeight: 20, marginTop: 12 },
});
