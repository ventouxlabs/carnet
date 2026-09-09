# Data Model — vault & local stores
<!-- Generated: 2026-09-08 | Files scanned: 308 (171 src + 137 tests) | Token estimate: ~560 -->

**No canonical SQL database.** Data = Markdown files + binaries in the Syncthing-synced
vault, plus AsyncStorage/SecureStore keys on the device. (`expo-sqlite` is ABI-broken on
SDK 54 — hard constraint, see CLAUDE.md.) The optional `mdcrm` processor also treats
Markdown as canonical; `indexes/full-text.json` is derived and rebuildable.

## Vault layout  (`{captureFolderPath}` on device ↔ `~/Obsidian/Carnet` on workstation)
```
Ideas/{slug}.md          IdeaNote        (status in frontmatter; save-first writes stub
                                          then enrichment patches — B4)
Journal/YYYY-MM-DD.md     JournalEntry    (one day file; same-day captures appended)
Notes/{slug}.md           synthesis note  (saved retrospective-query answer, cites other notes)
People/F-L.md             PersonNote      (card scan → ocrCardViaVision → person enrich)
Photos/{slug}.jpg         image binaries
Attachments/…             paired files (embedded from notes via ../Subdir/file)
```
If `captureFolderPath` is blank (fresh install), writes land in app-private
`files/carnet/` — configure the vault folder in Settings for Syncthing to see them.

## Frontmatter — `lib/frontmatter.ts` (347 ln) — BYTE-COMPATIBILITY IS A HARD CONSTRAINT
`parseFrontmatter` `upsertFrontmatterField`; tags `getFrontmatterTags`/`setFrontmatterTags`
(+ `normalizeTag`); `location: "lat,lon"`; `karakeepId` stamped on export for idempotent
re-export. Byte-exact `split`/`extract`/`strip`/`rewriteFrontmatterField` preserve header
bytes (same-day journal append merges per-entry metadata into the day file).
LLM output passes `lib/enrichSanitize.ts` (B3) before any write.

## Shared types — `packages/shared/src` (index 14 · markdown 41 · types 47 ln)
`types.ts`: `IdeaNote` `IdeaStatus` `JournalEntry` `PersonNote` `CaptureResponse`
`CaptureStatus`. `markdown.ts`: `parseStatusFromMarkdown` `deriveTitle`.

## Local stores
- Settings blob — `lib/settings.ts` (`carnet:settings:v2`, AsyncStorage); API keys
  (OmniRoute, Karakeep) in SecureStore, never in the blob
- Offline queue rows — `lib/queue.ts` (`carnet:queue:v1`)
- Pending Karakeep exports — `lib/pendingSync.ts` (`carnet:pendingsync:v1`; filepath
  pointers only, note body re-read at drain; deduped by filepath, 10-attempt cap)
- Capture drafts — `carnet:capture_draft:v1:{mode}` (survives app restarts)
- Note/tag index cache — `lib/vault.ts` (`carnet:noteindex:v1`; scans Ideas/Journal/
  Notes/People with bounded concurrency; feeds Search + TagBrowser + `suggestTags`)
- Karakeep pushed-asset record — `lib/karakeepAssetSync.ts` (`carnet:karakeep-assets:v1:<id>`)
- STT onboarding flag — `voice/sttOnboarding.ts`; recognizer pkg/label —
  `stt_recognizer_pkg/label` (AsyncStorage; session failover state is in-memory only)
- Persistent-notification toggle mirrored to native SharedPreferences (BootReceiver)

## Caveat
App reinstall/`pm clear` wipes ALL local stores (settings, index, SecureStore) but not
the vault folder itself — vault files are re-indexed on next launch.

## Schema-v1 interchange records

`apps/mdcrm/schemas/` defines capture, contact, organization, event, interaction, task,
review-item, processing-job, and proposed-change frontmatter. Runtime records use immutable
prefixed ULIDs and live under `captures/`, `contacts/`, `organizations/`, `events/`,
`interactions/`, `tasks/`, `review/`, and `processing/`. These are an additive interchange
format; current mobile `People/`, `Ideas/`, and `Journal/` output is unchanged.
