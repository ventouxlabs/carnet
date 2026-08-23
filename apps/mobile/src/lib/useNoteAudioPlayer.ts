// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Inline audio player for a note with a paired recording (kind === shared-audio),
 * lifted out of RecentDetailScreen so the load/toggle/rewind decisions and the
 * unload-on-unmount lifecycle live in one tested place.
 *
 * The sound is loaded lazily on the first tap and kept loaded afterwards, so a
 * replay costs no re-load; the status callback drives the progress bar.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Audio } from "expo-av";

import { readPairedBinaryUri } from "./writer";

/** The three things a tap on Play/Pause can mean for an already-loaded sound. */
export type PlaybackAction = "pause" | "restart" | "resume";

/** Loaded-sound status fields the toggle decision reads. */
export interface PlaybackStatus {
  isPlaying: boolean;
  positionMillis: number;
  durationMillis?: number;
}

/**
 * Decide what a tap means for a sound that is already loaded.
 *
 * Playing → pause. Otherwise, a position parked within 100ms of the end means
 * the previous play ran to completion, so the tap should REWIND and play again
 * rather than resume at the end (which looks like a dead button). Anything else
 * resumes in place.
 */
export function nextPlaybackAction(status: PlaybackStatus): PlaybackAction {
  if (status.isPlaying) return "pause";
  if (status.positionMillis >= (status.durationMillis ?? 0) - 100) return "restart";
  return "resume";
}

export interface NoteAudioPlayer {
  playerLoading: boolean;
  playerError: string | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  togglePlay: () => Promise<void>;
}

/**
 * @param body the note's full markdown — the paired binary is resolved from it.
 */
export function useNoteAudioPlayer(body: string): NoteAudioPlayer {
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const mountedRef = useRef(true);

  // Unload the sound on UNMOUNT — keeps the audio focus returned to the system
  // and frees the file handle. The `[]` deps mean there is deliberately no
  // note-switch unload path: a `body` change alone would NOT re-run this. That
  // is safe today only because related-note navigation uses navigation.push, so
  // every note gets a fresh screen (and hook) instance rather than an in-place
  // param update. Switching to an in-place param update would strand the
  // previous note's sound loaded — add `body` to the deps if that ever changes.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const s = soundRef.current;
      soundRef.current = null;
      if (s) {
        void s.unloadAsync().catch(() => undefined);
      }
    };
  }, []);

  const togglePlay = useCallback(async () => {
    setPlayerError(null);
    try {
      if (soundRef.current) {
        // Already loaded — just toggle.
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded) {
          const action = nextPlaybackAction(status);
          if (action === "pause") {
            await soundRef.current.pauseAsync();
          } else if (action === "restart") {
            // Reached end on prior play — rewind before resuming so a
            // tap on Play after finish replays instead of staying stuck.
            await soundRef.current.setPositionAsync(0);
            await soundRef.current.playAsync();
          } else {
            await soundRef.current.playAsync();
          }
        }
        return;
      }
      // First tap — load + start. Status callback drives the progress bar.
      setPlayerLoading(true);
      const { uri } = await readPairedBinaryUri(body);
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, progressUpdateIntervalMillis: 250 },
        (status) => {
          if (!status.isLoaded) return;
          if (!mountedRef.current) return;
          setIsPlaying(status.isPlaying);
          setPositionMs(status.positionMillis);
          setDurationMs(status.durationMillis ?? 0);
          if (status.didJustFinish) {
            // Stay loaded so the next tap replays without re-loading.
            setIsPlaying(false);
          }
        },
      );
      soundRef.current = sound;
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[RecentDetail] audio playback failed:", reason);
      setPlayerError(reason);
    } finally {
      setPlayerLoading(false);
    }
  }, [body]);

  return { playerLoading, playerError, isPlaying, positionMs, durationMs, togglePlay };
}
