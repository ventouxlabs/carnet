# Contributing to Carnet

Carnet is an **npm-workspaces monorepo**: an Expo / React Native Android app
(`apps/mobile`) and shared TypeScript (`packages/shared`). See
[CODEMAPS/architecture.md](CODEMAPS/architecture.md) for the layout. (A Tauri desktop
companion, `apps/desktop`, existed as a placeholder stub and was deprecated/removed
2026-07-25 — see `.claude/PRPs/plans/completed/desktop-fate.plan.md`.)

## Prerequisites
- **Node.js 20** (matches CI)
- **npm** (the repo uses workspaces + `npm ci`)
- Android release builds: **Android SDK** (`ANDROID_HOME`), a JDK, and an attached device/emulator

## Setup
```bash
npm ci
npm run build:shared   # build shared first — mobile imports @carnet/shared
```

## Scripts
<!-- AUTO-GENERATED:scripts -->
**Root**
| Command | Description |
|---|---|
| `npm run build:shared` | Build `@carnet/shared` (run before mobile) |
| `npm run mobile` | Start the Expo dev server (Metro) |
| `npm run mdcrm:build` | Build `@carnet/mdcrm` (the optional Markdown processor) |
| `npm run mdcrm:test` | Vitest for `@carnet/mdcrm` |
| `npm run mdcrm -- <args>` | Run the mdcrm CLI (note the `--` before its arguments) |
| `postinstall` (automatic) | `patch-package` — applies `patches/*.patch` (expo-speech-recognition, expo-share-intent); runs on every `npm ci`/`install` |

**apps/mobile**
| Command | Description |
|---|---|
| `npm -w @carnet/mobile start` | `expo start` (Metro dev server) |
| `npm -w @carnet/mobile run android` | Build + run the debug app (`scripts/run-android.sh`) |
| `npm -w @carnet/mobile run android:release` | Build + install the release APK (`scripts/build-release-apk.sh`) |
| `npm -w @carnet/mobile run ios` | `expo run:ios` |
| `npm -w @carnet/mobile run typecheck` | `tsc --noEmit` |
| `npm -w @carnet/mobile run lint` | ESLint — deliberately minimal 3-rule scope (hooks correctness + typed no-floating-promises); see CLAUDE.md before widening |
| `npm -w @carnet/mobile test` | Vitest suite |
| `npm -w @carnet/mobile run verify:capture-flow` | Automated equivalent of `docs/smoke-test.md`'s capture-flow checks — 13 suites: writer/writerMarkdown/pairedBinaries/noteNaming/mimeTypes/frontmatter/queue/vault/vaultSearch/journalTagIndex/markdownRoundTrip/retrospective + fixture repro |
| `npm -w @carnet/mobile run editor:build` | Build the TenTap WYSIWYG editor-web bundle (Vite) |
| `npm -w @carnet/mobile run editor:post-build` | Inline the editor-web bundle into one HTML (invoked by `editor:build`) |

**packages/shared**
| Command | Description |
|---|---|
| `npm -w @carnet/shared run build` | `tsc` emit |
| `npm -w @carnet/shared run typecheck` | `tsc --noEmit` |
| `npm -w @carnet/shared run dev` | `tsc --watch` |
| `npm -w @carnet/shared test` | Vitest |
| `npm -w @carnet/shared run test:watch` | Vitest in watch mode |

**apps/mdcrm** — optional standalone Markdown processor; not on the capture path
| Command | Description |
|---|---|
| `npm -w @carnet/mdcrm run build` | `tsc -p tsconfig.json` |
| `npm -w @carnet/mdcrm run typecheck` | `tsc --noEmit` |
| `npm -w @carnet/mdcrm test` | Vitest |
| `npm -w @carnet/mdcrm start` | Run the built CLI (`dist/src/cli/index.js`) |
<!-- /AUTO-GENERATED:scripts -->

## Running locally
- **Mobile (dev):** `npm run mobile`, then `npm -w @carnet/mobile run android`
- **Mobile (release APK):** `npm -w @carnet/mobile run android:release`

## Configuration
There are **no `.env` files** — this is a hard constraint, not an omission (see CLAUDE.md).
All runtime config is entered **in-app** on the device via the Settings screen (one API key
per provider in SecureStore, the rest in AsyncStorage) — see [RUNBOOK.md](RUNBOOK.md):
- **An LLM provider** — required to enrich captures. Pick one of the presets (Relais (local) ·
  OmniRoute · OpenAI · Groq · OpenRouter) or add a custom OpenAI-compatible entry, then set its
  base URL, key and model. Choosing a **local** provider (e.g. Relais running on the handset)
  means note text never leaves the device and the app works with no network at all.
- **Karakeep** (optional) — instance URL + API key, for the opt-in per-note "Send to Karakeep" export.

## Testing
- All workspaces use **Vitest** (`npm -w <workspace> test`).
- Type-check each workspace with `tsc --noEmit`.
- Fix the implementation, not the test, unless the test is wrong.

## CI — must be green before merge
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on push/PR:
**shared → mobile · mobile-android (parallel) → gate** (the branch-protection
required check), plus an advisory **apk** job that attaches a release-signed installable
APK to each run's artifacts (14-day retention). `mobile-android` runs Expo prebuild +
`gradlew :app:compileDebugKotlin` to catch native/config-plugin regressions. Tag pushes
matching `v*.*.*` trigger [`release.yml`](../.github/workflows/release.yml) (signed APK +
GitHub Release).

## Pull requests
1. Branch off `main`.
2. Conventional commits: `feat` · `fix` · `refactor` · `docs` · `test` · `chore` · `perf` · `ci`.
3. `tsc --noEmit` clean + Vitest green in affected workspaces.
4. Open a PR to `main`; **squash-merge** is the repo convention.
