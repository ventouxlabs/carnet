/**
 * Native audio recording capture mode.
 *
 * Mirrors ShareReceiveScreen's audio branch for the save pipeline (writeBinary
 * to Audio/, writeIdea stub with kind: shared-audio so downstream code —
 * RecentDetail render, moveToArchive paired-binary detection, future
 * transcription — handles audio captures and audio shares identically).
 * The recording lifecycle (perm → setAudioMode → Recording.createAsync →
 * stopAndUnloadAsync → getURI) uses expo-av's Recording API.
 *
 * Phase machine:
 *   idle      — permission gate; tap-to-record button
 *   recording — mic active; live timer; pulsing red dot; Stop & save / Cancel
 *   saving    — base64 read + writeBinary + writeIdea + recordCapture in flight
 *   saved     — file path shown; Done returns to Home
 *
 * No transcription this PR — planned follow-up. The stub markdown reuses the
 * shared-audio kind so the transcription PR can extend both entry points
 * (share + capture) at once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Linking, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  HelperText,
  IconButton,
  Text,
  useTheme,
} from "react-native-paper";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";

import type { RootStackParamList } from "../../App";
import { recordCapture } from "../lib/storage";
import { writeBinary, writeIdea } from "../lib/writer";
import { autoTranscribeIfEnabled } from "../lib/dispatcher";
import {
  BASE64_EXPANSION,
  formatElapsed,
  MAX_SAFE_SHARE_BYTES,
  yamlQuote,
} from "../lib/shareHelpers";
import { isSttModelMissingMessage } from "../voice/sttOnboarding";
import { triggerVoiceModelDownload } from "../voice/sttReadiness";
import { captureVaultSnapshot } from "../lib/captureVaultSnapshot";
import type { Root } from "../lib/vaultRoot";

// The recognizer package Speech Services by Google installs and downloads
// its voice models through — same target VoiceButton's Play Store fallback
// uses, so both dead-ends land the user in the same place.
const SPEECH_SERVICES_PKG = "com.google.android.tts";

type Props = NativeStackScreenProps<RootStackParamList, "AudioCapture">;

type Phase = "idle" | "recording" | "saving" | "saved";

/** YYYYMMDD-HHMMSS local-time stamp used as the slug for audio captures. */
function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Non-crypto local id for the recents history. */
function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function AudioCaptureScreen({ navigation }: Props) {
  const theme = useTheme();
  /** Underlying expo-av recording. Set during createAsync, cleared after
   * stopAndUnloadAsync — calling stop twice on the same instance throws
   * "Recording already unloaded" on Android. */
  const recordingRef = useRef<Audio.Recording | null>(null);
  /** URI of the in-flight recording's cache file. Kept so the unmount cleanup
   * can delete it if the user navigates away mid-recording. */
  const cacheUriRef = useRef<string | null>(null);
  /** Wall-clock start of current recording. Timer derives elapsed from the
   * delta so setInterval drift doesn't accumulate over a long recording. */
  const startedAtRef = useRef<number | null>(null);
  /** Pulse animation handle so it can be stopped on unmount / phase change. */
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);
  /** Guards startRecording against fast double-taps — the awaited
   * createAsync resolves after enough time for a second tap to land. */
  const startingRef = useRef(false);
  /** Same guard for stopAndSave / cancel. */
  const savingRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [savedFilepath, setSavedFilepath] = useState<string | null>(null);
  // Retained for a manual retry after the profile may have changed. The
  // filepath alone cannot identify which vault owns a same-named Audio file.
  const [savedRoot, setSavedRoot] = useState<Root | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  // Auto-transcribe (Settings → AI behavior toggle). The hook is
  // fire-and-forget after the saved screen appears; these surface its
  // in-flight + error state inline below the path.
  const [autoTranscribing, setAutoTranscribing] = useState(false);
  const [autoTranscribeError, setAutoTranscribeError] = useState<string | null>(
    null,
  );
  // In flight while the in-app on-device voice-model download is running
  // (the same trigger VoiceButton's error sheet uses), so the "Download
  // model" button can disable + show progress instead of double-firing.
  const [downloadingModel, setDownloadingModel] = useState(false);

  /** Pulse opacity for the REC indicator. opacity is compositor-friendly with
   * useNativeDriver, so a long recording won't drop frames on low-end phones. */
  const pulse = useRef(new Animated.Value(1)).current;

  // Mounted guard — the user can tap Done before the fire-and-forget
  // transcription finishes; without this, setAutoTranscribing(false) on
  // an unmounted screen triggers a React warning. The write to disk
  // (upsertSection + updateNote inside the helper) still completes.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Discard any active recording and its cache file. Used by Cancel, by the
   * unmount cleanup, and as the bail-out path inside stopAndSave on error. */
  const discardRecording = useCallback(async () => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    pulseRef.current?.stop();
    pulseRef.current = null;
    if (rec) {
      try {
        await rec.stopAndUnloadAsync();
      } catch {
        // Already unloaded or never started — nothing to do.
      }
    }
    const uri = cacheUriRef.current;
    cacheUriRef.current = null;
    if (uri) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        // The OS cache gets wiped on low-memory or reinstall anyway.
      }
    }
  }, []);

  // Unmount cleanup — stop any active recording so the mic indicator in the
  // status bar doesn't strand and the cache file isn't leaked.
  useEffect(() => {
    return () => {
      void discardRecording();
    };
  }, [discardRecording]);

  // Elapsed timer. 200ms tick is smooth enough for an MM:SS display without
  // burning the JS thread.
  useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => {
      if (startedAtRef.current != null) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, 200);
    return () => clearInterval(id);
  }, [phase]);

  // Pulse the REC indicator. useNativeDriver keeps it on the compositor so
  // the JS thread stays free for the timer + save flow.
  useEffect(() => {
    if (phase !== "recording") {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    pulseRef.current = loop;
    loop.start();
    return () => {
      loop.stop();
      pulseRef.current = null;
    };
  }, [phase, pulse]);

  const startRecording = useCallback(async () => {
    if (startingRef.current || recordingRef.current) return;
    startingRef.current = true;
    setError(null);
    setElapsedMs(0);
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);
      // iOS requires this flag before createAsync; Android tolerates skipping
      // it but the call is idempotent so set on both for parity.
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      recordingRef.current = recording;
      cacheUriRef.current = recording.getURI() ?? null;
      startedAtRef.current = Date.now();
      setPhase("recording");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[AudioCapture] start failed:", msg);
      setError(msg);
      await discardRecording();
    } finally {
      startingRef.current = false;
    }
  }, [discardRecording]);

  const stopAndSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setError(null);
    setPhase("saving");
    const rec = recordingRef.current;
    if (!rec) {
      savingRef.current = false;
      setPhase("idle");
      return;
    }
    try {
      const vault = await captureVaultSnapshot();
      const root = vault?.root;
      await rec.stopAndUnloadAsync();
      recordingRef.current = null;
      pulseRef.current?.stop();
      pulseRef.current = null;
      const uri = rec.getURI();
      if (!uri) throw new Error("Recording finished but produced no file");

      // Read as base64 BEFORE the cache file is reaped. Expo writes the
      // recording into the app's cache dir; survives long enough for this
      // read but not across a process restart.
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Belt-and-suspenders cap. A 30-min HIGH_QUALITY recording is ~30 MB —
      // well under 200 MB — but a stuck-on-record session shouldn't OOM the
      // writeBinary serialization.
      if (base64.length > MAX_SAFE_SHARE_BYTES * BASE64_EXPANSION) {
        const capMb = MAX_SAFE_SHARE_BYTES / 1024 / 1024;
        throw new Error(
          `Recording exceeds the ${capMb} MB cap. Save shorter clips.`,
        );
      }

      const slugFallback = timestampSlug();
      // expo-av's HIGH_QUALITY preset writes AAC-in-MP4 on Android (.m4a).
      // Use audio/mp4 so extFromMime maps consistently for downstream code.
      const mime = "audio/mp4";
      const desiredSlug = `audio-${slugFallback}`;
      const { finalName } = await writeBinary(
        "Audio",
        `${desiredSlug}.m4a`,
        base64,
        mime,
        root,
      );
      const sharedStem = finalName.replace(/\.[^.]+$/, "");

      const title = `Audio note: ${finalName}`;
      // Decoded byte count from base64 length (4 chars → 3 bytes). Close
      // enough for the size: frontmatter field; users can see precise size
      // in Obsidian if they need it.
      const sizeStr = String(Math.floor(base64.length * 0.75));
      // kind: "shared-audio" is deliberately reused from PR #7's share-audio
      // branch even though THIS audio was recorded in-app. Reason: downstream
      // code (RecentDetail render, moveToArchive paired-binary detection,
      // future transcription) handles a single audio kind without branching.
      // See plans/completed/native-audio-recording.plan.md.
      const mdNote =
        `---\n` +
        `created: ${new Date().toISOString()}\n` +
        `kind: shared-audio\n` +
        `source: ${yamlQuote(finalName)}\n` +
        `mime: ${yamlQuote(mime)}\n` +
        `size: ${sizeStr}\n` +
        `tags: [shared, audio]\n` +
        `---\n` +
        `# Audio note: ${finalName}\n\n` +
        `## File\n[${finalName}](../Audio/${finalName})\n\n` +
        `## Context\n(none provided)\n`;

      // writeIdea after writeBinary is a partial-failure trap: if the binary
      // landed but the markdown didn't, the .m4a is stranded in Audio/ with
      // no .md referencing it (and moveToArchive can't find orphans). Wrap
      // the markdown write so the error names the orphan instead of failing
      // with a generic "writeIdea threw" that gives the user no recovery path.
      let filepath: string;
      try {
        ({ filepath } = await writeIdea(sharedStem, mdNote, root));
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Wrote Audio/${finalName} but markdown write failed: ${reason}. The audio file is in your vault but unlinked — open Obsidian to recover.`,
        );
      }

      try {
        await recordCapture(
          { id: localId(), mode: "audio", title, filepath, createdAt: Date.now() },
          vault?.context.profileId,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[AudioCapture] recordCapture failed (files saved):", msg);
      }

      // Free the cache file — the canonical bytes now live in the vault.
      // Use the post-stop URI local rather than cacheUriRef so a future
      // change to expo-av's URI semantics doesn't silently delete the
      // wrong file.
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        /* see discardRecording for why we don't surface this */
      }
      cacheUriRef.current = null;

      setSavedFilepath(filepath);
      setSavedRoot(root ?? null);
      setPhase("saved");

      // Fire-and-forget auto-transcribe. No-ops when the toggle is off;
      // helper handles its own errors and never throws by contract. Capture
      // filepath into a local so the closure doesn't read a mutated ref.
      // mountedRef guards the setStates so a tap-Done-before-completion
      // doesn't fire React warnings — the disk write still completes.
      const transcribePath = filepath;
      setAutoTranscribing(true);
      setAutoTranscribeError(null);
      if (!root) {
        setAutoTranscribing(false);
        setAutoTranscribeError("Couldn't resolve the saved vault for auto-transcription.");
        return;
      }
      void autoTranscribeIfEnabled(transcribePath, root).then((errMsg) => {
        if (!mountedRef.current) return;
        setAutoTranscribing(false);
        if (errMsg) setAutoTranscribeError(errMsg);
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[AudioCapture] save failed:", msg);
      setError(msg);
      // Tear down the recording instance to release the mic, but DO NOT
      // delete the cache file. The OS reaps it eventually; meanwhile a
      // future retry path could recover the bytes. discardRecording would
      // have deleted both, destroying the only copy of the audio on a
      // transient write failure (SAF revoked, disk full, etc.).
      const rec = recordingRef.current;
      recordingRef.current = null;
      pulseRef.current?.stop();
      pulseRef.current = null;
      if (rec) {
        try {
          await rec.stopAndUnloadAsync();
        } catch {
          /* already unloaded earlier in the happy path */
        }
      }
      setPhase("idle");
      setElapsedMs(0);
    } finally {
      savingRef.current = false;
    }
  }, []);

  const cancel = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await discardRecording();
    } finally {
      savingRef.current = false;
      setPhase("idle");
      setElapsedMs(0);
    }
  }, [discardRecording]);

  /** Re-run auto-transcribe against the already-saved note. Used by the
   * "Download voice model" recovery button below — the audio + note are
   * already safely on disk, so this only retries the transcription step. */
  const retryTranscribe = useCallback(() => {
    if (!savedFilepath) return;
    if (!savedRoot) {
      setAutoTranscribeError("Couldn't resolve the saved vault for auto-transcription.");
      return;
    }
    setAutoTranscribing(true);
    setAutoTranscribeError(null);
    void autoTranscribeIfEnabled(savedFilepath, savedRoot).then((errMsg) => {
      if (!mountedRef.current) return;
      setAutoTranscribing(false);
      if (errMsg) setAutoTranscribeError(errMsg);
    });
  }, [savedFilepath, savedRoot]);

  /** Pull the on-device English voice model from inside the app (same
   * trigger VoiceButton's dictation error sheet uses), then retry
   * transcription on success. On a queued/dialog-based download (older
   * Android) or an outright failure, point at Speech Services in the Play
   * Store instead — the recognizer's own recovery path. */
  const downloadVoiceModel = useCallback(async () => {
    setDownloadingModel(true);
    try {
      const result = await triggerVoiceModelDownload("en-US");
      if (!mountedRef.current) return;
      if (result === "installed") {
        retryTranscribe();
      } else if (result === "dialog" || result === "scheduled") {
        setAutoTranscribeError(
          "Downloading the English voice model — tap Retry in a moment once it finishes.",
        );
      } else {
        const market = `market://details?id=${SPEECH_SERVICES_PKG}`;
        const web = `https://play.google.com/store/apps/details?id=${SPEECH_SERVICES_PKG}`;
        setAutoTranscribeError(
          "Couldn't start the download automatically. Opening Speech Services by Google in the Play Store — install/update it, then tap Retry.",
        );
        // Both store URLs guarded — the message above already tells the user
        // what to install; an unhandled rejection here helps nobody.
        Linking.openURL(market).catch(() =>
          Linking.openURL(web).catch(() => {}),
        );
      }
    } catch (e: unknown) {
      // A rejected download trigger previously reset the button silently —
      // no message, and the Play Store fallback never ran.
      const msg = e instanceof Error ? e.message : String(e);
      if (mountedRef.current) {
        setAutoTranscribeError(`Voice-model download failed: ${msg}`);
      }
    } finally {
      if (mountedRef.current) setDownloadingModel(false);
    }
  }, [retryTranscribe]);

  // ── Render branches ────────────────────────────────────────────────────────

  if (permissionDenied) {
    return (
      <View style={styles.permissionGate}>
        <Text variant="bodyMedium" style={styles.permissionText}>
          Microphone permission required to record audio.
        </Text>
        <Button mode="contained" onPress={startRecording} style={styles.grantBtn}>
          Try again
        </Button>
      </View>
    );
  }

  if (phase === "saving") {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" />
        <Text variant="bodyMedium" style={styles.dim}>
          Saving to vault…
        </Text>
      </View>
    );
  }

  if (phase === "saved") {
    return (
      <View style={styles.content}>
        <Card style={styles.card}>
          <Card.Title title="Saved to vault" />
          <Card.Content>
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
            ) : autoTranscribeError && isSttModelMissingMessage(autoTranscribeError) ? (
              <View style={styles.modelMissing}>
                <HelperText type="error" visible>
                  The on-device English voice model isn't installed, so this
                  recording couldn't be transcribed. The audio itself is
                  safely saved — download the model to transcribe it.
                </HelperText>
                <View style={styles.modelMissingActions}>
                  <Button
                    mode="contained-tonal"
                    onPress={downloadVoiceModel}
                    loading={downloadingModel}
                    disabled={downloadingModel}
                  >
                    Download voice model
                  </Button>
                  <Button onPress={retryTranscribe} disabled={downloadingModel}>
                    Retry
                  </Button>
                </View>
              </View>
            ) : autoTranscribeError ? (
              <View style={styles.modelMissing}>
                <HelperText type="error" visible>
                  {`Auto-transcribe failed: ${autoTranscribeError}`}
                </HelperText>
                <Button onPress={retryTranscribe}>Retry</Button>
              </View>
            ) : (
              <HelperText type="info" visible>
                Open Obsidian (or your editor) on the synced folder to listen
                or annotate.
              </HelperText>
            )}
          </Card.Content>
          <Card.Actions>
            <Button mode="contained" onPress={() => navigation.goBack()}>
              Done
            </Button>
          </Card.Actions>
        </Card>
      </View>
    );
  }

  // idle | recording — single layout, swap the controls in the card.
  return (
    <View style={styles.content}>
      <Card style={styles.card}>
        <Card.Content style={styles.recordCard}>
          {phase === "recording" ? (
            <View style={styles.recRow}>
              <Animated.View
                style={[
                  styles.recDot,
                  { backgroundColor: theme.colors.error, opacity: pulse },
                ]}
              />
              <Text variant="labelLarge" style={{ color: theme.colors.error }}>
                REC
              </Text>
            </View>
          ) : (
            <Text variant="labelLarge" style={styles.dim}>
              Tap to record
            </Text>
          )}

          <Text variant="displayMedium" style={styles.timer}>
            {formatElapsed(elapsedMs)}
          </Text>

          {phase === "idle" ? (
            <IconButton
              icon="record"
              mode="contained"
              size={64}
              iconColor={theme.colors.onPrimary}
              containerColor={theme.colors.primary}
              onPress={startRecording}
              accessibilityLabel="Start recording"
            />
          ) : (
            <View style={styles.recordingActions}>
              <Button
                mode="contained"
                icon="stop"
                onPress={stopAndSave}
                style={styles.stopBtn}
                contentStyle={styles.stopBtnContent}
              >
                Stop & save
              </Button>
              <Button mode="text" onPress={cancel}>
                Cancel
              </Button>
            </View>
          )}
        </Card.Content>
      </Card>

      {error ? (
        <Banner visible icon="alert" actions={[]}>
          {error}
        </Banner>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, padding: 16, gap: 12, justifyContent: "center" },
  card: { marginTop: 4 },
  body: { fontSize: 14, lineHeight: 20 },
  dim: { opacity: 0.6 },
  recordCard: {
    alignItems: "center",
    paddingVertical: 24,
    gap: 16,
  },
  recRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  recDot: { width: 12, height: 12, borderRadius: 6 },
  timer: { fontVariant: ["tabular-nums"] },
  recordingActions: { width: "100%", gap: 8, alignItems: "center" },
  stopBtn: { borderRadius: 12, alignSelf: "stretch" },
  stopBtnContent: { paddingVertical: 12 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  permissionGate: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  permissionText: { textAlign: "center" },
  grantBtn: { marginTop: 8 },
  transcribeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 8,
  },
  modelMissing: { gap: 4 },
  modelMissingActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
