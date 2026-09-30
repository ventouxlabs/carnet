# CLAUDE.md — Carnet

Mobile-first knowledge capture for Obsidian. Android app (Expo/React Native) writes plain
Markdown into a Syncthing-watched folder. **No server, no database** — the vault (plain
files) is the source of truth. (A Tauri desktop stub existed as a placeholder from
2026-05 through 2026-07 and was formally deprecated and removed 2026-07-25 —
`.claude/PRPs/plans/completed/desktop-fate.plan.md` — after seven weeks with zero commits,
zero tests, and no usage signal; see that doc if desktop capture demand ever resurfaces.)

Read first, in this order, before making changes:
1. This file (build/test commands, hard constraints).
2. `docs/CODEMAPS/architecture.md` (+ sibling `backend.md`/`frontend.md`/`data.md`/
   `dependencies.md`) for layout and data flow.
3. `DESIGN.md` **before any visual/UI change** — it owns color/typography/spacing tokens
   and has its own "For AI tooling" rules section; do not restate or fork those rules here.
4. `TODO.md` for what's deliberately deferred (don't "fix" deferred scope without checking).
5. `.claude/PRPs/` for the plan → execute → report → review pipeline already in use
   (every `*.plan.md` directly under `plans/` needs a `Status: draft|in-progress|shipped`
   header, and a `shipped` one must be moved to `plans/completed/` — enforced in CI by
   `scripts/check-stale-plans.sh`, because stale plans describing already-shipped work
   have cost a full human audit cycle before), and
   `docs/session-handoffs/` for the latest cross-session state.

## Workspaces (npm workspaces monorepo)
- `apps/mobile` — Expo SDK 54 / React Native 0.81 / TypeScript — the primary surface.
- `packages/shared` (`@carnet/shared`) — TS types + markdown helpers used by `apps/mobile`.
  Build this first: mobile imports it directly.

## Commands (verified against package.json — do not invent others)
```bash
npm ci                      # install (root)
npm run build:shared        # build @carnet/shared — required before mobile work
npm run mobile               # expo start (Metro dev server)

npm -w @carnet/mobile run typecheck   # tsc --noEmit (apps/mobile)
npm -w @carnet/mobile run lint        # eslint (apps/mobile only — 3 rules, see below)
npm -w @carnet/mobile test            # vitest run (apps/mobile)
npm -w @carnet/mobile run verify:capture-flow  # fixture-backed capture-flow subset (fast repro gate)
npm -w @carnet/mobile run android              # build + run debug app on attached device
npm -w @carnet/mobile run android:release      # build + install release-signed APK
npm -w @carnet/shared run typecheck   # tsc --noEmit (packages/shared)
npm -w @carnet/shared test            # vitest run (packages/shared)
```
Lint exists ONLY in `apps/mobile` and is **deliberately minimal — exactly three
rules** (`react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps` as warn, typed
`@typescript-eslint/no-floating-promises` with `ignoreVoid`), each mapped to a defect
class that actually shipped here; scope was change-controlled via
`.claude/PRPs/plans/completed/minimal-eslint-scope.plan.md` (approved 2026-07-18).
**Do not widen the rule set, add stylistic/formatting rules, or lint shared without the
same scope discussion.** Gates per workspace remain `tsc --noEmit` + vitest (+ this lint,
in the `mobile` CI job).

`npm ci`/`npm install` runs a `postinstall: patch-package` hook — see `patches/`. Two
patches, both fixing real, on-device-reproduced upstream native-Kotlin crashes:
- `expo-speech-recognition+3.1.3.patch` — `PromiseAlreadySettledException` in
  `getSupportedLocales` when a recognizer package fires both `onSupportResult` and a
  duplicate `onError` (observed with `com.google.android.tts`).
- `expo-share-intent+5.1.1.patch` — `getFileInfo` hard-crashed the whole app ("Carnet
  keeps stopping" loop) on any share whose content URI it couldn't read: unguarded
  `query(...)!!` → SecurityException, and an empty cursor →
  CursorIndexOutOfBoundsException, both in `OnNewIntent` on the main thread (observed
  2026-07-14, Android 17). The patch makes metadata gathering best-effort and defaults a
  missing MIME type to `application/octet-stream` (the library's own JS parser calls
  `mimeType.startsWith` unguarded, so a null would silently drop the share).

If bumping either dependency, re-verify its patch still applies (`npx patch-package
<pkg> --exclude 'android/build/'` regenerates it) — don't silently drop them, the
crashes are real and reproducible.

## CI (`.github/workflows/ci.yml`)
Four jobs: `shared` → `mobile`, `mobile-android` (parallel, both
`needs: [shared]`) → `gate` (`needs: [shared, mobile, mobile-android]`,
required by branch protection). (A `desktop` job existed here through
2026-07-25, gating `apps/desktop`; removed along with that package — see
`.claude/PRPs/plans/completed/desktop-fate.plan.md`.) `mobile-android` (Expo prebuild +
`gradlew :app:compileDebugKotlin`) catches native Kotlin regressions in
`apps/mobile/plugins/*.js` config plugins; it was promoted into `gate.needs` on
2026-07-09 after three consecutive green runs (PRs #94–#96). If its Android
toolchain setup ever turns flaky and blocks unrelated merges, demoting it is a
one-line revert in `gate.needs` — note it in the job's in-file comment if so.
A sixth job, `apk` (advisory, not in `gate.needs`), attaches a release-signed
installable APK to every run's Artifacts (14-day retention) — signed with the
shared release keystore (repo secrets `CARNET_KEYSTORE_*`; local mirror at
`~/.config/carnet/keystore.properties`, consumed by
`apps/mobile/scripts/build-release-apk.sh`). Debug-signed installs can't
upgrade to release-signed ones — uninstall once to cross over (see the
script header for the data-loss caveat). `mobile-android` and `apk` (and
`release.yml`, below) all share one Android toolchain setup via the
`.github/actions/android-toolchain` composite action (checkout → Node → JDK →
Android SDK → Gradle → `npm ci` → shared build → clean Expo prebuild) — edit
it once rather than the three call sites.

## Releases (`.github/workflows/release.yml`)
Push a tag matching `v*.*.*` (`git tag v0.3.0 && git push origin v0.3.0`) to
build a release-signed APK and publish it as a GitHub Release with the APK
attached (`carnet-vX.Y.Z.apk`), release notes auto-generated from merged PRs
since the last tag. Unlike the advisory per-PR `apk` job, this workflow
**fails loudly** rather than falling back to debug signing if
`CARNET_KEYSTORE_BASE64` is unset, and independently verifies the built APK's
certificate SHA-256 matches the known release fingerprint before publishing —
a signingConfig misconfiguration must never ship as a silently debug-signed
"release." Re-runs `tsc --noEmit` + `vitest run` first as a safety gate,
since a tag can point at any commit, not necessarily one `main`'s CI already
vetted. The expected cert SHA-256 is a literal in the workflow file
(intentional — it's public, not a secret, and pinning it in a reviewed file
means rotation is change-controlled); if the keystore is ever rotated, that
literal must be updated in the same PR — expect it in the diff, it isn't
tampering.

## Hard constraints (non-negotiable — from `docs/session-handoffs/`)
- **App id is `com.ventouxlabs.carnet`** (renamed from `com.ventoux.carnet` on 2026-08-03).
  `apps/mobile/app.json` is the single source of truth — the config plugins and
  `scripts/verify-*-prebuild.sh` all derive the package from `expo.android.package`, so
  **never hardcode it** anywhere else. Android treats a changed package id as a *different
  app*: an existing install cannot upgrade in place, and uninstalling to cross over clears
  AsyncStorage, the offline queue, and every `expo-secure-store` key. Archived plans and
  dated session handoffs still say `com.ventoux.carnet` — that is correct history, not drift.
- **No SQLite.** `expo-sqlite@55` was ABI-broken on Expo SDK 54 and the dependency was
  removed entirely in 2026-08 (#182) — do not re-add it. All persistence goes through
  AsyncStorage (`lib/queue.ts`, `lib/storage.ts`).
- **No `.env` files anywhere.** All runtime config (OmniRoute URL/key, Karakeep URL/key) is
  entered in-app via the Settings screen. API keys live in `expo-secure-store`, never
  AsyncStorage/localStorage in plaintext.
- **Frontmatter must stay byte-compatible** with existing Obsidian vault files — verify
  against `lib/frontmatter.ts` and its tests before changing serialization.
- **Attribution is disabled in commits** (configured globally) — don't add co-author trailers.
- Branch from `main`; conventional commits (`feat`/`fix`/`refactor`/`docs`/`test`/`chore`/
  `perf`/`ci`); **squash-merge** is this repo's convention; PR to `main`.
- Fix the implementation, not the test, unless the test itself is wrong.

## Reproducing bug reports
A fixtures/repro harness exists (agent_roadmap item #1, built 2026-07-08):
`npm -w @carnet/mobile run verify:capture-flow` runs the capture-flow test subset
(writer/frontmatter/queue/vault/search/journal-tag-index/WYSIWYG round-trip, plus the
save-first routing/save-first/finish-enrichment/capture-display suites) plus
`test/fixtures/repro.test.ts` against real vault fixtures in
`apps/mobile/test/fixtures/vault/`. Reproduce capture-flow bugs by adding a fixture +
case there, or a targeted vitest against the relevant `lib/*.ts` module (`writer.ts`,
`llmClient.ts`, `queue.ts`, `frontmatter.ts` are the usual suspects) — not by running the
full Expo/Android stack. `docs/smoke-test.md` is the manual, device-based checklist for
anything that can't be reproduced this way (voice/OCR/native share-sheet/Syncthing).

## Structural notes for agents
- `apps/mobile/src/lib/**` is well-factored: small, single-purpose modules, each with a
  co-located `*.test.ts` (~1850 tests across the repo). Follow this pattern for new logic.
- Several files exceed this project's 800-line norm. **These numbers go stale fast** —
  decomposition PRs pull them down, then new features push them back up, so `wc -l` the
  file rather than trusting a count written here. As of 2026-08-17 the over-800 set is
  `voice/VoiceButton.tsx` (~1172), `screens/CaptureScreen.tsx`
  (~970), `screens/RecentDetailScreen.tsx` (~809). Note CaptureScreen and
  RecentDetailScreen were previously brought *under* 800 by the #88/#89/#90 decomposition
  work, grew back with new features, and were decomposed again in 2026-08 (#163/#164;
  RecentDetailScreen dipped to 783 and immediately re-crossed to ~809 when the #165
  busy-latch bug fix added its guards — a textbook run of this cycle; CaptureScreen
  stopped at ~970 because the remainder is one race-guarded submit state machine pinned
  by its tests; VoiceButton was decomposed from ~1534 in the same wave and stopped at
  ~1172 because the remainder is the mutually-recursive recognizer/failover state machine
  (startRecognizerRef ↔ triggerDetectionRef) whose decidable logic already lives in the
  eight `voice/*.ts` modules) — that is the expected cycle, not a regression to revert;
  the point is the extraction pattern, not the number. **Seven of 9 screens have
  `*.test.tsx` coverage**
  today (CaptureScreen, HomeScreen, RecentDetailScreen, SearchScreen, SettingsScreen,
  ShareReceiveScreen, TagBrowserScreen) — jsdom + @testing-library/react smoke tests
  rendering the real component tree under `PaperProvider` (pattern: see
  `TagBrowserScreen.test.tsx`). This is smoke-level coverage (happy paths plus a handful
  of regression guards), not exhaustive per-branch testing. When touching these files,
  prefer extracting the non-UI logic into a new `lib/*.ts` module with its own tests (as
  `lib/ideaSaveFirst.ts` and `lib/journalTagIndex.ts` already do) over adding more inline
  logic — screen-level tests are for wiring/rendering, not a substitute for unit-testing the
  extracted logic. See `.agent_native/agent_roadmap.md` item #2 for the full list.
- `packages/shared` has no circular dependencies on the apps; keep it that way.

## Where deeper agent-native audit findings live
`.agent_native/agent_roadmap.md` — prioritized gaps (verification, reproduction,
structure) with acceptance criteria, ranked by human-attention saved per unit of effort.
