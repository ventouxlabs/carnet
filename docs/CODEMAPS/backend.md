# Device Pipeline & Integrations
<!-- Generated: 2026-07-17 | Files scanned: ~152 (87 src + tests) | Token estimate: ~880 -->

The mobile app has no required HTTP server. Its "backend" is the **on-device enrichment +
persistence pipeline**, plus an opt-in **Karakeep export** REST client. `apps/mdcrm` is an
optional standalone file processor; it does not sit on the capture path and can be disabled.

## Optional Markdown processor — `apps/mdcrm`

The Node 20 CLI consumes schema-v1 Markdown captures through a filesystem adapter. Its
Phase 1 pipeline validates YAML and attachment hashes, acquires a lease, applies deterministic
normalization and contact scoring, emits contact/organization/event/interaction or review
records, records an idempotent processing job, and rebuilds a disposable full-text index.
It has no LLM or mobile-runtime dependency. See `docs/mdcrm/architecture.md`.

## Capture → vault  (mode → enrich → write)
```
Idea     CaptureScreen   → omniroute.enrichIdea     → writer.writeIdea      → Ideas/{slug}.md
Journal  CaptureScreen   → omniroute.enrichJournal  → writer.appendJournal  → Journal/YYYY-MM-DD.md
Person   PhotoCapture    → ocr → enrichPerson        → writer.writePerson    → People/F-L.md
Photo    PhotoCapture    → enrich (vision)           → writer.writeBinary    → Photos/{slug}.jpg
Audio    AudioCapture    → transcribe → enrichJournal → appendJournal
Share    ShareReceive    → enrichSharedImage / Link / raw file → writeIdea / writeBinary
                          (bytes read via the share's content:// grant —
                           shareHelpers.shareFileReadUri; raw file paths are
                           scoped-storage-unreadable)
```

## LLM client — `lib/omniroute.ts` (HTTPS, 674 ln)
`enrichIdea` `enrichJournal` `enrichPerson` `enrichSharedImage` `enrichSharedLink`
`transcribeAudio` `autoTranscribeIfEnabled` `promoteIdea` `listModels`
errors: `isNotConfiguredError` `isPermanentError`; `withSystemOverride` `assertBase`.

## Shared HTTP core — `lib/httpClient.ts` (118 ln)
The security surface BOTH network clients share (was hand-duplicated):
`HttpError` base (status + notConfigured; OmniRouteError/KarakeepError are thin
subclasses), `sanitizeErrorMessage` (THE canonical Bearer redactor — the queues
re-export it via asyncQueueUtils), `withTimeout(ms, makeTimeoutError, run)`,
unified `parseErrorBody`. Per-client: error names, user-facing messages, the
3-line HTTPS-or-LAN wrappers (policy lives in netAllowlist).

## Persistence — `lib/writer.ts` (~1000 ln) + `lib/vaultFs.ts` (243 ln)
Storage backends live behind the `VaultFs` seam (vaultFs.ts: SafFs/FileFs,
selected ONCE in resolveRoot / fsForUri) — writer.ts is branch-free logic on
top (collision naming, enumeration, archiving). SAF quirks the seam owns:
create-time rename (finalName from the URI actually created), decoded
safLastSegment names, throwing (non-idempotent) SAF delete. Test parity:
writer.test.ts (file://) + writerSaf.test.ts (SAF harness).
`listNoteFiles` excludes Syncthing `*.sync-conflict-*` copies;
`listSyncConflictFiles` enumerates them (lib/syncConflicts.ts pairs them —
Home banner + review dialog).
`writeIdea` `writeSynthesis` (Notes/{slug}.md — saved retrospective-query answers)
`writePerson` `writeBinary` `appendJournal` `updateNote` `moveToArchive`
`readNote` `listNoteFiles`; attachments `injectAttachments` `listPairedBinaries`
`resolvePairedUri` (read-only `findSubdir` — never creates dirs) `stripPairedBinaryLinks`;
`slugify` `personFilename` `mimeFromFilename`.
Frontmatter helpers live in `lib/frontmatter.ts` (byte-exact header preservation).

## Offline queue — `lib/queue.ts` (AsyncStorage, 321 ln)
`enqueue` → `drainQueue` (on reconnect); `getQueueDepth` `getAllQueueRows` `clearFailedRows`.
Both online (`confirmSave`) and offline (`processRow`) paths inject tags + location frontmatter.

## Pending-sync queue — `lib/pendingSync.ts` (227) · `pendingSyncRunner.ts` (79) · `hostReachability.ts` (43)
Karakeep exports that failed with status-0 (host unreachable — VPN/Tailscale down; never
4xx/5xx) queue as `{filepath, entryTitle}` pointers; the note body is re-read at drain
time. `drainPendingExports` takes INJECTED deps (unit-testable); runner binds settings +
`isHostReachable` (4s HEAD probe, ANY http response = up) + `exportNoteToKarakeep`.
Triggers: App.tsx cold start + AppState→active (30s throttle), Home banner Retry.
Distinct from `queue.ts` (raw captures awaiting enrichment) — do not merge.
Shared queue scaffolding (createLock/localId/sanitizeError) lives in
`lib/asyncQueueUtils.ts`.

## Karakeep export — `lib/karakeep.ts` (390) · `lib/karakeepExport.ts` (75) · `lib/karakeepAssetSync.ts` (76)
Opt-in REST client to a self-hosted Karakeep (`{url}/api/v1`, Bearer key, HTTPS-or-LAN).
`createTextBookmark` · `updateTextBookmark` (PATCH — re-export in place, 404→create) · `attachTags` ·
`uploadAsset` (multipart) · `attachAssetToBookmark`. Shared `karakeepFetch` core (hard timeout,
HTTPS enforce, Bearer redaction — mirrors omniroute hardening).
`karakeepExport.pushNoteAttachments` = incremental asset sync; `karakeepAssetSync.ts` keeps a
per-bookmark pushed-key record in AsyncStorage (skip already-synced, retry failed, no dups).
Driven from RecentDetailScreen "Send to Karakeep" via `lib/karakeepNoteExport.ts` (228 —
create-vs-update/404-recovery/tag+title derivation; failed outcome carries `unreachable`
for the pending-sync queue); `karakeepId` frontmatter gives idempotency. NOTE: the user's
server refuses non-image/PDF attachments (.txt/.docx confirmed) — handled as an
informational skip, not an error.

## Enrichment dispatch — `lib/dispatcher.ts` (B7 seam, COMPLETE)
ALL backend-divergent calls cross it now: the 6 enrich fns + predicates PLUS
`transcribeAudio` / `autoTranscribeIfEnabled` / `ocrCardViaVision` /
`listModels` / `askVault`. Screens/components import from dispatcher only;
payload caps (`assertBase64UnderLimit`, `MAX_*`) stay omniroute imports by design.
`askVault` (retrospective query) mirrors `enhanceProse` exactly — same
`resolveEnhanceProvider`, same `withFallbackChain`, same primary-attempt-only
model override — so it works against OmniRoute and a local Relais unbranched.
Prompts (`lib/prompts.ts`, tested): idea/journal emit `## Actions` as `- [ ]`
checkboxes, faithful-only, section omitted when none.
`buildRetrospectivePrompt` wraps EACH note body in its own `<USER_INPUT>` block
(every other prompt wraps a single capture) and runs bodies through `stripGuard`
/ titles through `stripTitle` — a hostile note must not be able to forge the
delimiters, open a header naming a real note in the bundle, and get a fabricated
claim attributed to it. Body brackets are deliberately kept (legitimate
cross-references); title brackets are stripped.

## Retrospective query — `lib/retrospective.ts` (pure, 209 ln)
Selection and presentation for "what have I been thinking about X?".
`orderCandidates` (body matches first, then Search's own order, deduped by uri —
it owns dedup, callers must not re-implement it) → `pickForRead` (`MAX_NOTES`) →
`vault.readNoteBodies` (bounded at `SCAN_CONCURRENCY`, abortable, frontmatter
stripped) → `packBodies` (`PER_NOTE_CHARS` / `TOTAL_BUDGET_CHARS`, skips
unreadable and empty bodies) → `dispatcher.askVault` → `sanitizeMarkdown` →
`normalizeLeadingMarkdown` → `resolveCitations`.
`resolveCitations` linkifies `[[Title]]` ONLY when the title is in the retrieval
set; anything else renders as its literal bracketed text, so an invented
citation is visible rather than a link to nowhere. It answers "does this note
exist?", never "did this claim come from it?" — that second property is what the
prompt-side delimiter stripping protects.
`normalizeLeadingMarkdown` is DISPLAY-ONLY; `buildSynthesisNote` saves real
markdown because Obsidian renders it natively (a test reads `writeSynthesis`'s
payload to keep those apart).
`lib/askExplainer.ts` (61 ln) gates the one-time remote-backend disclosure on
`isLocalProvider`; `carnet:askExplainerSeen:v1`.

## Vault subdir derivation — `lib/noteSubdirs.ts` (pure, zero imports, 45 ln)
`NOTE_SUBDIRS` / `NoteSubdir` / `parentSegment` / `subdirForUri`. Zero imports by
design: `vault.ts` pulls AsyncStorage at import time, so test mocks can import
the real `subdirForUri` instead of hand-copying it.
**The uri is authoritative wherever a decision turns on folder identity.**
`inferNoteMode` collapses every unrecognized parent to `"idea"`, which is fine
for display but wrong for the related-notes self-exclusion and for whether a
note has an in-place re-enrichment path — both read `subdirForUri`. The
`RecentDetail` label still shows "Idea" for a `Notes/` note; knowingly deferred,
since fixing it means a new `CaptureMode` variant and that type is declared
twice with different members (`storage.ts` vs `queue.ts`).

## Review-surface intelligence
- `lib/relatedNotes.ts` (pure) — lexical related-note scoring over the cached
  note index (tags > title terms > excerpt terms); RecentDetail's "Related"
  card. Self-exclusion is SAF-encoding-robust (decoded basename + subdir).
- `lib/startupTiming.ts` — cold-start budget tripwire (BOOT_TIMESTAMP_MS at
  first app-code import; Home's first mount reports; breach → console.warn
  which survives release stripping; see docs/smoke-test.md).

## On-device extras
STT `voice/VoiceButton.tsx` + `voice/recognizerSelect.ts`; STT onboarding `voice/sttReadiness.ts`
(en-model probe, code-12 dead-end) + `voice/sttOnboarding.ts` (proactive prompt logic);
card OCR `ocrCardViaVision()` in `lib/omniroute.ts` (chat-vision call; the standalone `/ocr`
client was retired in Stage 2 B2); on-device transcribe `lib/audioTranscribeOnDevice.ts`;
notifications `lib/captureNotification.ts`.

(`apps/desktop`, the Tauri placeholder stub, was deprecated and removed 2026-07-25 — see
`.claude/PRPs/plans/completed/desktop-fate.plan.md`.)
