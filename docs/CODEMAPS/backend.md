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
`listModels`. Screens/components import from dispatcher only; payload caps
(`assertBase64UnderLimit`, `MAX_*`) stay omniroute imports by design.
Prompts (`lib/prompts.ts`, tested): idea/journal emit `## Actions` as `- [ ]`
checkboxes, faithful-only, section omitted when none.

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
