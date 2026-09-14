# Remaining Roadmap Delivery — Implementation Plan

Status: in-progress

**Approved:** 2026-09-13

**Goal:** Deliver the remaining Android/JavaScript roadmap safely, with an
implementation-ready iOS share-extension package. Local/offline inference stays
with Relais; native in-app Gemma is explicitly not a feature.

## Decisions and boundaries

- **Relais is the local LLM backend.** Do not add a bundled native Gemma runtime,
  model download, or model-management UI.
- **iOS is preparation only.** This Linux workspace has neither Xcode nor an
  Apple signing/device environment. Documentation and shared contracts may be
  shipped; an iOS extension binary must not be claimed as delivered.
- **Android Auto has an eligibility gate, not a fake implementation.** A generic
  note capture app may not claim a cars category it does not meet. Before adding
  a `CarAppService`, record whether a legitimate supported category/mechanism
  exists. If it does not, publish the assessment and a separately scoped
  phone-side voice-capture alternative.
- **One active vault at a time.** A profile is `{ id, name, rootUri }`; provider
  credentials and device preferences remain global, while history, drafts,
  indexes and capture destinations are vault-scoped.
- **No storage watcher promise.** SAF cannot provide a dependable portable
  watcher. Foreground/focus and explicit refresh perform throttled reconciliation.
- **No silent writing.** Card detection follows an explicit photo; a user confirms
  before OCR or a durable capture package is written. Person/journal links are
  explicit and idempotent.

## Delivery order

```
citation labels ─────────────────────────────────────── independent
multi-vault storage/migration → operation pinning → vault refresh
                                             └──────→ person/journal links
card orchestration → card classification/confirmation
platform eligibility + iOS preparation ──────────────── independent docs gate
```

Each implementation phase is a reviewable commit/PR boundary. Dependent work
stays on the program branch until its foundation is merged; work is never merged
automatically. Every PR receives an independent devil's-advocate review and
must pass the repository gate.

## Phase 1 — Retrospective citation labels

**Touch points:** `apps/mobile/src/lib/retrospective.ts`,
`retrospective.test.ts`, `screens/AskScreen.tsx`, and `AskScreen.test.tsx`.

Add a presentation label separate from the canonical citation title/URI. It is
word-aware, bounded, Unicode-safe and ellipsized; it removes terminal punctuation
from an inline label so surrounding prose does not show a doubled full stop.
Resolution keys, accessibility labels, saved synthesis Markdown, and `## Sources`
retain the full title.

**Acceptance:** short labels are unchanged; an unknown wikilink remains inert;
a long valid citation retains its original URI and full accessible name; and a
long citation remains tappable on Pixel 9.

**Tests:** exact threshold, over-limit, long unbroken and Unicode labels,
punctuation, inert citations, full Sources output, and screen navigation.

## Phase 2 — Multi-vault foundation and safe operation pinning

**New modules:** `lib/vaultProfiles.ts`, `lib/vaultContext.ts`, and, if needed,
`lib/vaultStorageKeys.ts`, each with focused tests.

**Audit/modify:** `settings.ts`, `vaultRoot.ts`, `storage.ts`, `captureDraft.ts`,
`queue.ts`, `vault.ts`, `vaultTagHint.ts`, `writer.ts`, `pairedBinaries.ts`,
`mdcrmCapturePackage.ts`, `vaultMigration.ts`, `settingsTransfer.ts`,
`pendingSync.ts`, `SettingsScreen.tsx`, `CaptureScreen.tsx`, `App.tsx`, and
affected screens/tests.

Migrate the existing `captureFolderPath` to a default profile without moving any
vault files. Migrate legacy history, drafts, caches and queued captures to that
profile once and idempotently. All capture/save/queue/package operations capture
an immutable vault context at their start; changing A to B during a slow LLM
request must not write its eventual note or attachments to B. A three-file card
package must resolve one root once, rather than re-resolving the active root for
each file. Profile removal removes only the registration, never the user files,
and cannot orphan pending captures.

**Acceptance:** A→B→A isolates history/drafts/indexes; no ordinary switch moves
or deletes files; old async results do not populate the new vault UI; legacy queue
items cannot drain to the current-but-wrong vault; and settings transfer never
claims to transfer another device's SAF grant.

**Tests:** clean/legacy/corrupt and interrupted migration; duplicate titles in
two roots; delayed capture/index completion across a switch; queued Idea, Journal
and Person jobs; card and binary packages; revoked grants/removal recovery;
frontmatter byte preservation; bounded cache eviction; and restart persistence.

**Device gate:** use two disposable Pixel vaults, switch while Relais enrichment
is pending, inspect note/attachment roots, restart, and verify isolation.

## Phase 3 — Vault-sync awareness

**New module:** `lib/vaultRefreshCoordinator.ts`, injected with scanner and clock,
with an observable `idle | refreshing | current | stale | unavailable` status.

**Touch points:** `vault.ts`, writer enumeration/error contracts, `App.tsx`,
`HomeScreen.tsx`, `SearchScreen.tsx`, `TagBrowserScreen.tsx`, `TodosScreen.tsx`
and their tests.

On app foreground, relevant screen focus and manual refresh, reconcile in the
background with a throttle and one scan per vault. Cached results render first;
capture never waits. Retain the last successful cache on broad root failure and
report stale/unavailable instead of replacing it with an empty vault. Refresh
updates index consumers but never turns external Syncthing files into capture
recents or silently reloads a dirty editor.

**Tests:** focus storms/throttling, single-flight/retry, external add/edit/delete,
empty vs inaccessible roots, partial reads, local upsert racing a scan,
profile-generation changes, and unmount cleanup.

**Device gate:** modify/add/delete through Syncthing, foreground the app, verify
Search/tags/todos refresh; revoke then restore the picked-folder grant without
clearing app data.

## Phase 4 — Business-card detection and camera contract

**Touch points:** `components/CardScannerModal.tsx`, `screens/PhotoCaptureScreen.tsx`,
`components/CaptureModeInput.tsx`, `lib/cardScanOutcome.ts`,
`lib/mdcrmCapturePackage.ts`, `lib/dispatcher.ts`, `lib/llmClient.ts`,
`lib/prompts.ts`, provider tests and new component/orchestration tests.

Extract the current flow to a tested state machine. After an intentional photo,
the configured vision provider returns `card`, `not-card`, or `uncertain` through
the dispatcher. The classifier requests classification only; it is not continuous
camera surveillance. A card suggestion offers **Use as business card**. Only that
confirmation permits saving the original capture package and running OCR. The
existing lossless save-first-after-confirmation behavior remains: OCR failure
returns the saved original/raw sidecar and a recovery outcome. Manual entry remains
available for a non-vision Relais model, an unavailable provider, or an uncertain
classification.

**Tests:** permission/preflight states, missing camera/base64/oversize input,
classifier malformed/negative/uncertain/timeout paths, no OCR/write before confirm,
cancel/retake races, double-confirm idempotence, save failure, OCR transient and
permanent failure, raw OCR preservation, package hash/original-byte consistency,
and origin-vault pinning.

**Physical gate:** on Pixel 9, photograph a supplied business card and a non-card;
verify the route, confirmation, original JPEG, OCR sidecar, capture record and
resulting Person note. If no physical card is available, this remains pending—not
simulated as passed.

## Phase 5 — Explicit Person ↔ journal linking

**New module:** `lib/personJournalLinks.ts`.

**Touch points:** `noteRelated.ts`, `relatedNotes.ts`, a related-links component,
`RecentDetailScreen.tsx`, vault reading/writing seams, and fixture/screen tests.

When viewing a Person note, perform bounded cancellable reads of active-vault
journal bodies to find a full-name match; cached excerpts alone are too short.
Show journal date/excerpt and an explicit action that adds the selected canonical
journal wikilink to the Person note. One-file write plus Obsidian backlinks avoids
a brittle two-file transaction.

**Acceptance/tests:** Unicode case/word boundaries, no first-name or substring
false positive, same-name ambiguity, malformed dates, duplicate labels at distinct
URIs, existing normal/aliased links, write conflict, deleted file/read failure,
switch cancellation, frontmatter/Related-section preservation, and repeated action
idempotence. Pixel verification inserts a fixture link twice and inspects the
exact resulting Markdown.

## Phase 6 — Platform preparation and eligibility

### Android Auto — Drive Inbox self-messaging pilot

**Approved re-scope (2026-09-13):** implement one driver-safe self-conversation,
not ordinary note browsing and not a media claim. A reply creates an immutable
capture request; mark-as-read updates local conversation state. Enrichment and
vault writes happen off the car UI.

Use source-owned Android code plus Expo prebuild/config, `MessagingStyle`, reply
and mark-read actions, and a tested bridge into the capture queue. Add Android
unit/instrumentation coverage and Desktop Head Unit evidence. No broad
distribution claim: templated messaging has restricted distribution and Play may
reject a self-only conversation model. `docs/android-auto-eligibility.md` is the
product contract and release gate.

### iOS share extension preparation

Create `docs/ios-share-extension.md`, covering App Group inbox ownership,
security-scoped bookmarks, text/URL/image/file normalization into the capture
envelope, idempotent main-app consumption, large-file and enrichment handoff,
duplicate/interrupted delivery, unavailable vaults, entitlements/signing, and the
macOS/Xcode/Apple-device matrix. A shared pure envelope validator is permitted
only if an existing Android/share caller uses it. No unsupported Apple signing
values or Linux-produced iOS binary will be represented as shipped.

**Completed preparation (2026-09-13):** `docs/ios-share-extension.md` contains
the handoff contract, test matrix, and the explicit environment prerequisites.

## Verification and completion

For every implementation PR: targeted unit/component/integration tests; full
mobile typecheck, lint and test suites; affected workspace checks; release build;
CI gate; independent review; and artifact/device evidence. Tests protect behavior,
not merely code paths. Native-device-only and physical-input evidence is tracked
separately and cannot be replaced by mocks.

The plan moves to `completed/` only after all implementation phases, documented
platform gates, review repairs, CI identities and outstanding physical evidence
are recorded.
