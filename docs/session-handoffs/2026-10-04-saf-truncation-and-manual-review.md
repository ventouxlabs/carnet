# SAF truncation and manual historical-tail review — 2026-10-04

Branch: `fix/saf-write-truncate`. Implementation HEAD: `01d1934`.

## Delivered

- `1d7ae40 fix(vault): truncate SAF files on rewrite so shorter notes leave no stray tail`
  patches the legacy Expo file-system SAF writer to use `"wt"`. The module is built
  from source so the native patch takes effect.
- `8b6ce24 ci(vault): verify Expo file system source compilation` adds a CI assertion
  that `:expo-file-system:compileDebugKotlin` actually ran.
- `d17e270 docs(vault): record SAF device rewrite verification` records the physical
  device check: a fresh 148-character raw Idea was replaced with
  `SAF-short-rewrite-ok`, saved, and reopened with only that marker. The disposable
  note was archived through Carnet.
- `4ad2d9c feat(vault): add manual SAF stale-tail review` adds an explicit Home scan.
  It reads the active vault with bounded concurrency, uses a conservative trailing
  partial-line heuristic, and exposes only candidate note metadata for manual review.
  It does not write or cache vault content. Home clears results on context changes,
  rejects stale cross-vault navigation, and guards rapid duplicate Scan taps.
- `01d1934 fix(vault): truncate modern SAF rewrites` patches `SAFDocumentFile.kt` to
  try `"wt"`, with a `"w"` fallback only for `FileNotFoundException` or a null stream.
  Permission and other I/O failures still propagate. The fallback does not guarantee
  truncation for providers supporting only `"w"`; Carnet currently uses the legacy API.

## Verification and limits

Latest mobile validation passed: 2,678 tests across 156 files, typecheck, and lint.
Independent review approved the implementation. Android build output showed
`:expo-file-system:compileDebugKotlin`; this handoff does not assert a complete app
build without a final `BUILD SUCCESSFUL` record.

Physical shorter-rewrite verification covered the legacy writer only. The new Home
scan UI and modern API path still need physical smoke testing. The scan flags possible
tails, not proven corruption; repair remains manual because the original content
boundary cannot be recovered reliably.

## Next steps and repository state

- Smoke-test the explicit scan on a real SAF vault when a phone is available; review
  candidates manually. Run the scan separately in each affected vault.
- Keep the base64 decode-before-open TODO deferred: every current binary write targets
  a fresh file. Revisit before introducing binary overwrites, because `"wt"` empties an
  existing file before a decode failure.
- No PR exists according to the latest GitHub check, and this session has not pushed.
  AGENTS.md requires explicit user instruction before a push.
- The pre-existing untracked `AGENTS.md` was left untouched.

See `TODO.md` under “SAF rewrite truncation” for the maintained follow-up list.
