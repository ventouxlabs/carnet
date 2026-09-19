import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, ScrollView, StyleSheet } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { RootStackParamList } from "../../App";
import type { VoiceButtonHandle } from "../voice/VoiceButton";
import { ModeInput } from "../components/CaptureModeInput";
import {
  CaptureActionBar,
  CaptureMetaSheet,
  CapturePreviewCard,
  CaptureSavedCard,
  CaptureSubmittingView,
} from "../components/CaptureViews";
import { getSettings } from "../lib/settings";
import { captureVaultContext, type VaultContext } from "../lib/vaultContext";
import { resolveContextRoot } from "../lib/vaultRoot";
import { recordCapture, type CaptureMode } from "../lib/storage";
import { DEFAULT_VAULT_PROFILE_ID } from "../lib/vaultProfiles";
import {
  enrichIdea,
  enrichJournal,
  enrichPerson,
  promoteIdea as omniPromoteIdea,
} from "../lib/dispatcher";
import {
  slugify,
  getModificationTime,
  extractNameFromMarkdown,
  readNote,
  type AttachmentRef,
} from "../lib/writer";
import {
  enrichIdeaInPlace,
  rewriteRawIdea,
  writeRawIdea,
  type EnrichIdeaOutcome,
  type RawIdeaInput,
} from "../lib/ideaSaveFirst";
import { classifyCaptureError } from "../lib/captureErrorDecision";
import { planSaveFirstOutcome } from "../lib/saveFirstOutcome";
import { resolveActiveProvider, UNKNOWN_PROVIDER_LABEL } from "../lib/llmProviders";
import { persistAttachments as persistAttachmentsToVault } from "../lib/attachmentPersistence";
import { mergeAttachmentRefs } from "../lib/captureAttachmentMerge";
import { chainHistoryWrite } from "../lib/captureHistory";
import { localId, todayLocal } from "../lib/captureLocalIds";
import { confirmSaveIdea, confirmSaveJournal, confirmSavePerson } from "../lib/captureConfirmSave";
import type { Place } from "../lib/writer";
import { promoteIdeaOnDisk } from "../lib/promoteIdeaOnDisk";
import { pickAttachment, type PickedAttachment } from "../lib/attachments";
import { clearDraft, loadDraft, saveDraft } from "../lib/captureDraft";
import { enqueue, drainQueue, getQueueDepth } from "../lib/queue";
import { getTagIndex, upsertNoteInIndex } from "../lib/vault";
import {
  buildPreviewSubtitle,
  buildMetaSummary,
  buildCapturePreviewResponse,
  computeCanSubmit,
  type CapturePhase,
} from "../lib/captureDisplay";
import {
  deriveTitle,
  parseStatusFromMarkdown,
  type CaptureResponse,
  type IdeaStatus,
} from "@carnet/shared";

type Props = NativeStackScreenProps<RootStackParamList, "Capture">;

type Phase = CapturePhase;

/** Pending OmniRoute idea result — held in state until user confirms save. */
interface PendingIdea {
  slug: string;
  markdown: string;
  model: string;
}

/** Pending OmniRoute journal result — held until user confirms save. */
interface PendingJournal {
  date: string;
  markdown: string;
  model: string;
}

/** Pending OmniRoute person result — held until user confirms save. */
interface PendingPerson {
  firstName: string;
  lastName: string;
  markdown: string;
  model: string;
}

export default function CaptureScreen({ route, navigation }: Props) {
  const mode: CaptureMode = route.params.mode;
  const [phase, setPhase] = useState<Phase>("input");
  // Metadata (tags/location/attachments) lives in a sheet behind the "+"
  // button so it never blocks writing — capture-first, file later.
  const [metaOpen, setMetaOpen] = useState(false);
  const [text, setText] = useState("");
  const [transcript, setTranscript] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [response, setResponse] = useState<CaptureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // OmniRoute path: preview data before file write
  const [pendingIdea, setPendingIdea] = useState<PendingIdea | null>(null);
  const [pendingJournal, setPendingJournal] = useState<PendingJournal | null>(null);
  const [pendingPerson, setPendingPerson] = useState<PendingPerson | null>(null);
  // OmniRoute path: filepath only set after confirmSave writes the file
  const [savedFilepath, setSavedFilepath] = useState<string | null>(null);
  // OmniRoute path: model used for display
  const [omniModel, setOmniModel] = useState<string | null>(null);

  const [queueDepth, setQueueDepth] = useState(0);
  const [showSource, setShowSource] = useState(false);
  // Attachments picked but not yet written — held until the capture commits
  // (confirmSave online, or enqueue offline) so cancelling at preview leaves
  // no orphaned binaries on disk. Idea + Journal only.
  const [pending, setPending] = useState<PickedAttachment[]>([]);
  // Mirrors preservedAttachmentsRef for display only: attachments already
  // written to disk from an earlier submit in this capture (Edit tapped
  // mid-enrichment), shown read-only in the meta sheet so the user doesn't
  // wrongly conclude they need to re-attach — see CaptureMetaSheet.
  const [savedAttachments, setSavedAttachments] = useState<
    { filename: string; kind: "image" | "file" }[]
  >([]);
  // User-entered tags, merged into the note frontmatter at write time (both the
  // online and offline paths). knownTags backs the autocomplete.
  const [tags, setTags] = useState<string[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  // The autocomplete index belongs to one vault. Its identity guard prevents
  // a slow A read from repainting the suggestions after focus returns under B.
  const tagVaultContextRef = useRef<VaultContext | null>(null);
  // User-selected location as a `lat,lon` string, injected into frontmatter on save.
  const [location, setLocation] = useState<string | null>(null);
  // Named places for this entry, written into the note BODY (not frontmatter) so
  // several same-day journal entries each keep their own. Journal only.
  const [places, setPlaces] = useState<Place[]>([]);
  // Save-first vs. blocking-preview for Idea. Default false = save-first (the raw
  // note is written immediately, enrichment updates it in place). Loaded from
  // settings on mount; Journal/Person never consult it.
  const [previewBeforeSave, setPreviewBeforeSave] = useState(false);
  // Which backend the submitting-phase label names — read once alongside
  // previewBeforeSave so "OmniRoute is structuring…" doesn't show while a
  // capture is actually enriching via the local backend (or vice versa).
  const [llmBackend, setLlmBackend] = useState<"omniroute" | "local">("omniroute");
  // Active provider's display label — read once alongside llmBackend, threaded
  // into classifyCaptureError/planSaveFirstOutcome so their queue/error copy
  // names the real provider instead of a hardcoded one.
  const [providerLabel, setProviderLabel] = useState(UNKNOWN_PROVIDER_LABEL);
  // Saved-screen state for the save-first Idea failure paths (mirrors photo):
  // `degradedReason` = permanent enrichment failure (raw note kept, Re-enrich
  // offered); `enrichNotice` = an info line (queued offline, or conflict).
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [enrichNotice, setEnrichNotice] = useState<string | null>(null);
  // The captured Idea inputs, stashed so the saved-screen Re-enrich can re-run
  // enrichment against the same text/tags/location/attachments after the input
  // fields were cleared.
  const saveFirstCtxRef = useRef<RawIdeaInput | null>(null);
  // Captured once when an attempt begins. Preview confirmation, a save-first
  // retry, and offline fallback all reuse this rather than rereading Settings
  // after enrichment has yielded to the event loop.
  const attemptVaultContextRef = useRef<VaultContext | null>(null);
  // Monotonic id for the current capture attempt. Every async continuation
  // captures the generation it started under and bails if it no longer matches,
  // so tapping Edit (or simply resubmitting) invalidates every in-flight
  // continuation from the attempt before it. A boolean "aborted" flag cannot do
  // this: the next submit has to clear it, which un-cancels the abandoned call
  // and lets its late result drive the screen. The requests themselves are not
  // cancelled — only their effects are dropped.
  const submitGenerationRef = useRef(0);
  // The draft the in-flight attempt is working from, stashed before any await
  // so Edit can restore it no matter how far the attempt got.
  const submittedDraftRef = useRef<RawIdeaInput | null>(null);
  // The in-flight raw write. Edit awaits it so the filepath it produces is
  // known before the user can resubmit — otherwise a resubmit issued during
  // the write falls through to writeRawIdea again and orphans a duplicate.
  const rawWriteRef = useRef<Promise<{ filepath: string }> | null>(null);
  // True only while rawWriteRef holds a REAL write. reEnrichSaved publishes a
  // synthetic already-resolved promise there (it re-enriches a note that is
  // long since on disk), and Edit's mtime bump must not fire against that: its
  // draft is the ORIGINAL raw text, so rewriting it would overwrite the
  // enriched — or Syncthing-updated — note on disk with a stale raw stub.
  const rawWriteIsRealRef = useRef(false);
  // `created` for the note the current capture owns, so the resubmit and the
  // mtime bump both rewrite it with its original capture time instead of
  // letting buildRawIdeaMarkdown default to a fresh `new Date()` each pass.
  const rawCreatedAtRef = useRef<Date | null>(null);
  // The attachments the in-flight attempt already wrote to disk, carried across
  // an Edit. `pending` is cleared the moment the raw note lands, so the
  // resubmit's persistAttachments() returns nothing and the rebuilt draft would
  // come back attachment-less — the binaries stay on disk, unreferenced.
  const preservedAttachmentsRef = useRef<AttachmentRef[]>([]);
  // True while an editInstead() call is still working through its awaits. A
  // second tap would otherwise run to completion alongside the first and its
  // trailing setPhase("input") could land AFTER the resubmit the first one
  // enabled — silently reverting a newer capture out of its in-flight state.
  const editInFlightRef = useRef(false);
  // The most recent attempt's ENTIRE recents-history mutation chain (its
  // optional removal plus its recordCapture), so the next attempt can await the
  // whole thing before starting its own read-modify-write. Never rejects — see
  // submit().
  const recordCaptureRef = useRef<Promise<void> | null>(null);
  // Non-null while re-editing an Idea whose raw note is ALREADY on disk. The
  // resubmit must overwrite that exact path — writeRawIdea would derive a fresh
  // slug from the edited text and leave the original orphaned as a duplicate.
  const [editingFilepath, setEditingFilepath] = useState<string | null>(null);

  // Draft persistence: restore on entry, autosave (debounced) while typing,
  // cleared at every point the capture is safely persisted. State (not a
  // ref) so the autosave effect re-arms as soon as the restore completes —
  // otherwise text typed before loadDraft resolves isn't persisted until
  // the next keystroke. The guard also stops the empty first render from
  // wiping a stored draft before it loads.
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftProfileId, setDraftProfileId] = useState(DEFAULT_VAULT_PROFILE_ID);
  useEffect(() => {
    let cancelled = false;
    // A draft belongs to the vault that was active when this capture form was
    // opened. Read Settings before touching its storage key so switching to
    // Work never restores a half-written Personal note.
    getSettings()
      .then((settings) => {
        const profileId = captureVaultContext(settings).profileId;
        if (!cancelled) setDraftProfileId(profileId);
        setPreviewBeforeSave(settings.previewBeforeSave);
        setLlmBackend(settings.activeProviderId === "relais" ? "local" : "omniroute");
        if (Array.isArray(settings.llmProviders) && settings.llmProviders.length > 0) {
          setProviderLabel(
            resolveActiveProvider(settings.llmProviders, settings.activeProviderId).label,
          );
        }
        return loadDraft(mode, profileId);
      })
      .then((draft) => {
        if (cancelled || !draft) return;
        // Only fill fields the user hasn't already typed into (e.g. a fast
        // dictation landing before the async load resolves).
        setText((cur) => cur || draft.text);
        setTranscript((cur) => cur || draft.transcript);
        setOcrText((cur) => cur || draft.ocrText);
      })
      // A failed draft read means starting blank — the benign outcome; the
      // finally below still unlatches draft persistence either way.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDraftLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    if (!draftLoaded || phase !== "input") return;
    const timer = setTimeout(() => {
      saveDraft(mode, { text, transcript, ocrText }, draftProfileId).catch(() => {
        // Best-effort: a failed autosave must never surface mid-typing.
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [draftLoaded, draftProfileId, mode, phase, text, transcript, ocrText]);

  useEffect(() => {
    void getQueueDepth().then(setQueueDepth);
    // Drain any queued captures on screen open
    void drainQueue().then(() => getQueueDepth().then(setQueueDepth));
  }, []);

  useEffect(() => {
    let active = true;
    let request = 0;
    const reloadTags = (): void => {
      // Clear A's values before awaiting B's settings/index reads. The
      // autocomplete is optional, so an empty list is safer than cross-vault
      // suggestions while the new profile loads.
      tagVaultContextRef.current = null;
      setKnownTags([]);
      const ticket = ++request;
      void getSettings()
        .then((settings) => captureVaultContext(settings))
        .then((context) => {
          if (!active) return;
          tagVaultContextRef.current = context;
          return getTagIndex(context.profileId, resolveContextRoot(context))
            .then((index) => ({ context, index }));
        })
        .then((result) => {
          if (
            active && result && request === ticket &&
            tagVaultContextRef.current === result.context
          ) {
            const { index } = result;
            setKnownTags(index.tags.map((entry) => entry.tag));
          }
        })
        .catch(() => {});
    };
    reloadTags();
    const unsubscribe = navigation.addListener("focus", reloadTags);
    return () => {
      active = false;
      tagVaultContextRef.current = null;
      unsubscribe();
    };
  }, [navigation]);

  const currentStatus = useMemo(
    () => parseStatusFromMarkdown(response?.preview_markdown ?? ""),
    [response?.preview_markdown],
  );

  // Preview-card subtitle: the target filename for this mode + the enriching
  // model. Computed here so the presentational card stays mode-agnostic.
  const previewSubtitle = useMemo(
    () => buildPreviewSubtitle({ mode, pendingIdea, pendingJournal, pendingPerson, omniModel }),
    [mode, pendingIdea, pendingJournal, pendingPerson, omniModel],
  );

  // One quiet line summarizing what's staged behind the "+" sheet, so the
  // user can see filing state without opening it.
  const metaSummary = useMemo(
    () => buildMetaSummary(tags, pending, location),
    [tags, pending, location],
  );

  const canSubmit = useMemo(
    () => computeCanSubmit({ phase, mode, text, transcript, ocrText }),
    [phase, mode, text, transcript, ocrText],
  );

  // Handle to the active VoiceButton (Idea/Journal). Lets the attach handlers
  // gracefully stop dictation + commit the partial transcript before the picker
  // opens — otherwise the picker Activity backgrounds the app and the in-flight
  // transcript is stranded (never emitted as final).
  const voiceRef = useRef<VoiceButtonHandle>(null);

  /** Open the picker and stage the chosen attachment. Surfaces the friendly
   * cap/read error from pickAttachment rather than dropping it. */
  const addAttachment = async (imagesOnly: boolean): Promise<void> => {
    voiceRef.current?.stopAndFlush();
    setError(null);
    try {
      const picked = await pickAttachment({ imagesOnly });
      if (picked) setPending((prev) => [...prev, picked]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeAttachment = (index: number): void => {
    // No stopAndFlush() here: removing a staged chip is a pure state update with
    // no Activity switch, so dictation isn't interrupted — flushing would only
    // force-stop the mic mid-sentence. The picker path (addAttachment) is the one
    // that backgrounds the app and needs the flush.
    setPending((prev) => prev.filter((_, i) => i !== index));
  };

  // Remembers which staged attachments are already on disk, keyed by the
  // picked-attachment object. A failed commit (writeIdea/enqueue threw) leaves
  // `pending` intact; without this a retry would re-run writeBinary and, since
  // findCollisionFreeName never overwrites, strand the first write as an
  // orphan (`sketch.jpg` unreferenced, `sketch-2.jpg` linked). Keying by object
  // identity also means removing an attachment between attempts drops it
  // cleanly and a newly-added one still gets written.
  const persistedRefs = useRef(new WeakMap<PickedAttachment, AttachmentRef>());

  /** Write every staged attachment to the vault (once each) and return the
   * rel-path references to embed/queue. Thin closure over the current staged
   * set + the dedup cache; the write/dedup logic lives in
   * lib/attachmentPersistence so it's unit-testable without a renderer. */
  const persistAttachments = (vaultContext = attemptVaultContextRef.current): Promise<AttachmentRef[]> =>
    persistAttachmentsToVault(
      pending,
      persistedRefs.current,
      vaultContext ? resolveContextRoot(vaultContext) : undefined,
    );

  /** Clear every staged-metadata field once a capture is safely persisted
   * (written to disk, queued, or enqueued) — repeated across the offline
   * queue, save-first commit, and confirmSave (Idea/Journal) so the next
   * capture starts fresh with nothing carried over. */
  const clearStagedAttachmentsAndMeta = (): void => {
    setPending([]);
    setSavedAttachments([]);
    setTags([]);
    setLocation(null);
    setPlaces([]);
  };

  /** Same clear, minus the attachment fields — Person captures never stage
   * attachments, so confirmSave's person branch only has tags/location/
   * places to reset. */
  const clearStagedMeta = (): void => {
    setTags([]);
    setLocation(null);
    setPlaces([]);
  };

  /** Build an offline-or-error handler. Permanent errors (4xx) surface to
   * the user with the actual message; transient errors (network / 5xx)
   * enqueue silently with a "queued for sync" notice. */
  const handleCaptureError = async (
    e: unknown,
    enqueueFn: () => Promise<void>,
    /** Re-checked after EVERY await below. This runs while the Edit button is
     * still on screen, and its input-clearing block would otherwise wipe the
     * draft the user just restored — leaving the un-edited capture queued. */
    superseded: () => boolean,
  ): Promise<void> => {
    // A blank OmniRoute URL is a config problem (not an offline blip) and a 4xx
    // is permanent — both surface the message and keep the text for a resend.
    // Only transient (network / 5xx) errors fall through to the offline queue.
    const decision = classifyCaptureError(e, providerLabel);
    if (decision.kind !== "transient") {
      setError(decision.message);
      setPhase("input");
      return;
    }
    // Wrap the queue write so a failure here can never strand the user on the
    // "submitting" spinner — the finally always returns to the input phase.
    try {
      // Known limitation: a queue entry is durable the moment this resolves, so
      // an Edit tapped during the write cannot retract it — the original
      // capture may still drain later as a duplicate. Out of scope here.
      await enqueueFn();
      if (superseded()) return;
      const depth = await getQueueDepth();
      if (superseded()) return;
      setQueueDepth(depth);
      setError("Offline — capture queued.");
      // The capture is safely persisted in the queue — clear the inputs so the
      // next capture starts fresh. Permanent (4xx) errors above intentionally
      // keep the text so the user can fix the problem and resend.
      setText("");
      setTranscript("");
      setOcrText("");
      clearStagedAttachmentsAndMeta();
      void clearDraft(mode, attemptVaultContextRef.current?.profileId ?? draftProfileId).catch(() => undefined);
    } catch (qe: unknown) {
      if (superseded()) return;
      const qmsg = qe instanceof Error ? qe.message : String(qe);
      setError(`Couldn't reach ${providerLabel}, and queuing offline failed: ${qmsg}`);
    } finally {
      // The `return`s above skip this by design: a superseded attempt must not
      // pull the user out of the draft they went back to editing.
      if (!superseded()) setPhase("input");
    }
  };

  /** Map a save-first enrichment outcome onto the UI: success closes the
   * screen; conflict/queued surface an info banner; permanent failure surfaces
   * the degraded banner + Re-enrich. The raw note is already on disk in every
   * branch, so nothing is ever lost. `mtime` is the guard baseline to re-queue
   * with on a transient failure. */
  const finishSaveFirst = async (
    outcome: EnrichIdeaOutcome,
    ctx: RawIdeaInput,
    filepath: string,
    mtime: number | null,
    /** The raw note's bytes at that same baseline — the SAF vault's only
     * conflict guard, so it has to survive into the queued retry too. */
    baselineContent: string | null,
    /** Re-checked after this function's own await — Edit can land during the
     * enqueue just as easily as during the model call. */
    superseded: () => boolean,
  ): Promise<void> => {
    const plan = planSaveFirstOutcome(outcome, providerLabel);
    if (plan.kind === "close") {
      // Reflect the enriched note (final tags, pending-enrich status gone)
      // in the cached index before landing back on Home.
      void upsertNoteInIndex(
        filepath,
        plan.markdown,
        attemptVaultContextRef.current?.profileId,
      ).catch(() => undefined);
      setPhase("saved");
      navigation.goBack();
      return;
    }
    if (plan.kind === "conflict") {
      setEnrichNotice(plan.notice);
      setPhase("saved");
      return;
    }
    if (plan.kind === "queue") {
      try {
        await enqueue({
          mode: "idea",
          text: ctx.text,
          attachments: ctx.attachments,
          tags: ctx.tags,
          location: ctx.location,
          // Update the raw note we already wrote in place on drain — do NOT
          // write a duplicate.
          filepath,
          baselineMtime: mtime,
          baselineContent,
          vaultContext: attemptVaultContextRef.current ?? undefined,
        });
        const depth = await getQueueDepth();
        if (superseded()) return;
        setQueueDepth(depth);
        setEnrichNotice(plan.notice);
      } catch {
        if (superseded()) return;
        setEnrichNotice(plan.fallbackNotice);
      }
      setPhase("saved");
      return;
    }
    // plan.kind === "degraded"
    setDegradedReason(plan.reason);
    setPhase("saved");
  };

  /** Re-run enrichment on the already-saved raw note from the saved screen.
   * Re-reads the mtime as a fresh guard baseline (the note may have synced). */
  const reEnrichSaved = async (): Promise<void> => {
    const ctx = saveFirstCtxRef.current;
    if (!ctx || !savedFilepath) return;
    setError(null);
    setDegradedReason(null);
    setEnrichNotice(null);
    const myGeneration = ++submitGenerationRef.current;
    const superseded = (): boolean => submitGenerationRef.current !== myGeneration;
    // Edit is offered during this pass too, so give it the same draft and
    // already-written filepath the submit path publishes.
    submittedDraftRef.current = ctx;
    rawWriteRef.current = Promise.resolve({ filepath: savedFilepath });
    // Synthetic: no write happens here, this only publishes the known filepath.
    rawWriteIsRealRef.current = false;
    setPhase("submitting");
    const baseline = await getModificationTime(savedFilepath);
    // Baseline first, then the bytes at that baseline — on SAF `baseline` is
    // always null, so this snapshot is the only thing standing between a stale
    // enrichment and the note the user has since edited.
    const baselineContent = await readNote(savedFilepath).catch(() => null);
    if (superseded()) return;
    const outcome = await enrichIdeaInPlace({
      filepath: savedFilepath,
      expectedMtime: baseline,
      expectedContent: baselineContent,
      text: ctx.text,
      tags: ctx.tags,
      location: ctx.location,
      attachments: ctx.attachments,
      vaultContext: attemptVaultContextRef.current ?? undefined,
    });
    if (superseded()) return;
    await finishSaveFirst(outcome, ctx, savedFilepath, baseline, baselineContent, superseded);
  };

  /** Escape hatch offered during "submitting": go back to an editable draft
   * instead of waiting for (and accepting) the enrichment now in flight. The
   * request itself keeps running — its UI effects are always suppressed, and
   * its disk write is invalidated too EXCEPT from reEnrichSaved (rawWriteIsRealRef
   * false there): that path's own mtime baseline is deliberately left alone, so an
   * abandoned re-enrichment there still lands — re-enriching the same text the
   * user already had, not a stub, so this is accepted rather than fixed. */
  const editInstead = async (): Promise<void> => {
    // A second tap while the first is still awaiting the raw write must not run
    // its own copy of this — see editInFlightRef.
    if (editInFlightRef.current) return;
    editInFlightRef.current = true;
    try {
      await runEditInstead();
    } finally {
      editInFlightRef.current = false;
    }
  };

  const runEditInstead = async (): Promise<void> => {
    // Invalidates every continuation of the attempt now in flight.
    submitGenerationRef.current += 1;
    setError(null);
    setDegradedReason(null);
    setEnrichNotice(null);

    if (mode === "idea") {
      const draft = submittedDraftRef.current;
      if (draft) {
        // Save-first clears the inputs once the raw note lands — put them back.
        setText(draft.text);
        setTags(draft.tags);
        setLocation(draft.location ?? null);
      }
      // Carry the already-written attachments across the edit — see
      // preservedAttachmentsRef. Kept (not overwritten) when this draft was
      // stashed before its attachments resolved, so a second Edit tapped during
      // a resubmit can't wipe what the first one preserved.
      const draftAttachments = draft?.attachments;
      if (draftAttachments && draftAttachments.length > 0) {
        preservedAttachmentsRef.current = draftAttachments;
        setSavedAttachments(draftAttachments.map((a) => ({ filename: a.filename, kind: a.kind })));
      }
      // The raw write may still be in flight; its filepath is what the resubmit
      // must overwrite. Phase stays "submitting" until it resolves, which is
      // what keeps Send disabled and makes the resubmit safe.
      const write = rawWriteRef.current;
      if (write) {
        try {
          const { filepath } = await write;
          setEditingFilepath(filepath);
          // Edit does not touch the file, so the enrichment still in flight
          // would find a matching mtime and write the result the user just
          // walked away from. Re-writing the same draft bumps the mtime, which
          // makes that call's updateNoteIfUnchanged guard fail — the existing
          // conflict mechanism, rather than a second cancellation path. Only
          // Idea needs it; Journal/Person write nothing before enrichment.
          //
          // Gated on rawWriteIsRealRef: reEnrichSaved's rawWriteRef is
          // synthetic and its draft is the ORIGINAL raw text, so bumping there
          // would overwrite the enriched (or synced) note with a raw stub.
          // `createdAt` is pinned for the same reason the resubmit pins it —
          // the default would restamp the note's capture time on every Edit.
          if (draft && rawWriteIsRealRef.current) {
            await rewriteRawIdea({ ...draft, filepath }, rawCreatedAtRef.current ?? undefined);
          }
        } catch {
          // The raw write failed, so there is nothing on disk to overwrite —
          // the resubmit correctly falls through to a fresh writeRawIdea. (A
          // failed mtime bump lands here too, with editingFilepath already set:
          // the resubmit still targets the right file, and the in-flight
          // enrichment simply isn't invalidated — the pre-fix behaviour.)
        }
      }
    }
    // Journal and Person write nothing before enrichment, so their transcript /
    // ocrText / text are all still in state — there is nothing to restore.
    setPhase("input");
  };

  const submit = async () => {
    // The "+" metadata button already dismisses on open (QA finding: a still-open
    // keyboard renders over the near-black sheet in dark mode); Send needs the
    // same treatment — otherwise the keyboard stays up through submitting/preview
    // and the user has to back out of it manually.
    Keyboard.dismiss();
    const myGeneration = ++submitGenerationRef.current;
    /** True once Edit (or another submit) has superseded this attempt. Checked
     * before EVERY state write in an async continuation below. */
    const superseded = (): boolean => submitGenerationRef.current !== myGeneration;
    submittedDraftRef.current = null;
    rawWriteRef.current = null;
    rawWriteIsRealRef.current = false;
    setPhase("submitting");
    setError(null);
    setDegradedReason(null);
    setEnrichNotice(null);
    // This is intentionally before any provider or attachment await. Settings
    // can switch vaults while a slow model request is outstanding; its result
    // must keep this root, not follow the later active profile.
    try {
      attemptVaultContextRef.current = captureVaultContext(await getSettings());
    } catch {
      // Preserve ordinary capture availability if settings storage is briefly
      // unavailable. Writers retain their existing active-root fallback.
      attemptVaultContextRef.current = null;
    }

    if (mode === "idea") {
      // Blocking-preview (opt-in): enrich → preview → Save, exactly as before.
      if (previewBeforeSave) {
        try {
          const result = await enrichIdea(text.trim(), {
            vaultContext: attemptVaultContextRef.current ?? undefined,
          });
          if (superseded()) return;
          const title = deriveTitle(result.markdown);
          const slug = slugify(title) || "untitled";
          setPendingIdea({ slug, markdown: result.markdown, model: result.model });
          setOmniModel(result.model);
          setResponse(buildCapturePreviewResponse(result.markdown));
          setPhase("preview");
        } catch (e: unknown) {
          if (superseded()) return;
          await handleCaptureError(e, async () => {
            // Write the binaries to disk first (local + offline-safe), then
            // queue only their rel-paths — never base64.
            const refs = await persistAttachments();
            await enqueue({
              mode: "idea",
              text: text.trim(),
              attachments: refs,
              tags,
              location: location ?? undefined,
              vaultContext: attemptVaultContextRef.current ?? undefined,
            });
          }, superseded);
        }
        return;
      }

      // Save-first (default): write the raw note NOW, then enrich it in place.
      try {
        // Stashed before the first await so Edit can restore the draft even if
        // it is tapped while the attachments are still being written.
        submittedDraftRef.current = {
          text: text.trim(),
          tags,
          location: location ?? undefined,
        };
        const refs = await persistAttachments();
        // Earliest await in the path, and upstream of rawWriteRef being
        // published — an Edit tapped here finds no write to await, so bailing
        // is what keeps editingFilepath from being left null (which would send
        // the resubmit back through writeRawIdea and orphan a duplicate).
        // Safe to abandon: nothing is on disk yet, and persistAttachments
        // memoizes by PickedAttachment identity, so a resubmit reuses these.
        if (superseded()) return;
        // Resubmitting after Edit: overwrite the note already on disk rather
        // than writing a second one under the edited text's new slug.
        const resuming = editingFilepath;
        // On a resubmit, `refs` covers only what was staged since the Edit —
        // the first attempt's binaries are on disk but no longer in `pending`,
        // so they come from preservedAttachmentsRef or they are silently lost.
        // De-duped by rel — see mergeAttachmentRefs.
        const attachments = mergeAttachmentRefs(
          preservedAttachmentsRef.current,
          refs,
          Boolean(resuming),
        );
        const ctx: RawIdeaInput = { ...submittedDraftRef.current, attachments };
        submittedDraftRef.current = ctx;
        // Consumed — a later, unrelated capture must not inherit these refs.
        preservedAttachmentsRef.current = [];
        setSavedAttachments([]);
        // A resubmit rewrites the SAME note, so it keeps that note's original
        // `created` — the capture moment did not change because the text was
        // edited. Passed explicitly: the default is a fresh `new Date()`.
        const createdAt = (resuming && rawCreatedAtRef.current) || new Date();
        rawCreatedAtRef.current = createdAt;
        const writePromise = resuming
          ? rewriteRawIdea({ ...ctx, filepath: resuming }, createdAt)
          : writeRawIdea(
              ctx,
              createdAt,
              attemptVaultContextRef.current
                ? resolveContextRoot(attemptVaultContextRef.current)
                : undefined,
            );
        // Published before awaiting, so an Edit tapped mid-write can await the
        // same promise and learn the filepath instead of racing it.
        rawWriteRef.current = writePromise;
        rawWriteIsRealRef.current = true;
        const { filepath, mtime, markdown: rawMarkdown } = await writePromise;
        if (superseded()) return;
        const title = deriveTitle(ctx.text) || "Idea";
        // Every history mutation this attempt performs, chained after the
        // previous attempt's own chain — see chainHistoryWrite.
        const historyWrite = chainHistoryWrite({
          priorWrite: recordCaptureRef.current,
          resuming: Boolean(resuming),
          filepath,
          mode,
          title,
          id: localId(),
          createdAt: Date.now(),
          profileId: attemptVaultContextRef.current?.profileId,
        });
        // Published BEFORE it is awaited — the same rule rawWriteRef follows. A
        // resume arriving mid-chain then awaits THIS chain rather than whatever
        // stale (already-settled) promise the ref happened to hold. Stored as a
        // never-rejecting derivative so a later attempt can't inherit this one's
        // failure; `historyWrite` itself is awaited below, so the rejection is
        // still handled exactly once.
        recordCaptureRef.current = historyWrite.catch(() => undefined);
        await historyWrite;
        // Re-checked: the two history awaits above are their own race window,
        // and clearing editingFilepath here would undo an Edit tapped during
        // them, sending the resubmit back through writeRawIdea.
        if (superseded()) return;
        setEditingFilepath(null);
        // Upsert (not invalidate) so Home's cards can show this note's tags
        // and pending-enrich stamp immediately — dropping the whole cached
        // index left cards bare until the next full vault scan.
        void upsertNoteInIndex(
          filepath,
          rawMarkdown,
          attemptVaultContextRef.current?.profileId,
        ).catch(() => undefined);
        setSavedFilepath(filepath);
        saveFirstCtxRef.current = ctx;
        // The capture is safely persisted — clear the inputs so a back-out
        // leaves nothing staged and the next capture starts fresh.
        clearStagedAttachmentsAndMeta();
        setText("");
        void clearDraft(mode, attemptVaultContextRef.current?.profileId ?? draftProfileId).catch(() => undefined);
        const outcome = await enrichIdeaInPlace({
          filepath,
          expectedMtime: mtime,
          // On SAF `mtime` is null, so the bytes just written are the baseline
          // the guard compares against — including after an Edit rewrote them.
          expectedContent: rawMarkdown,
          text: ctx.text,
          tags: ctx.tags,
          location: ctx.location,
          attachments: ctx.attachments,
          vaultContext: attemptVaultContextRef.current ?? undefined,
        });
        if (superseded()) return;
        await finishSaveFirst(outcome, ctx, filepath, mtime, rawMarkdown, superseded);
      } catch (e: unknown) {
        if (superseded()) return;
        // The raw write itself failed (disk/permission) — nothing was saved,
        // so keep the inputs and return the user to the form.
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase("input");
      }
      return;
    }

    if (mode === "journal") {
      const combined = [transcript, text].map((s) => s.trim()).filter(Boolean).join("\n\n");
      try {
        const result = await enrichJournal(
          { transcript: combined, notes: "" },
          { vaultContext: attemptVaultContextRef.current ?? undefined },
        );
        if (superseded()) return;
        const today = todayLocal();
        setPendingJournal({ date: today, markdown: result.markdown, model: result.model });
        setOmniModel(result.model);
        setResponse(buildCapturePreviewResponse(result.markdown));
        setPhase("preview");
      } catch (e: unknown) {
        if (superseded()) return;
        await handleCaptureError(e, async () => {
          const refs = await persistAttachments();
          await enqueue({
            mode: "journal",
            transcript: combined,
            notes: "",
            date: todayLocal(),
            attachments: refs,
            tags,
            location: location ?? undefined,
            places,
            vaultContext: attemptVaultContextRef.current ?? undefined,
          });
        }, superseded);
      }
      return;
    }

    // mode === "person"
    try {
      const result = await enrichPerson(
        { ocrResult: ocrText.trim(), context: text.trim() },
        { vaultContext: attemptVaultContextRef.current ?? undefined },
      );
      if (superseded()) return;
      const nameField = extractNameFromMarkdown(result.markdown);
      setPendingPerson({
        firstName: nameField.firstName,
        lastName: nameField.lastName,
        markdown: result.markdown,
        model: result.model,
      });
      setOmniModel(result.model);
      setResponse(buildCapturePreviewResponse(result.markdown));
      setPhase("preview");
    } catch (e: unknown) {
      if (superseded()) return;
      await handleCaptureError(e, () =>
        enqueue({
          mode: "person",
          ocrResult: ocrText.trim(),
          context: text.trim(),
          tags,
          location: location ?? undefined,
          vaultContext: attemptVaultContextRef.current ?? undefined,
        }),
        superseded,
      );
    }
  };

  const confirmSave = async () => {
    if (mode === "idea" && pendingIdea) {
      try {
        const refs = await persistAttachments();
        const { filepath, markdown, title } = await confirmSaveIdea({
          slug: pendingIdea.slug,
          markdown: pendingIdea.markdown,
          refs,
          tags,
          location,
          root: attemptVaultContextRef.current
            ? resolveContextRoot(attemptVaultContextRef.current)
            : undefined,
        });
        clearStagedAttachmentsAndMeta();
        setSavedFilepath(filepath);
        await recordCapture(
          { id: localId(), mode, title, filepath, createdAt: Date.now() },
          attemptVaultContextRef.current?.profileId,
        );
        void upsertNoteInIndex(
          filepath,
          markdown,
          attemptVaultContextRef.current?.profileId,
        ).catch(() => undefined);
        void clearDraft(mode, attemptVaultContextRef.current?.profileId ?? draftProfileId).catch(() => undefined);
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[confirmSave] idea failed:", msg, e);
        setError(msg);
      }
      return;
    }

    if (mode === "journal" && pendingJournal) {
      try {
        const refs = await persistAttachments();
        // A journal day-file accumulates every same-day capture into one note:
        // confirmSaveJournal returns the full accumulated markdown (appendJournal
        // unions this capture's tags into the file's frontmatter). Index off
        // THAT, not the just-written fragment — otherwise the upsert would
        // overwrite the note's index row with only this capture's tags,
        // silently dropping earlier same-day tags from the derived tag/search
        // index.
        const { filepath, markdown: dayFileMarkdown, title } = await confirmSaveJournal({
          date: pendingJournal.date,
          markdown: pendingJournal.markdown,
          refs,
          tags,
          location,
          places,
          root: attemptVaultContextRef.current
            ? resolveContextRoot(attemptVaultContextRef.current)
            : undefined,
        });
        clearStagedAttachmentsAndMeta();
        setSavedFilepath(filepath);
        await recordCapture(
          { id: localId(), mode, title, filepath, createdAt: Date.now() },
          attemptVaultContextRef.current?.profileId,
        );
        void upsertNoteInIndex(
          filepath,
          dayFileMarkdown,
          attemptVaultContextRef.current?.profileId,
        ).catch(() => undefined);
        void clearDraft(mode, attemptVaultContextRef.current?.profileId ?? draftProfileId).catch(() => undefined);
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[confirmSave] journal failed:", msg, e);
        setError(msg);
      }
      return;
    }

    if (mode === "person" && pendingPerson) {
      try {
        const { filepath, markdown, title } = await confirmSavePerson({
          firstName: pendingPerson.firstName,
          lastName: pendingPerson.lastName,
          markdown: pendingPerson.markdown,
          tags,
          location,
          root: attemptVaultContextRef.current
            ? resolveContextRoot(attemptVaultContextRef.current)
            : undefined,
        });
        clearStagedMeta();
        setSavedFilepath(filepath);
        await recordCapture(
          { id: localId(), mode, title, filepath, createdAt: Date.now() },
          attemptVaultContextRef.current?.profileId,
        );
        void upsertNoteInIndex(
          filepath,
          markdown,
          attemptVaultContextRef.current?.profileId,
        ).catch(() => undefined);
        void clearDraft(mode, attemptVaultContextRef.current?.profileId ?? draftProfileId).catch(() => undefined);
        setPhase("saved");
        navigation.goBack();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[confirmSave] person failed:", msg, e);
        setError(msg);
      }
    }
  };

  const promote = async (next: IdeaStatus) => {
    if (next === currentStatus || !pendingIdea) return;
    setError(null);

    try {
      const currentMd = response?.preview_markdown ?? pendingIdea.markdown;
      const result = await omniPromoteIdea(currentMd, next);
      const newSlug = slugify(deriveTitle(result.markdown)) || pendingIdea.slug;
      setPendingIdea({ slug: newSlug, markdown: result.markdown, model: result.model });
      setOmniModel(result.model);
      setResponse(buildCapturePreviewResponse(result.markdown, savedFilepath ?? undefined));

      // If file was already written, update it on disk — guarded by the mtime
      // check so a workstation edit synced in between our read and write is kept
      // rather than clobbered (closes the promote-idea race, TODO.md).
      if (savedFilepath) {
        const { conflict } = await promoteIdeaOnDisk(savedFilepath, next, result.markdown);
        if (conflict) {
          setError(
            "This note changed on disk — reopen it before promoting so your edits aren't lost.",
          );
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {phase === "input" && (
        <ModeInput
          mode={mode}
          text={text}
          onTextChange={setText}
          transcript={transcript}
          onTranscriptChange={setTranscript}
          ocrText={ocrText}
          onOcrChange={setOcrText}
          voiceRef={voiceRef}
        />
      )}

      {phase === "input" && (
        <>
          <CaptureActionBar
            metaSummary={metaSummary}
            onOpenMeta={() => setMetaOpen(true)}
            onSubmit={submit}
            canSubmit={canSubmit}
            queueDepth={queueDepth}
            error={error}
          />

          <CaptureMetaSheet
            visible={metaOpen}
            onDismiss={() => setMetaOpen(false)}
            tags={tags}
            onTagsChange={setTags}
            knownTags={knownTags}
            location={location}
            onLocationChange={setLocation}
            showPlaces={mode === "journal"}
            places={places}
            onPlacesChange={setPlaces}
            showAttachments={mode !== "person"}
            pending={pending}
            savedAttachments={savedAttachments}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
          />
        </>
      )}

      {phase === "submitting" && (
        <CaptureSubmittingView
          llmBackend={llmBackend}
          providerLabel={providerLabel}
          onEditInstead={() => void editInstead()}
        />
      )}

      {phase === "preview" && response && (
        <CapturePreviewCard
          subtitle={previewSubtitle}
          previewMarkdown={response.preview_markdown ?? ""}
          showStatusRow={mode === "idea"}
          currentStatus={currentStatus}
          onPromote={promote}
          showSource={showSource}
          onToggleSource={() => setShowSource((v) => !v)}
          onSave={confirmSave}
          error={error}
        />
      )}

      {phase === "saved" && (degradedReason || enrichNotice) && (
        <CaptureSavedCard
          degradedReason={degradedReason}
          enrichNotice={enrichNotice}
          savedFilepath={savedFilepath}
          onReEnrich={reEnrichSaved}
          onDone={() => navigation.goBack()}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
});
