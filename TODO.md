# Carnet — TODO

Tracking deferred v0.3 scope and known issues.

**Last reconciled against git history: 2026-09-08.** This file had drifted before (see
prior reconciliation history in git blame) — items were listed as deferred after they had
already shipped. When planning from it, re-verify anything you're about to act on (`git
log --oneline --all | grep -i <topic>`, or look for the module it names); a stale
"deferred" entry is worse than no entry.

## Resolved in v0.2

- [x] **Filename collision** — `writer.ts` appends `-2`, `-3` etc. on slug collision.
- [x] **Journal append separator with timestamp** — Each appended block is separated by `\n\n---\n<timestamp>\n\n` so multiple same-day entries are distinguishable.
- [x] **Mobile tokens in plaintext AsyncStorage** — `omniRouteApiKey` stored in `expo-secure-store`. Legacy navetted token cleared on migration.
- [x] **Desktop tokens in plaintext localStorage** — Stored in OS keychain via Tauri keyring commands.
- [x] **Connection status surfacing** — No longer relevant: no daemon to connect to. OmniRoute uses plain HTTPS; offline state is handled by the capture queue.
- [x] **navetted dependency** — Removed entirely. OmniRoute + Syncthing replaces the WS daemon architecture.

## Resolved in Stage 2 (2026-07-10)

Backend-generalization + capture-surface audit (`AUDIT-backend.md`, PR #62) → execution
plan (`.claude/PRPs/plans/stage2-backend-and-capture.plan.md`, branches B0–B7). All
branches shipped (B2 folded via `visionModel`, gate passed 2026-07-12).

- [x] **B3 — LLM markdown sanitizer + frontmatter normalizer** (PR #63) — `lib/enrichSanitize.ts`;
  neutralizes Dataview/Templater/script/`javascript:` injection in LLM output before it
  reaches the vault, without deleting legitimate user-authored code blocks or breaking
  inline images (#60). The dogfooding-safety gate.
- [x] **B0 — network-control hardening** (PR #64, hardened further by #69) — exact-host
  allowlist (`lib/netAllowlist.ts`) replacing prefix-regex matching; manual-redirect
  SSRF guard on URL preview fetches.
- [x] **B1 — per-task model split** (PR #65) — `omniRouteVisionModel` setting, distinct
  from the chat model, so a text-only model can never silently drop an image part.
  Resolves the vestigial `omniRouteTranscriptionModel` question below by repurposing it.
- [x] **B4 — save-first capture timing for Idea** (PR #66) — raw note saves immediately;
  enrichment updates it in place; net-new mtime conflict guard (also closes the
  promote-idea race noted below in "Resolved (carry-over from v0.1)").
- [x] **B5 — notification inline reply** (PR #71, fix #74) — RemoteInput "quick idea"
  action on the persistent capture notification; zero-app-open text capture, depends on
  B4's save-first path.
- [x] **B6 — vault browse + search, Phase 1** (PR #67) — supersedes "Mobile browse +
  search" below; note-metadata index (`carnet:noteindex:v1`, AsyncStorage) generalizing
  the tag-index pattern, new Search screen. Phase 2 (on-demand full-text) and Phase 3
  (retrospective query, below) remain separate later plans, now unblocked.
- [x] **B7 — pluggable on-device backend, Phase 1** (PR #72) — interface-only dispatcher
  seam (`lib/dispatcher.ts`) re-exporting the six enrich functions from the selected
  backend; `Settings.llmBackend` (default `"omniroute"`). No native code yet — this is
  the prerequisite the "On-device Gemma backend" item below now builds on.
- [x] **B2 — fold business-card OCR into chat vision** — done; folded via `visionModel`,
  gate passed 2026-07-12. The dedicated `POST {omniRouteUrl}/ocr` client (`lib/ocr.ts`) is
  retired; `CardScannerModal` now calls `ocrCardViaVision()` in `lib/omniroute.ts`, an
  `image_url` chat-vision call on the vision model. Side-by-side vs. the old Mistral `/ocr`
  endpoint on real cards matched (and beat it on stylized text).
- [x] **Screen-file decomposition** (`.agent_native/agent_roadmap.md` item #2, PRs #101–#103)
  — extracted business logic from the three oversized screen files into tested `lib/*.ts`
  modules: `CaptureScreen.tsx` 1175→798 lines, `RecentDetailScreen.tsx` 1599→1416,
  `SettingsScreen.tsx` 849→794 (smaller by design — mostly legitimate form UI, not hidden
  logic). 10 new modules, each behavior-preserving and independently code-reviewed.

## Resolved since Stage 2 (2026-07-18 → 2026-07-28)

- [x] **Browse/search Phase 2 — on-demand full-text body search** (PR #104) —
  `searchNoteBodies()` in `lib/vault.ts`, explicit-trigger only (not keystroke-driven),
  wired into `SearchScreen.tsx` with progress reporting. Was still listed as deferred
  below until this reconciliation. Phase 3 (retrospective query) remains open.
- [x] **Local-LLM backend** (PR #105) — `lib/localLlm.ts`, an OpenAI-compatible HTTP
  client for a loopback/LAN server (Relais by default), behind B7's `dispatcher.ts` seam
  with `Settings.llmBackend`. Mirrors `omniroute.ts`'s signatures and error-classification
  contract. This is the network-client path, **not** the native in-process model — see the
  re-framed Gemma item below.
- [x] **Minimal ESLint in `apps/mobile`** — exactly three rules, each mapped to a defect
  class that actually shipped here; scope change-controlled via
  `.claude/PRPs/plans/completed/minimal-eslint-scope.plan.md`. See CLAUDE.md before
  widening it.
- [x] **Local crash/error log** (PRs #106) — the app had zero crash telemetry; every
  defect in project history was found by manual `adb logcat` reproduction. `lib/crashLog.ts`
  (AsyncStorage ring buffer, capped, serialized writes, repeat-collapsing, size-clamped),
  `lib/crashReporting.ts` (chains RN's `global.ErrorUtils`; fatal writes flush before
  teardown), `components/CrashBoundary.tsx`, and Settings → Diagnostics. No server — see
  `.claude/PRPs/plans/completed/self-hosted-sentry.plan.md` for why hosted crash reporting
  was rejected.

## Deferred to v0.3

- [ ] **Auto-capture surfaces** — Android Quick Settings tile dropped from the roadmap
  (2026-07-04 decision): the persistent notification (shipped) + B5's inline-reply cover
  the same latency profile. iOS share extension and Android Auto remain open; Android
  share sheet is already shipped.
- [x] **Browse/search Phase 3 — SHIPPED 2026-09-08** (PR #207) — the retrospective query
  ("What have I been thinking about regarding X?"). **This closes the browse/search axis:
  Phases 1, 2 and 3 are all done.** Ask from Search over the notes currently on screen;
  `dispatcher.askVault` synthesizes an answer citing them with `[[wikilinks]]`; the answer
  is ephemeral until explicitly saved into a new `Notes/` subdir. Specified against the
  `dispatcher.ts` seam as this item required, so it works on OmniRoute and a local Relais
  unbranched. The v0.5 PRD gated this on "after S4's fate is known" — S4 shipped
  *lexically* (`relatedNotes.ts`, no embeddings), which satisfied that gate; do not
  re-open the embeddings question on the strength of the old text. Spec:
  `.claude/PRPs/prds/retrospective-query.prd.md`. **Not** the same as
  `enhance-source-citations.plan.md`, which is still blocked on an OmniRoute gateway
  change and concerns external URL annotations, not internal wikilinks.
  **Device-verified 2026-09-08** on a Pixel 9 Pro Fold (Android 17) against a real Syncthing
  vault with an on-device model: **all seven acceptance criteria pass**, including 6
  (not-configured error), 7 (local backend with `Active default network: none`) and the
  `<Text onPress>` citation taps that jsdom structurally cannot cover. Shipped in
  **v0.11.0**. Evidence and device-QA lessons:
  `docs/session-handoffs/2026-09-08-retrospective-query-shipped.md`.
- [ ] **Truncate long citation labels in a retrospective answer** — found on-device
  2026-09-08, after #207 shipped. `resolveCitations` renders a citation using the note's
  full title, which is correct but unreadable when titles are whole sentences (journal
  notes derive theirs from the first line). The prose becomes "…continuing to Colmar *My
  family traveled to France via Strasbourg after arriving from the US, while I completed
  another day of reserve duty.*." — plus a doubled period where the title's own full stop
  meets the sentence's. Truncate the link label (keep the full title as the resolution
  key, and keep `## Sources` unabbreviated). Small; touches `lib/retrospective.ts` +
  `AskScreen`. Not a correctness bug — the links resolve and the guard holds.
- [ ] **Bidirectional sync awareness** — Mostly works via Syncthing. A mobile file watcher to detect workstation edits is a v0.3 enhancement.
- [ ] **Card auto-detection** — Current button-press OCR flow works. Auto-detect when camera sees a business card is polish.
- [ ] **Cross-capture linking — largely superseded, narrow remainder.** The "you've thought
  about this before" intent is now served by `lib/relatedNotes.ts` (lexical scoring over the
  cached note index — shared tags + term overlap, no embeddings, no network), surfaced in
  `RecentDetailScreen` with wikilink insertion into a Related section. What remains of the
  original framing is specifically **Person ↔ journal associations via prompt-side
  linking** — i.e. having enrichment itself emit the link when a journal entry names a
  person, rather than the reader-side lexical surfacing that exists today. Re-scope before
  picking this up; it may not be worth doing separately.
- [ ] **Multi-vault support** — Single-vault solves the actual problem. Premature to add vault switching now.
- [x] **Desktop app fate** — Decided 2026-07-25: deprecate. `apps/desktop` (Tauri v2 stub,
  zero commits since 2026-06-04, zero tests, no usage signal) removed entirely, along with
  its CI job. See `.claude/PRPs/plans/completed/desktop-fate.plan.md` for the full
  rationale if desktop-capture demand ever resurfaces.
- [ ] **On-device Gemma backend, native phases — NEEDS A DECISION, not just execution.**
  This item's original framing is obsolete. It said the remaining work was "add a
  `localLlm.ts` sibling behind the seam"; that file now exists (PR #105, above), but as an
  **HTTP client to a local server** rather than an in-process native model. So
  disconnected/no-internet enrichment — the actual goal — is already solved via Relais on
  the same device. What's genuinely unstarted is only the native module + bundled model
  download (~1.5GB model file, ~3-8s first token on phone, battery cost).
  **Before building any of it, decide whether it's still worth it**: Relais already
  delivers the user-visible benefit with none of the app-size or native-maintenance cost,
  and it is a separate app with its own repo (`~/Documents/vibe-code/relais`) that can be
  updated independently. Skip the workstation Ollama variant regardless: it re-introduces
  the daemon dependency v0.2 deliberately removed.
- [x] **Encrypt offline queue payloads at rest** (PR #111) — `carnet:queue:v1` and
  capture drafts (`captureDraft.ts`, found in review to carry the same PII classes and
  brought into scope) are now sealed with AES-256-CBC + encrypt-then-MAC (HMAC-SHA256,
  verified before decrypt), keyed from `expo-secure-store` (Android Keystore). Deviates
  from the original AES-GCM-via-`expo-crypto` sketch: `expo-crypto` ships no cipher at
  all, only digests/random bytes — `crypto-js` supplies the cipher (no native AES-GCM
  available), `expo-crypto` supplies entropy (Hermes exposes no `globalThis.crypto`).

## Deferred (carry-over from v0.1)

- [ ] **Person camera capture pipeline** — `CardScannerModal` (opened from `CaptureModeInput`) wires up `expo-camera` → `ocrCardViaVision()` (in `lib/omniroute.ts`; the standalone `lib/ocr.ts` `/ocr` client was retired in B2). The button is present; the full pipeline needs integration testing on device.
- [x] **Slugify Unicode edge cases** (PR #145) — `slugify()` now NFD-decomposes and
  strips the combining-mark range, folding any Latin-script diacritic (Polish, Czech,
  Vietnamese, Turkish, not just the old hand-listed French set), plus a small
  `SPECIAL_FOLDS` map for ligatures/stroke-letters decomposition can't reach (`ß`, `æ`,
  `ø`, `ł`...). Non-Latin scripts (Cyrillic, CJK, Arabic) still yield `""` and fall back
  to the generic stem — deliberate, since preserving those characters would change
  on-disk filename encoding (Syncthing NFC/NFD, Obsidian links, exFAT).
- [x] **Settings: live connection test — OmniRoute side only** (PR #138) — was actually a
  regression, not a gap: `healthCheck` probed `GET /health` with no auth header for every
  provider, but only Relais serves `/health`; OmniRoute-style gateways serve only `/v1/*`,
  so Test Connection reported "Unreachable" while real enrich/enhance calls succeeded
  fine. Fixed by probing `GET /v1/models` with the Bearer key instead — the same request
  `listModels` already makes, so it validates the key too, not just the host, and adds a
  distinct `unauthorized` result for a rejected key.
- [x] **Promote-idea race condition** — Closed by the B4 mtime conflict guard (`writer.ts` `getModificationTime` + `updateNoteIfUnchanged`). Promote now records the file's `modificationTime` before its read-modify-write and re-checks it before the overwrite; a Syncthing/workstation edit that landed in between is kept (write skipped) and a conflict message is surfaced in `CaptureScreen`. The same guard backs the save-first Idea enriched overwrite and the offline-drain in-place update.
