# Note Capture Mode Implementation Plan

Status: in-progress

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Revision 2026-09-27

This revision rebases the 2026-09-13 draft onto `main` @ `12ab026`. The draft predated two PRs:

- **#219** added multi-vault pinning via `VaultContext`/`rootOverride` and card classification.
- **#220** hardened Android Auto Drive Inbox delivery.

As a result, the draft's line refs, several signatures and some snippets were wrong. Every snippet below was re-read against the code at `12ab026`, and the type shapes were compiled in isolation with `tsc --strict`.

The whole plan was then **dry-run end to end** in an isolated copy of `12ab026`. For Tasks 1–4, RED was replayed afterwards by running each task's Step 2 command on its parent commit plus its own tests. Every task's RED failed as stated, every GREEN passed, and each of the 10 commits' changed files equalled its `git add` list. Mobile gate after each task (test files / tests):

| Task | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Files / tests | 148/2354 | 148/2357 | 149/2367 | 149/2373 | 149/2384 | 149/2387 | 149/2395 | 149/2405 | 149/2406 |

In Task 9, `verify:capture-flow` passed 17 files / 476 tests, and the shared workspace built and passed. CaptureScreen measured 1105 lines through Task 7 and 1103 after Task 8. The dry run found three harness facts neither audit had, all now folded in:
- `settings.test.ts` reads CaptureScreen as source text (Task 3).
- A persistent mock leaks in `CaptureScreen.test.tsx` (Task 8).
- The exact RED output for Task 5.

**Decisions** (cited below as "decision N"; made 2026-09-27, before the rewrite):

1. Notes are always save-first. `previewBeforeSave` ("Preview ideas before saving") is idea-only.
2. An older build refusing a newer settings export that carries a `note` override is accepted, and the export version is not bumped.
3. Drive Inbox (Android Auto) stays idea-only, with a characterization test before any generalisation and a `receiptId` + `note` guard.
4. Vault pinning is mandatory on every new write, enrich, queue and re-enrich path.
5. `NoteType` gains `"note"` in `enrichSanitize.ts`, and the prompt and sanitizer agree on its keys.
6. Re-enrich for notes lands as one atomic task.
7. The silent display sites move into the task that maps `Notes/` → `note`.
8. The capture surface never falls into the Person/card path.
9. `CaptureScreen.tsx` does not grow; new branching lives in `lib/`.
10. The queue drain is exhaustive (`never` else), and unknown rows are kept, not silently removed.
11. Task 9 adds the repro fixture, extends `verify:capture-flow`, and fixes the stale docs.
12. Known accepted risks are documented, not built.
13. (2026-09-29, human) The "never expand" rule is enforced in code by a line guard. On failure, the model's title and tags are kept over the user's raw lines (Task 10).

**Execution record (2026-09-29).** The human approved this plan. Tasks 1–9 were applied from the verified dry-run commits (via `git format-patch`/`git am`; the dry-run baseline was byte-identical to `12ab026` for every touched file). Task 10 was then implemented test-first.

What changed:

- **Vault pinning everywhere.** The pinned signatures are:
  - `writeNote(slug, md, rootOverride?)`
  - `enrichNote(text, options?: EnrichmentOptions)`, which scopes vault tags to `options.vaultContext.profileId`
  - `NotePayload`, placed inside the queue's parenthesised union so the `& { vaultContext? }` intersection is kept
  - the root branch in the save-first write, which is kept
  - `vaultContext` forwarded by re-enrich

  The draft dropped all of these.
- **The sanitizer learns `note`.** `chatCompletion`'s 5th argument is a `NoteType` that drives frontmatter normalization. The draft passed `"idea"`, which requires `status`, a key the note prompt never emits. `note` now requires `created` and `tags`, and a test pins the prompt and the sanitizer together.
- **Notes are always save-first.** The Settings label is "Preview ideas before saving". The preview branch is now idea-only, and `confirmSaveIdea`/`captureConfirmSave.ts` are untouched. The draft's `buildPreviewSubtitle` note branch is dead code and is dropped.
- **Drive Inbox stays idea-only.**
  - `notificationQuickIdea.ts` is untouched.
  - `RawNoteInput` forbids `receiptId` at compile time, and the raw write throws at runtime.
  - A characterization test pins the receipt-resume path before any generalisation.
- **The mode predicates live in a new leaf, `lib/saveFirstRouting.ts`, not in `ideaSaveFirst.ts`.** Three suites `vi.mock` `ideaSaveFirst` wholesale, so any new export would be `undefined` there. `captureDisplay.test.ts` is mock-free. `ideaSaveFirst.ts` re-exports the predicates.
- **The silent display sites move into the task that maps `Notes/` → `note`.** They are the Search filter, TagBrowser, `relatedSubdirForMode`, `modeStamp`, `formatMode`, and the `App.tsx` Capture title, which the draft missed; it said "Contact". The same task widens `CaptureModeInput`, which rendered the Contact card scanner for a note, and makes CaptureScreen's person fallthrough explicit.
- **Re-enrich is one atomic task, landing before the capture surface.** No commit lets a user create a pending note whose "Finish enrichment" runs the expanding idea prompt, or whose Re-enrich runs the Person prompt.
- **The queue gets an exhaustive `never` else**, so unknown rows are no longer silently removed. Its `CaptureMode` is derived from `QueuePayload["mode"]`.
- **`CaptureScreen.tsx` (1105 lines) does not grow.** The new branching lives in `lib/`.
- **Task 9 wraps up.** It adds a repro fixture, extends `verify:capture-flow`, and fixes the stale docs (CODEMAPS, README, `TODO.md`).
- **Commits stage explicit paths only.** An untracked `AGENTS.md` sits in the repo root.

**Goal:** Add a sixth capture mode, **Note**, that writes into `Notes/`. Its prompt tidies and tags the user's text without ever expanding it, so task lists survive capture intact and their `- [ ]` lines reach the existing Todos screen.

**Architecture:** `note` becomes a real `CaptureMode`. It reuses the save-first machinery rather than duplicating it:

- `lib/ideaSaveFirst.ts` gains a `mode` that routes the writer (`writeIdea` or `writeNote`) and the enrich entry point (`enrichIdea` or `enrichNote`).
- The pure routing decisions live in a new runtime-import-free leaf, `lib/saveFirstRouting.ts`.
- CaptureScreen's race-guarded submit path keeps one branch.

The genuinely new code is:

- a prompt, plus a `note` shape in the sanitizer
- a writer
- a dispatcher/llmClient entry point
- a queue payload
- a frontmatter test for synthesis notes
- one capture-sheet row

**Tech Stack:** TypeScript, React Native 0.81 / Expo SDK 54, vitest, AsyncStorage.

**Spec:** `.claude/PRPs/prds/note-capture-mode.prd.md`. It is authoritative for scope. Read it before Task 1.

## Global Constraints

- **Frontmatter stays byte-compatible** with existing vault files. New notes add a new file shape (`created`, `tags`). Nothing about existing serialization changes, and `setFrontmatterTags`/`normalizeTag` are untouched.
- **No SQLite. No `.env` files.** All persistence goes through AsyncStorage or `expo-secure-store`.
- **Mobile lint stays at exactly three rules.** Add no rules and no `eslint-disable` comments.
- **Immutability, small functions, no deep nesting** (`~/.claude/rules/common/coding-style.md`).
- **Fix the implementation, not the test,** unless the test itself is wrong. Every test this plan edits says why at the edit site. There are three kinds of edit:
  - a mock factory gains an export a new code path needs
  - a whole-map test gains the new variant
  - one test whose premise this feature makes false (Task 7)
- **Vault pinning is mandatory.** Every new writer, enrich call, queue row and re-enrich takes the captured `Root`/`VaultContext`. Never re-read the active profile after an await.
- **`CaptureScreen.tsx` is 1105 lines, over the 800 norm. It must not grow.** Any task touching it ends with `wc -l apps/mobile/src/screens/CaptureScreen.tsx`, expected at most `1105`. New branching goes in `lib/`.
- **Synthesis notes stay non-re-enrichable in every commit.** Through Tasks 1–6 that is pinned by `RecentDetailScreen.test.tsx`'s "does not offer Re-enrich for a synthesis note in Notes/…" test, which is unchanged until Task 7. Task 3 adds a second guard.
- **Drive Inbox stays idea-only, and its tests stay green unmodified.** The Drive Inbox gate below runs in Tasks 5, 6, 8 and 9. The following must pass with no existing line changed:
  - all of `notificationQuickIdea.test.ts`: the describe blocks at `:99`, `:124`, `:333` and `:446` (Task 5 only *appends* a block)
  - `captureNotification.test.ts:116` ("returns native Drive Inbox completion status") and `:124` ("releases only a receipt's native retry latch")
  - `SettingsScreen.test.tsx:340` ("mirrors the initially active vault into native receipt routing")

  `notificationQuickIdea.ts` itself is never edited.
- **Commits:**
  - Conventional commits; squash-merge; PR to `main`.
  - Stage files by explicit path only. **Never `git add -A`/`git add .`**, because an unrelated untracked `AGENTS.md` sits in the repo root.
  - No co-author trailers.
- Build `@carnet/shared` first (`npm run build:shared`), because mobile tests import its `dist/`.

**Mobile gate** (the last check of every task):

```bash
npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test
```

Expected: `tsc` and `eslint` exit 0 with no output beyond the npm banners, and vitest reports every file passing. At `12ab026` the baseline is `Test Files  148 passed (148)` and `Tests  2338 passed (2338)`. Each task only adds.

**Drive Inbox gate:**

```bash
BASE=$(git merge-base HEAD main)
git diff --quiet "$BASE" -- apps/mobile/src/lib/notificationQuickIdea.ts \
  apps/mobile/src/lib/captureNotification.test.ts \
  apps/mobile/src/screens/SettingsScreen.test.tsx && echo "drive-inbox source + tests untouched"
git diff -U0 "$BASE" -- apps/mobile/src/lib/notificationQuickIdea.test.ts \
  | grep -E '^-([^-]|$)' || echo "no existing notificationQuickIdea test line changed"
npm -w @carnet/mobile test -- notificationQuickIdea captureNotification SettingsScreen
```

Expected output, in order:

1. `drive-inbox source + tests untouched`
2. `no existing notificationQuickIdea test line changed`
3. all three files pass

## Orientation for an implementer with no context

Read these first. They are short and they carry the constraints:

- `CLAUDE.md` has the build/test commands and the hard constraints.
- `.claude/PRPs/prds/note-capture-mode.prd.md` is the spec.
- `.claude/PRPs/prds/notes-todo-capture.prd.md` is the prior decision this spec partially reverses. The spec's "Why this reverses a prior decision" table explains which objections do and do not apply. Do not re-litigate it.

**Vault layout today:**

- `Ideas/` holds jotted thoughts.
- `Journal/` holds dated day files, append-only.
- `People/` holds contacts.
- `Notes/` holds saved Ask answers, written by `writeSynthesis`.

`NOTE_SUBDIRS` (`lib/noteSubdirs.ts:13`) lists all four, and it is what Search, TagBrowser and the todo scan index. `Archive/` is deliberately not indexed. After this plan, `Notes/` holds captured notes **and** saved answers; they are told apart by frontmatter (`isSynthesisNote`), never by folder.

**Save-first (B4):**

- An Idea is written to disk raw and immediately, with `status: pending-enrich` and a `rev` token.
- Enrichment then updates the same file in place, guarded by mtime, or by content on SAF.
- `lib/ideaSaveFirst.ts` owns the flow.
- A transient failure queues a row carrying `filepath` + baseline, so the drain updates the file in place.
- A note stuck at `pending-enrich` is finished from RecentDetail's "Finish enrichment" (`finishEnrichment.ts`).

**Todos already work.** `- [ ]` lines in any indexed note are extracted into the note index (`vault.ts:217`) and aggregated by `TodosScreen`. This plan adds no todo code.

**Vault pinning (#219).** An operation captures a `VaultContext` (`{ profileId, rootUri }`) before its first await. It then writes through `resolveContextRoot(ctx)` and scopes vault-tag hints to `ctx.profileId`:

- every writer takes `rootOverride?: Root`
- every dispatcher `enrich*` takes `options?: EnrichmentOptions` (`{ vaultContext? }`)
- queue rows persist `vaultContext`

**Drive Inbox (#220).** An Android Auto reply lands in `notificationQuickIdea.handleQuickIdeaCapture`. The headless task stamps a `carnet_drive_inbox_receipt` marker on the raw note. A restarted task finds that note by scanning **`Ideas/` only** (`findReceiptRawNote`, `notificationQuickIdea.ts:72-86`, with the check at `:75`). That is why a receipt must never be written as a note.

**Where things are at `12ab026`** (line numbers drift as you edit, so re-grep before each edit):

| What | Where |
|---|---|
| `CaptureMode` union | `lib/storage.ts:11` |
| `subdirForMode` / `buildNoteEntry` mode / upsert fallback / `inferNoteMode` / `synthesizeEntry` | `lib/vault.ts:195` / `:227` / `:433` / `:534` / `:566` |
| `writeIdea` / `writeSynthesis` (docstring `:178-188`) | `lib/writer.ts:166` / `:189` |
| `todayLocal` / `INJECTION_GUARD` / `buildIdeaPrompt` / `withTagHint` | `lib/prompts.ts:23` / `:31` / `:36` / `:443` |
| `NoteType` / `CANONICAL_ORDER` / `REQUIRED_KEYS` | `lib/enrichSanitize.ts:34` / `:42` / `:55` |
| normalization fallback / `chatCompletion(…, noteType, …)` | `lib/llmHttp.ts:221` / `:231-253` |
| `llmClient.enrichIdea` | `lib/llmClient.ts:328` |
| `EnrichmentOptions` / `dispatcher.enrichIdea` | `lib/dispatcher.ts:296` / `:300` |
| `PromptOverrides` | `lib/settings.ts:71` |
| `PROMPT_OVERRIDE_KEYS` (validator) / `isPromptOverrides` / version check | `lib/settingsTransfer.ts:175` / `:185` / `:91` |
| `PROMPT_MODES` / exhaustive `defaultPromptFor` | `components/PromptOverridesSection.tsx:17` / `:35` |
| `RawIdeaInput` / `usesSaveFirst` / `writeRawIdea` / `rewriteRawIdea` / `EnrichIdeaInPlaceInput` / `enrichIdeaInPlace` | `lib/ideaSaveFirst.ts:81` / `:98` / `:165` / `:201` / `:274` / `:311` |
| queue `CaptureMode` / `IdeaPayload` / `QueuePayload` / `enqueue` / `processRow` | `lib/queue.ts:71` / `:78` / `:128` / `:291` / `:384` |
| `RE_ENRICHABLE_MODES` / `finishPendingEnrichment` / `reEnrichNoteInPlace` (idea branch `:236`) | `lib/finishEnrichment.ts:74` / `:96` / `:198` |
| `formatMode` / `relatedSubdirForMode` | `lib/recentDetailView.ts:17` / `:136` |
| `modeStamp` | `components/NoteCard.tsx:9` |
| `computeCanSubmit` / `buildPreviewSubtitle` | `lib/captureDisplay.ts:77` / `:32` |
| `ModeInput` idea branch; the `else` renders `PersonInput` + `CardScannerModal` | `components/CaptureModeInput.tsx:38` / `:119` |
| `CaptureTarget` / `SHEET_ROWS` | `components/CaptureFab.tsx:8` / `:18` |
| `MODE_FILTERS` | `screens/SearchScreen.tsx:43-47` |
| `modeLabel` / `modeIcon` | `screens/TagBrowserScreen.tsx:35-45` |
| Re-enrich gate (still a folder test) / `handleFinishEnrichment` | `screens/RecentDetailScreen.tsx:814-818` / `:321-339` |
| `carnet://capture/:mode` deep link (unvalidated) / Capture header title | `App.tsx:101` / `:303-313` |
| "Preview ideas before saving" | `screens/SettingsScreen.tsx:687` |

**CaptureScreen sites** (`screens/CaptureScreen.tsx`):

- `:159`, `:174`: `RawIdeaInput` refs
- `:458`: `finishSaveFirst` ctx
- `:488`: queue retry `enqueue({mode:"idea"})`
- `:540`: `reEnrichSaved` → `enrichIdeaInPlace`
- `:580`: Edit's idea branch
- `:662`: submit's idea branch
- `:664`: preview gate
- `:683`: preview-path `enqueue({mode:"idea"})`
- `:699`: draft
- `:724`: ctx
- `:736`: `writeRawIdea`
- `:749`: title fallback `"Idea"`
- `:790`: `enrichIdeaInPlace`
- `:848`: unconditional person fallthrough
- `:882`: `confirmSave` idea (preview-only)
- `:1080`: `showStatusRow`

**Test-harness facts that will bite you:**

- **`../lib/ideaSaveFirst` is `vi.mock`'d wholesale** by `CaptureScreen.test.tsx:70`, `notificationQuickIdea.test.ts:15` and `finishEnrichment.test.ts:29`. Any *new* export of that module is `undefined` in those suites, which is why the predicates live in the leaf `saveFirstRouting.ts`.
- `ideaSaveFirst.ts` also drags `dispatcher → settings → expo-secure-store` into any test that imports it. `captureDisplay.test.ts` has no mocks at all.
- **`../lib/finishEnrichment` is `vi.mock`'d wholesale** by `RecentDetailScreen.test.tsx:124-139`, which *restates* `isReEnrichableMode` as `["idea", "person"].includes(mode)`.
- `ideaSaveFirst.test.ts` (`:118-140`) and `queue.test.ts` (`:107`) mock **`./llmClient`**, not `./dispatcher`. The dispatcher runs for real, so assertions look at `llmClient.enrich*` args: `(text, config, override, availableTags)`.
- `queue.test.ts`'s `./writer` mock (`:140`) has no `updateNoteIfUnchanged`. The save-first `filepath` drain path is untested today even for idea.
- In `dispatcher.test.ts`, the test at `:716` installs a persistent `getVaultTagStrings.mockImplementation`. There is no `restoreMocks` in `vitest.config.ts`, so it leaks into later tests.
- `notificationQuickIdea.test.ts`'s `./frontmatter` mock (`extractFrontmatterField: vi.fn(() => null)`) is not reset by its `beforeEach`. Its `listNoteFilesInRootMock` always resolves `[]`.
- `RecentDetailScreen.test.tsx` helpers are `renderScreen(entry)` (`:219`), `openActionsSheet(navigation)` (`:240`, the ⋮ lives in the header), `vi.mocked(readNote).mockResolvedValue(body)`, `NOTE_MD` (pending) and `ENRICHED_MD` (`:542`).
- `CaptureScreen.test.tsx`'s `renderScreen(mode)` (`:151`) is positional and typed `"idea" | "journal" | "person"`.
- In the same file, the Edit test at `:836` installs a persistent `vi.mocked(enrichIdeaInPlace).mockReturnValue(deferred)`. `vi.clearAllMocks()` keeps implementations, so any describe appended after it must reset `enrichIdeaInPlace` itself. Task 8's does.
- `tsconfig.json` includes test files, so a `// @ts-expect-error` line in a test is a real compile-time assertion.
- **`settings.test.ts:152-175` reads `CaptureScreen.tsx` as source text.** It anchors on the literal comment `// mode === "person"`, and requires that neither that point nor anything from `if (mode === "journal") {` onward mentions `previewBeforeSave`. It is the only source-scanning test in the app (`grep -rln readFileSync src test`). Neither audit listed it.

---

### Task 1: The Note prompt, the `note` sanitizer shape, and `isSynthesisNote`

**Files:**
- Modify: `apps/mobile/src/lib/prompts.ts`: add `buildNotePrompt` after `buildIdeaPrompt` (`:36-66`), and update `withTagHint`'s doc (`:440-442`).
- Modify: `apps/mobile/src/lib/enrichSanitize.ts`: `NoteType` (`:34`), `CANONICAL_ORDER` (`:42`), `REQUIRED_KEYS` (`:55`).
- Modify: `apps/mobile/src/lib/frontmatter.ts`: add `isSynthesisNote` after `normalizeTag` (`:472-481`).
- Test: `apps/mobile/src/lib/prompts.test.ts`, `apps/mobile/src/lib/enrichSanitize.test.ts`, `apps/mobile/src/lib/frontmatter.test.ts`

**Interfaces:**
- Consumes:
  - `INJECTION_GUARD` and `todayLocal()`, private in `prompts.ts`
  - `extractFrontmatterField(markdown, field): string | null` (`frontmatter.ts:96`)
  - `getFrontmatterTags` (`:436`) and `normalizeTag` (`:472`)
  - `buildSynthesisNote` (`retrospective.ts:198`, pure, zero imports), which always emits `tags: [synthesis]` and `question:`
- Produces:
  - `buildNotePrompt(input: string): PromptPair`
  - `NoteType = "idea" | "journal" | "person" | "shared" | "note"`. `note` requires and orders exactly `created`, `tags`, which are the two keys `buildNotePrompt`'s template emits.
  - `isSynthesisNote(markdown: string): boolean`

**Why the sanitizer changes here.** `chatCompletion`'s 5th parameter is `noteType: NoteType` (`llmHttp.ts:237`), which drives `sanitizeAndNormalize` (`llmHttp.ts:221`). `idea` requires `status`, which a note never carries. Under `"idea"`, every note reply would fail normalization and silently fall back to un-canonicalized text. All three changes are pure: no filesystem, no network.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/lib/prompts.test.ts`, make three changes:

1. Add `buildNotePrompt,` to the `./prompts` import list, after `buildJournalPrompt,`.
2. Add `buildNotePrompt("thought"),` to the `pairs` array in `"injection-guard invariants (every builder)"`. This extends the every-builder invariant to the new builder: an addition, not a changed expectation.
3. Append:

```ts
describe("buildNotePrompt (note capture: tidy and tag, never expand)", () => {
  it("wraps the user's lines in the USER_INPUT delimiters", () => {
    expect(buildNotePrompt("- [ ] call the dentist").user).toBe(
      "<USER_INPUT>\n- [ ] call the dentist\n</USER_INPUT>",
    );
  });

  it("forbids expanding the user's text — the one rule that separates it from Idea", () => {
    const { system } = buildNotePrompt("x");
    expect(system).toContain("DO NOT expand");
    expect(system).not.toMatch(/expand the thought/i);
  });

  it("reuses the never-invent-tasks rule verbatim, on one line", () => {
    // Same phrase as buildIdeaPrompt/buildJournalPrompt (prompts.ts:44, :78).
    expect(buildNotePrompt("x").system).toContain("NEVER invent tasks");
  });

  it("asks for checkboxes only on actions the user already wrote", () => {
    expect(buildNotePrompt("x").system).toContain("- [ ]");
  });

  it("asks for the note tag plus two suggestions", () => {
    expect(buildNotePrompt("x").system).toContain("tags: [note, {tag1}, {tag2}]");
  });
});
```

In `apps/mobile/src/lib/enrichSanitize.test.ts`, add `import { buildNotePrompt } from "./prompts";` below the `./enrichSanitize` import and append:

```ts
// ── Note shape (note capture mode) ────────────────────────────────────────────

describe("normalizeFrontmatter — note", () => {
  it("round-trips a prompt-shaped note byte-for-byte", () => {
    const md =
      "---\ncreated: 2026-09-27\ntags: [note, errands]\n---\n# Weekend errands\n\n- [ ] call the dentist\nthe car is in the east lot\n";
    expect(normalizeFrontmatter(md, "note")).toBe(md);
  });

  it("re-serializes note frontmatter into canonical order (created, tags)", () => {
    expect(normalizeFrontmatter("---\ntags: [note]\ncreated: 2026-09-27\n---\n# T\n", "note")).toBe(
      "---\ncreated: 2026-09-27\ntags: [note]\n---\n# T\n",
    );
  });

  it("does not demand idea's status key — the reason the note type exists", () => {
    const md = "---\ncreated: 2026-09-27\ntags: [note]\n---\n# T\n";
    expect(normalizeFrontmatter(md, "idea")).toBeNull();
    expect(normalizeFrontmatter(md, "note")).toBe(md);
  });

  it("returns null when a note is missing its tags", () => {
    expect(normalizeFrontmatter("---\ncreated: 2026-09-27\n---\n# T\n", "note")).toBeNull();
  });

  it("accepts exactly the frontmatter buildNotePrompt asks for (prompt and sanitizer agree)", () => {
    // Fill the prompt's own template. If the prompt ever asks for a key the
    // note type doesn't order, or stops emitting a required one, this fails.
    const { system } = buildNotePrompt("x");
    const template = system.slice(system.indexOf("---\ncreated:"));
    const filled = template
      .replace("{tag1}", "errands")
      .replace("{tag2}", "weekend")
      .replace("{Title}", "Weekend errands");
    expect(normalizeFrontmatter(filled, "note")).toBe(filled);
  });
});
```

In `apps/mobile/src/lib/frontmatter.test.ts`, add `isSynthesisNote,` to the `./frontmatter` import list and `import { buildSynthesisNote } from "./retrospective";` below it, then append:

```ts
// ── isSynthesisNote ───────────────────────────────────────────────────────────

describe("isSynthesisNote", () => {
  const captured =
    "---\ncreated: 2026-09-27\ntags: [note, errands]\n---\n# Weekend errands\n\n- [ ] call the dentist\n";

  it("identifies buildSynthesisNote's real output", () => {
    expect(
      isSynthesisNote(buildSynthesisNote("what about coffee", "You wrote about it.", [], "2026-09-27")),
    ).toBe(true);
  });

  it("does not mistake a captured note for one", () => {
    expect(isSynthesisNote(captured)).toBe(false);
  });

  it("is false with no frontmatter at all", () => {
    expect(isSynthesisNote("# just a heading\n")).toBe(false);
  });

  it("still identifies it by question: after the user retags it in Obsidian", () => {
    const retagged = buildSynthesisNote("q", "a", [], "2026-09-27").replace(
      "tags: [synthesis]",
      "tags: [research]",
    );
    expect(isSynthesisNote(retagged)).toBe(true);
  });

  it("still identifies it by the synthesis tag (normalized) if question: was deleted", () => {
    expect(isSynthesisNote("---\ncreated: 2026-09-27\ntags: [#Synthesis]\n---\n# q\n")).toBe(true);
  });

  it("ignores a question: line in the body — only frontmatter counts", () => {
    expect(isSynthesisNote(`${captured}\nquestion: what to buy\n`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- prompts enrichSanitize frontmatter`
Expected: FAIL.
- `prompts.test.ts` and `enrichSanitize.test.ts` fail with `TypeError: buildNotePrompt is not a function`. `prompts.test.ts` fails at collection, because `pairs` calls it.
- `frontmatter.test.ts` fails with `TypeError: isSynthesisNote is not a function`.
- `normalizeFrontmatter(…, "note")` throws, because `REQUIRED_KEYS.note` is `undefined` and not iterable.

- [ ] **Step 3: Implement `isSynthesisNote`**

In `apps/mobile/src/lib/frontmatter.ts`, directly after `normalizeTag`:

```ts
/**
 * True when this markdown is a saved retrospective answer (buildSynthesisNote,
 * retrospective.ts) rather than a note the user captured.
 *
 * Both now live in Notes/ (note-capture-mode PRD §4), so the folder can no
 * longer carry this meaning. buildSynthesisNote always emits BOTH
 * `tags: [synthesis]` and a `question:` field; either suffices, and
 * `question:` survives the user retagging the note in Obsidian.
 */
export function isSynthesisNote(markdown: string): boolean {
  if (extractFrontmatterField(markdown, "question") !== null) return true;
  return getFrontmatterTags(markdown).some((tag) => normalizeTag(tag) === "synthesis");
}
```

- [ ] **Step 4: Teach the sanitizer the `note` shape**

In `apps/mobile/src/lib/enrichSanitize.ts`:

```ts
export type NoteType = "idea" | "journal" | "person" | "shared" | "note";
```

Add a `note` entry as the last key of **both** records:

```ts
const CANONICAL_ORDER: Record<NoteType, readonly string[]> = {
  idea: ["created", "status", "tags"],
  journal: ["date", "tags", "people", "ideas"],
  person: ["name", "company", "title", "email", "phone", "linkedin", "met", "where", "tags"],
  shared: ["created", "kind", "tags"],
  // buildNotePrompt's template emits exactly these two keys. No `status`: a
  // note has no seedling/developing/mature maturity.
  note: ["created", "tags"],
};
```

```ts
const REQUIRED_KEYS: Record<NoteType, readonly string[]> = {
  idea: ["created", "status", "tags"],
  journal: ["date", "tags", "people"],
  person: ["name"],
  shared: ["kind"],
  note: ["created", "tags"],
};
```

- [ ] **Step 5: Implement `buildNotePrompt`**

In `apps/mobile/src/lib/prompts.ts`, directly after `buildIdeaPrompt`:

```ts
/**
 * Prompt for note capture mode — task lists and working notes.
 *
 * The hard contract, and the one thing that separates it from buildIdeaPrompt:
 * it must NOT expand. buildIdeaPrompt grows a half-formed thought into prose,
 * which is the wrong thing to do to a todo list. Here the user's lines are kept
 * and only a title, tags and checkbox syntax are added.
 *
 * "NEVER invent tasks" is copied from buildIdeaPrompt/buildJournalPrompt on
 * purpose — it is the wording that keeps those two from fabricating action
 * items. The frontmatter template (created, tags) is exactly what
 * enrichSanitize's `note` type requires; enrichSanitize.test.ts pins the two.
 */
export function buildNotePrompt(input: string): PromptPair {
  const today = todayLocal();
  const system = `You are a personal knowledge assistant. The user has captured a note —
working notes, a task list, or things they need to get done. Your job is to:
1. Give it a concise title (5 words max, slug-friendly)
2. Keep the user's own lines. DO NOT expand, summarise, reword, or add prose.
   Preserve their wording and their order.
3. Render a line as a markdown checkbox ("- [ ] ...") ONLY if it is already an
   action the user wrote, phrased faithfully from the input — NEVER invent tasks.
   Leave context and reference lines exactly as they are.
4. Suggest 2-3 relevant tags

${INJECTION_GUARD}

Respond ONLY with valid Obsidian markdown in this exact format:
---
created: ${today}
tags: [note, {tag1}, {tag2}]
---
# {Title}

{The user's lines, in order, with their actions as "- [ ] ..." checkboxes}`;
  const user = `<USER_INPUT>\n${input}\n</USER_INPUT>`;
  return { system, user };
}
```

In `withTagHint`'s doc comment, replace:

```
 * emit, because the five capture prompts ask for different counts (2-3 for
 * idea/journal/person, 3-5 for shared image/link).
```

with:

```
 * emit, because the capture prompts ask for different counts (2-3 for
 * idea/journal/person/note, 3-5 for shared image/link).
```

- [ ] **Step 6: Run the focused tests, then the mobile gate**

Run: `npm -w @carnet/mobile test -- prompts enrichSanitize frontmatter`
Expected: PASS.

Then run the **mobile gate** (Global Constraints).
Expected: typecheck and lint clean, and every test file passes.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/prompts.ts apps/mobile/src/lib/prompts.test.ts \
        apps/mobile/src/lib/enrichSanitize.ts apps/mobile/src/lib/enrichSanitize.test.ts \
        apps/mobile/src/lib/frontmatter.ts apps/mobile/src/lib/frontmatter.test.ts
git commit -m "feat(note): add the note prompt, its sanitizer shape, and isSynthesisNote"
```

---

### Task 2: `writeNote`, and the `writeSynthesis` docstring

**Files:**
- Modify: `apps/mobile/src/lib/writer.ts`: add `writeNote` between `writeIdea` (`:166-176`) and `writeSynthesis`, and fix `writeSynthesis`'s docstring (`:181-184`).
- Test: `apps/mobile/src/lib/writer.test.ts`

**Interfaces:**
- Produces: `writeNote(slug: string, markdown: string, rootOverride?: Root): Promise<{ filepath: string }>`. Its shape is identical to `writeIdea`/`writeSynthesis`: `rootOverride ?? await resolveRoot()`, create-only, and collision suffixing shared with `writeSynthesis`'s files in `Notes/`.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/lib/writer.test.ts`, make two import changes:

1. Add `writeNote,` to the `./writer` import list, after `writeSynthesis,`.
2. Add `import { resolveProfileRoot } from "./vaultRoot";` after `import { getSettings } from "./settings";`. `vaultRoot` reads `./settings`, which this file already mocks.

Then add after the `writeSynthesis` describe:

```ts
// ── writeNote ─────────────────────────────────────────────────────────────────

describe("writeNote", () => {
  beforeEach(clearFiles);

  it("writes a captured note under Notes/", async () => {
    const md = "---\ncreated: 2026-09-27\ntags: [note]\n---\n# Weekend errands\n";
    const { filepath } = await writeNote("weekend-errands", md);
    expect(filepath).toBe("file:///data/carnet/Notes/weekend-errands.md");
    expect(_files.get(filepath)!.content).toBe(md);
  });

  it("suffixes on a slug collision — including with a saved answer in the same folder", async () => {
    await writeSynthesis("weekend-errands", "---\ntags: [synthesis]\n---\n# Q");
    const { filepath } = await writeNote("weekend-errands", "b");
    expect(filepath).toBe("file:///data/carnet/Notes/weekend-errands-2.md");
  });

  it("writes into the pinned vault root, never re-reading the active one", async () => {
    const pinned = resolveProfileRoot({ rootUri: "file:///data/work-vault" });
    vi.mocked(getSettings).mockClear();
    const { filepath } = await writeNote("pinned", "x", pinned);
    expect(filepath).toBe("file:///data/work-vault/Notes/pinned.md");
    expect(getSettings).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- writer.test`
Expected: FAIL with `TypeError: writeNote is not a function`.

- [ ] **Step 3: Add `writeNote`**

In `apps/mobile/src/lib/writer.ts`, between `writeIdea` and `writeSynthesis`:

```ts
/**
 * Write a captured note (note capture mode) under Notes/. Create-only with
 * collision suffixing, exactly like writeIdea — and it shares Notes/, and so
 * the suffix space, with writeSynthesis's saved answers.
 *
 * Does NOT touch the note index; the caller pairs this with
 * upsertNoteInIndex, matching every other write site.
 */
export async function writeNote(
  slug: string,
  markdown: string,
  rootOverride?: Root,
): Promise<{ filepath: string }> {
  const root = rootOverride ?? await resolveRoot();
  const notesUri = await root.fs.findOrCreateSubdir(root.uri, "Notes");
  const filename = await findCollisionFreeName(notesUri, slug, ".md", root.fs);
  const filepath = await writeNewFile(notesUri, filename, markdown, root.fs);
  return { filepath };
}
```

- [ ] **Step 4: Correct `writeSynthesis`'s docstring (PRD §3 and acceptance criterion 7)**

Replace:

```
 * Notes/ holds computed artifacts that cite other notes, as distinct from
 * Ideas/ which holds things the user jotted. Create-only with collision
 * suffixing, exactly like writeIdea — a re-asked question saves a second file
 * rather than overwriting the first answer.
```

with:

```
 * Notes/ holds notes the user works FROM — captured task notes (writeNote) and
 * saved retrospective answers alike — as distinct from Ideas/, which holds
 * thoughts to develop. Use isSynthesisNote(markdown) (frontmatter.ts) to tell
 * the two apart; the folder no longer does. Create-only with collision
 * suffixing, exactly like writeIdea — a re-asked question saves a second file
 * rather than overwriting the first answer.
```

- [ ] **Step 5: Run the focused tests, then the mobile gate**

Run: `npm -w @carnet/mobile test -- writer.test`
Expected: PASS.

Then run the **mobile gate**.
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/writer.ts apps/mobile/src/lib/writer.test.ts
git commit -m "feat(note): add vault-pinnable writeNote and correct writeSynthesis's docstring"
```

---

### Task 3: `note` becomes a CaptureMode. `Notes/` maps to it, and no surface mislabels it or routes it into Contact

This one task carries decisions 7 and 8. Once `inferNoteMode` maps `Notes/` → `"note"`, every display site must know the mode in the same commit. Otherwise existing saved answers drop out of Search's Idea filter with no chip to find them, and TagBrowser keeps calling them "Idea".

**Files:**
- Modify: `apps/mobile/src/lib/storage.ts:11`
- Modify: `apps/mobile/src/lib/vault.ts`:
  - `subdirForMode` (`:195`)
  - the `upsertNoteInIndex` comment (`:427-432`)
  - `inferNoteMode` and its doc (`:531-538`)
  - leave the `:540-543` comment alone: it is still accurate, since unrecognized parents still collapse to `"idea"`
- Modify: `apps/mobile/src/lib/recentDetailView.ts`: `formatMode` (`:16-30`) and `relatedSubdirForMode` with its return type (`:132-142`)
- Modify: `apps/mobile/src/lib/noteRelated.ts`: comment (`:34-37`)
- Modify: `apps/mobile/src/components/NoteCard.tsx`: `modeStamp` (`:9-22`)
- Modify: `apps/mobile/src/screens/SearchScreen.tsx`: `MODE_FILTERS` and its comment (`:43-47`)
- Modify: `apps/mobile/src/screens/TagBrowserScreen.tsx`: `modeLabel`/`modeIcon` (`:35-45`)
- Create: `apps/mobile/src/lib/saveFirstRouting.ts`, `apps/mobile/src/lib/saveFirstRouting.test.ts`
- Modify: `apps/mobile/src/components/CaptureModeInput.tsx:38`
- Modify: `apps/mobile/src/screens/CaptureScreen.tsx:848`
- Modify: `apps/mobile/App.tsx`: the Capture header title (`:303-313`)
- Test:
  - `vault.test.ts`
  - `recentDetailView.test.ts`
  - `noteRelated.test.ts` (comment and title only)
  - `SearchScreen.test.tsx`
  - `TagBrowserScreen.test.tsx`
  - `CaptureScreen.test.tsx`
  - `RecentDetailScreen.test.tsx`

**Interfaces:**
- Produces:
  - `CaptureMode = "idea" | "journal" | "person" | "photo" | "audio" | "note"`
  - `inferNoteMode(<Notes/ uri>) === "note"`, `subdirForMode("note") === "Notes"`, and `relatedSubdirForMode(mode): NoteSubdir`, which returns `"Notes"` for a note
  - `formatMode("note") === "Note"` and `modeStamp("note") = { label: "Note", icon: "checkbox-marked-outline" }`
  - `SaveFirstTextMode = Extract<CaptureMode, "idea" | "note">` and `isSaveFirstTextMode(mode): mode is SaveFirstTextMode`, from the leaf `saveFirstRouting.ts`

**What `tsc` finds and what it doesn't.**
- `tsc` flags the two exhaustive switches: `modeStamp` (`NoteCard.tsx`) and `formatMode` (`recentDetailView.ts`). Fix each at its site. Do not add a `default:`, because exhaustiveness is load-bearing.
- The if-chains below compile silently and treat `note` as idea or person. They are listed here explicitly:
  - `subdirForMode`
  - `relatedSubdirForMode`
  - TagBrowser `modeLabel`/`modeIcon`
  - Search `MODE_FILTERS`
  - `CaptureModeInput`
  - CaptureScreen `:848`
  - the `App.tsx` title chain
- Adding a variant is safe for persisted data: old rows never contain `"note"`.

**The `carnet://capture/:mode` deep link.** `App.tsx:101` passes any string through unvalidated, so `carnet://capture/note` reaches CaptureScreen *today* and lands on `PersonInput` and `enrichPerson`. This task closes that path:
- the note renders the text surface
- Send is inert, because the explicit person guard returns to input
- Task 8 wires save-first

Nothing becomes reachable that wasn't already.

- [ ] **Step 1: Write the failing tests**

**`apps/mobile/src/lib/vault.test.ts`**: append:

```ts
// ── Notes/ → note (note capture mode) ────────────────────────────────────────

describe("inferNoteMode — Notes/", () => {
  it("maps a Notes/ uri (file:// or SAF) to the note mode", () => {
    expect(inferNoteMode("file:///v/Notes/weekend-errands.md")).toBe("note");
    const saf =
      "content://com.android.externalstorage.documents/tree/primary%3ACarnet/document/primary%3ACarnet%2FNotes%2Fweekend-errands.md";
    expect(inferNoteMode(saf)).toBe("note");
  });

  it("reports a saved answer in Notes/ as note too — only frontmatter tells them apart", () => {
    // Why Task 7 gates Re-enrich on isSynthesisNote(body), not on mode.
    const md = '---\ncreated: 2026-09-13\ntags: [synthesis]\nquestion: "q"\n---\n# q\n';
    expect(synthesizeEntry("file:///v/Notes/q.md", md).mode).toBe("note");
  });

  it("indexes a Notes/ note with mode note, its real subdir, and its todos", async () => {
    addNote("file:///v/Ideas/a.md", "Ideas", "---\ntags: [x]\n---\n# A\n\nbody\n");
    await refreshTagIndex(); // builds + persists the note index cache
    await upsertNoteInIndex(
      "file:///v/Notes/weekend-errands.md",
      "---\ncreated: 2026-09-27\ntags: [note, errands]\n---\n# Weekend errands\n\n- [ ] call the dentist\n",
    );
    const after = await loadCachedNoteIndex();
    const entry = after!.notes.find((n) => n.uri === "file:///v/Notes/weekend-errands.md");
    expect(entry?.mode).toBe("note");
    expect(entry?.subdir).toBe("Notes");
    expect(entry?.todos).toEqual([{ text: "call the dentist", checked: false }]);
  });
});
```

**`apps/mobile/src/lib/recentDetailView.test.ts`**: these two tests assert the *whole* map on purpose, so that a swapped pair fails. Extending the map with the new variant is their intended use, not bending a test to pass.
- In `formatMode`'s map, add `note: formatMode("note"),` and expect `note: "Note",`.
- In `relatedSubdirForMode`'s map, add `note: relatedSubdirForMode("note"),` and expect `note: "Notes",`.

**`apps/mobile/src/screens/SearchScreen.test.tsx`**: add `searchNotes` to the `../lib/vault` import. Do **not** add a note to the shared `NOTES` fixture, because other tests' `getByText` calls would break. Append inside `describe("SearchScreen")`:

```tsx
  it("offers a Note filter chip that narrows the browse to mode note", async () => {
    renderScreen();
    await screen.findByText("First idea");
    fireEvent.click(screen.getByLabelText("Show filters"));
    fireEvent.click(await screen.findByLabelText("Filter by Note"));
    await waitFor(() =>
      expect(vi.mocked(searchNotes)).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.any(String),
        { mode: "note" },
      ),
    );
    expect(screen.getByLabelText("Remove Note filter")).toBeTruthy();
  });
```

**`apps/mobile/src/screens/TagBrowserScreen.test.tsx`**: add `notesForTag` to the `../lib/vault` import and append inside the top-level describe:

```tsx
  it("labels a note under a tag as Note, not Idea", async () => {
    vi.mocked(notesForTag).mockResolvedValueOnce([
      {
        id: "vault:file:///v/Notes/weekend-errands.md",
        mode: "note",
        title: "Weekend errands",
        filepath: "file:///v/Notes/weekend-errands.md",
        createdAt: 0,
      },
    ]);
    renderScreen({ tag: "errands" });
    expect(await screen.findByText("Weekend errands")).toBeTruthy();
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.queryByText("Idea")).toBeNull();
  });
```

**`apps/mobile/src/lib/saveFirstRouting.test.ts`** (new file):

```ts
import { describe, expect, it } from "vitest";

import { isSaveFirstTextMode } from "./saveFirstRouting";

describe("isSaveFirstTextMode", () => {
  it("is true for the two text modes written raw first and enriched in place", () => {
    expect(isSaveFirstTextMode("idea")).toBe(true);
    expect(isSaveFirstTextMode("note")).toBe(true);
  });

  it("is false for every other capture mode", () => {
    for (const mode of ["journal", "person", "photo", "audio"] as const) {
      expect(isSaveFirstTextMode(mode)).toBe(false);
    }
  });
});
```

**`apps/mobile/src/screens/CaptureScreen.test.tsx`**: make two harness changes:

1. Add `import type { CaptureMode } from "../lib/storage";` after `import { carnetLight } from "../lib/theme";`.
2. Widen the helper to `function renderScreen(mode: CaptureMode = "idea") {`. This is a harness widening; no assertion changes.

Then append:

```tsx
// ── Modes this screen must never route into Contact ───────────────────────────

describe("CaptureScreen — no Contact fallthrough", () => {
  it("renders a note on the text surface, never the Contact card scanner", async () => {
    renderScreen("note");
    expect(await screen.findByPlaceholderText("What's on your mind?")).toBeTruthy();
    expect(screen.queryByText("Scan card")).toBeNull();
  });

  it("does nothing for a mode the screen doesn't serve (a malformed carnet://capture/:mode)", async () => {
    // photo/audio have their own screens. Before the explicit guard, submit's
    // unconditional person fallthrough ran Contact enrichment for ANY mode.
    renderScreen("photo");
    const input = await screen.findByPlaceholderText("Card text — scan or type");
    fireEvent.change(input, { target: { value: "not a card" } });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText("Send")).toBeTruthy(); // back to input
    expect(enrichPerson).not.toHaveBeenCalled();
    expect(writeRawIdea).not.toHaveBeenCalled();
  });
});
```

**`apps/mobile/src/screens/RecentDetailScreen.test.tsx`**: this is a guard that must hold through Tasks 3–7. It still fails first, but not on Re-enrich. Before `modeStamp` has a `note` case, opening *any* note-mode entry crashes the detail screen. `NoteMetaRow.tsx:47` renders `modeStamp(mode).label`, and `modeStamp` returns `undefined`.

First, below `ENRICHED_MD` (`:542`), add:

```tsx
const SYNTHESIS_MD =
  '---\ncreated: 2026-09-13\ntags: [synthesis]\nquestion: "what have I been thinking about"\n---\n# what have I been thinking about\n\nHello body text.\n';
```

Then append inside `describe("RecentDetailScreen — re-enrich family")`:

```tsx
  it("does not offer Re-enrich for a saved answer that reports mode note (Notes/ → note)", async () => {
    // Since Notes/ maps to "note", every saved answer opened from Search,
    // TagBrowser, Todos or Ask arrives with mode "note". It must never be
    // re-enrichable, in every commit of the note-capture work.
    vi.mocked(readNote).mockResolvedValue(SYNTHESIS_MD);
    const { navigation } = renderScreen({
      ...ENTRY,
      mode: "note",
      filepath: "file:///v/Notes/synth.md",
    });
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);

    expect(await screen.findByText("File info")).toBeTruthy();
    expect(screen.queryByText("Re-enrich")).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- vault.test recentDetailView SearchScreen TagBrowserScreen saveFirstRouting CaptureScreen RecentDetailScreen`

Expected: FAIL, with these reasons:
- `inferNoteMode(Notes/)` returns `"idea"`.
- The two whole-map tests see `undefined`/`"Ideas"`.
- There is no "Filter by Note" chip.
- TagBrowser shows "Idea".
- The `saveFirstRouting` import fails to resolve (`Failed to load url ./saveFirstRouting`).
- A note renders "Scan card".
- The photo test sees `enrichPerson` called.

The new RecentDetail guard fails with `TypeError: Cannot read properties of undefined (reading 'label')` at `NoteMetaRow.tsx:47`: the `modeStamp` gap above.

- [ ] **Step 3: Widen `CaptureMode` and create the leaf**

`apps/mobile/src/lib/storage.ts:11`:

```ts
export type CaptureMode = "idea" | "journal" | "person" | "photo" | "audio" | "note";
```

`apps/mobile/src/lib/saveFirstRouting.ts` (new):

```ts
/**
 * Pure mode routing for the save-first text capture path — Idea and Note.
 *
 * A leaf on purpose, with no runtime imports: screens, components and pure lib
 * modules call it without dragging ideaSaveFirst.ts's dispatcher → settings →
 * expo-secure-store chain into their tests, and without tripping the suites
 * that vi.mock ideaSaveFirst wholesale (CaptureScreen, notificationQuickIdea,
 * finishEnrichment), where any NEW export of that module comes back undefined.
 * ideaSaveFirst.ts re-exports what it uses.
 */

import type { CaptureMode } from "./storage";

/** The capture modes written raw first and enriched in place. */
export type SaveFirstTextMode = Extract<CaptureMode, "idea" | "note">;

/** Idea and Note share one text surface and one save-first flow; the mode
 * only picks the folder (Ideas/ vs Notes/) and the prompt. */
export function isSaveFirstTextMode(mode: CaptureMode): mode is SaveFirstTextMode {
  return mode === "idea" || mode === "note";
}
```

- [ ] **Step 4: Route the mode in `vault.ts`**

`subdirForMode`:

```ts
function subdirForMode(mode: CaptureMode): NoteSubdir {
  if (mode === "journal") return "Journal";
  if (mode === "person") return "People";
  if (mode === "note") return "Notes";
  return "Ideas";
}
```

`inferNoteMode`, replacing its doc comment and body:

```ts
/** Infer the capture mode from the note's IMMEDIATE parent subdir. We match the
 * parent segment (not a substring anywhere in the path) so a vault rooted under
 * a folder literally named "Journal"/"People" doesn't misclassify its Ideas.
 *
 * Notes/ holds BOTH captured notes and saved Ask answers; both report "note".
 * Where the two must be told apart (Re-enrich), use isSynthesisNote(markdown)
 * — the folder no longer carries that distinction. */
export function inferNoteMode(uri: string): CaptureMode {
  const parent = parentSegment(uri);
  if (parent === "Journal") return "journal";
  if (parent === "People") return "person";
  if (parent === "Notes") return "note";
  return "idea";
}
```

In `upsertNoteInIndex`, the comment's "including a Notes/ synthesis note" example is no longer true of `subdirForMode`. Replace:

```
  // The uri is authoritative; the mode round-trip is only a fallback. Going
  // through subdirForMode alone would record "Ideas" for anything outside
  // Journal/People — including a Notes/ synthesis note — while a full rebuild
  // reads "Notes" straight off the NoteFileRef, so the same note's subdir
  // flipped on the next pull-to-refresh. subdirForUri returns null outside the
  // known note subdirs, which is when the mode collapse is the best guess left.
```

with:

```
  // The uri is authoritative; the mode round-trip is only a fallback. Before
  // Notes/ had a mode of its own, subdirForMode alone recorded "Ideas" for a
  // Notes/ synthesis note while a full rebuild read "Notes" straight off the
  // NoteFileRef, so the same note's subdir flipped on the next pull-to-refresh.
  // subdirForUri returns null outside the known note subdirs, which is when the
  // mode collapse is the best guess left.
```

- [ ] **Step 5: Fix the display sites**

`apps/mobile/src/lib/recentDetailView.ts`:

1. Add `import type { NoteSubdir } from "./noteSubdirs";` below the `./storage` import.
2. Change `formatMode`'s doc to `/** Human label for a capture mode — the File info dialog and the Capture screen's header title. */`.
3. Add a case after `"idea"`:

```ts
    case "note":
      return "Note";
```

4. Replace `relatedSubdirForMode`:

```ts
export function relatedSubdirForMode(mode: CaptureEntry["mode"]): NoteSubdir {
  if (mode === "journal") return "Journal";
  if (mode === "person") return "People";
  if (mode === "note") return "Notes";
  return "Ideas";
}
```

`apps/mobile/src/components/NoteCard.tsx`: in `modeStamp`, after the `"idea"` case:

```ts
    case "note":
      return { label: "Note", icon: "checkbox-marked-outline" };
```

`apps/mobile/src/screens/SearchScreen.tsx`:

```ts
/** Capture modes that can appear in the note index — one per note subdir
 * (noteSubdirs.ts): Ideas/ → idea, Journal/ → journal, People/ → person,
 * Notes/ → note. The Note chip therefore finds captured notes AND saved Ask
 * answers, which share Notes/ (the #synthesis tag tells them apart). photo and
 * audio never appear as their own mode — their notes land in Ideas/. */
const MODE_FILTERS: readonly CaptureMode[] = ["idea", "note", "journal", "person"];
```

`apps/mobile/src/screens/TagBrowserScreen.tsx`:

```ts
function modeLabel(mode: CaptureMode): string {
  if (mode === "journal") return "Journal";
  if (mode === "person") return "Contact";
  if (mode === "note") return "Note";
  return "Idea";
}

function modeIcon(mode: CaptureMode): string {
  if (mode === "journal") return "notebook-outline";
  if (mode === "person") return "account-outline";
  if (mode === "note") return "checkbox-marked-outline";
  return "lightbulb-outline";
}
```

`apps/mobile/src/lib/noteRelated.ts`: replace the comment

```
      // The uri is authoritative — relatedSubdirForMode(entry.mode) is kept
      // only as a fallback, since inferNoteMode collapses any unrecognized
      // parent (e.g. Notes/) to "idea" and would wrongly self-exclude against
      // Ideas/ for those notes.
```

with:

```
      // The uri is authoritative — relatedSubdirForMode(entry.mode) is kept
      // only as a fallback: an entry's mode can lag its folder (a Notes/ row
      // cached before Notes/ mapped to "note" still says "idea"), and
      // inferNoteMode collapses any unrecognized parent to "idea".
```

`apps/mobile/src/lib/noteRelated.test.ts`: this is a comment and title update only. The test's `mode: "idea"` for a `Notes/` path stays, because it now models the stale-cached-row case (accepted risk R2). Retitle it to `"excludes a Notes/ note against Notes/, not Ideas/, even when its entry still says idea"`. Then replace its opening comment (`:125-132`, "inferNoteMode falls back to "idea"… real related hit.") with:

```
    // An entry's mode can lag its folder: recents rows and cached index rows
    // written before Notes/ mapped to "note" still say "idea" until the next
    // refresh. Under a mode-derived subdir the query would carry "Ideas"
    // (relatedSubdirForMode("idea")) and wrongly exclude this same-basename
    // Ideas/ note as "self" — dropping a genuinely related note. The
    // uri-derived subdir ("Notes") doesn't match "Ideas", so it survives.
```

- [ ] **Step 6: Keep the capture surface out of the Contact path**

`apps/mobile/src/components/CaptureModeInput.tsx`:
- Add `import { isSaveFirstTextMode } from "../lib/saveFirstRouting";` after the `../lib/storage` type import.
- Change `if (mode === "idea") {` (`:38`) to `if (isSaveFirstTextMode(mode)) {`.

`apps/mobile/src/screens/CaptureScreen.tsx:848`: replace the one line `    // mode === "person"` with the one line:

```ts
    if (mode !== "person") return setPhase("input"); // mode === "person" below; any other mode is a malformed carnet://capture/:mode
```

**Keep the literal `// mode === "person"` in that comment.** `settings.test.ts:169-174` ("Person + Journal ignore previewBeforeSave") reads `CaptureScreen.tsx` as text and anchors on `source.indexOf('// mode === "person"')`. If the anchor disappears, that test fails with `expected -1 to be greater than or equal to 0`. It must stay green unmodified. The test at `:158-167` likewise requires that nothing from `if (mode === "journal") {` onward mentions `previewBeforeSave`.

`apps/mobile/App.tsx`:
- Add `import { formatMode } from "./src/lib/recentDetailView";` after `import { carnetDark, carnetLight } from "./src/lib/theme";`.
- Replace the Capture screen's `options={({ route }) => ({ title: route.params.mode === "idea" ? "Idea" : … : "Contact" })}` block with the following. The ternary chain titled a note "Contact"; `formatMode` gives the same labels for idea, journal and person.

```tsx
                  options={({ route }) => ({ title: formatMode(route.params.mode) })}
```

- [ ] **Step 7: Run the focused tests, then the mobile gate**

Run: `npm -w @carnet/mobile test -- vault.test recentDetailView SearchScreen TagBrowserScreen saveFirstRouting CaptureScreen RecentDetailScreen noteRelated settings.test`
Expected: PASS.

Then run the **mobile gate**, and `wc -l apps/mobile/src/screens/CaptureScreen.tsx`.
Expected: clean, and `1105` (the guard replaced one line with one line).

- [ ] **Step 8: Commit**

```bash
git status --short   # expect only the paths below, plus the pre-existing "?? AGENTS.md"
git add apps/mobile/src/lib/storage.ts \
        apps/mobile/src/lib/vault.ts apps/mobile/src/lib/vault.test.ts \
        apps/mobile/src/lib/recentDetailView.ts apps/mobile/src/lib/recentDetailView.test.ts \
        apps/mobile/src/lib/noteRelated.ts apps/mobile/src/lib/noteRelated.test.ts \
        apps/mobile/src/lib/saveFirstRouting.ts apps/mobile/src/lib/saveFirstRouting.test.ts \
        apps/mobile/src/components/NoteCard.tsx apps/mobile/src/components/CaptureModeInput.tsx \
        apps/mobile/src/screens/SearchScreen.tsx apps/mobile/src/screens/SearchScreen.test.tsx \
        apps/mobile/src/screens/TagBrowserScreen.tsx apps/mobile/src/screens/TagBrowserScreen.test.tsx \
        apps/mobile/src/screens/CaptureScreen.tsx apps/mobile/src/screens/CaptureScreen.test.tsx \
        apps/mobile/src/screens/RecentDetailScreen.test.tsx \
        apps/mobile/App.tsx
git commit -m "feat(note): add the note CaptureMode, map Notes/ to it, and label it everywhere"
```

---

### Task 4: `enrichNote` through llmClient and the dispatcher, plus the `note` prompt override

**Files:**
- Modify: `apps/mobile/src/lib/llmClient.ts`: add `buildNotePrompt` to the `./prompts` import (`:43-54`), add `enrichNote` after `enrichIdea` (`:327-349`), and update the module header's mode list (`:18-22`).
- Modify: `apps/mobile/src/lib/dispatcher.ts`: add `enrichNote` after `enrichIdea` (`:300-318`).
- Modify: `apps/mobile/src/lib/settings.ts`: `PromptOverrides` (`:71-85`).
- Modify: `apps/mobile/src/lib/settingsTransfer.ts`: `PROMPT_OVERRIDE_KEYS` (`:175-183`).
- Modify: `apps/mobile/src/components/PromptOverridesSection.tsx`: import (`:6-14`), `PROMPT_MODES` (`:17-28`), and the exhaustive `defaultPromptFor` (`:35-52`).
- Test: `apps/mobile/src/lib/llmClient.test.ts`, `apps/mobile/src/lib/dispatcher.test.ts`, `apps/mobile/src/lib/settingsTransfer.test.ts`

**Interfaces:**
- Consumes: `buildNotePrompt` and `NoteType "note"` from Task 1, plus `withTagHint`, `withSystemOverride`, `getVaultTagStrings(profileId?)`, `withFallbackChain` and `withFallbackMarker`.
- Produces:
  - `llmClient.enrichNote(text: string, config: ProviderConfig, override?: string, availableTags: string[] = []): Promise<EnrichResult>`. It passes `"note"` to `chatCompletion`.
  - `dispatcher.enrichNote(text: string, options?: EnrichmentOptions): Promise<EnrichResult>`. This is an exact copy of `enrichIdea`'s shape: vault tags come from `options?.vaultContext?.profileId`, and `overrides.note` is used.
  - `PromptOverrides.note?: string`

There is only one `enrichNote` per layer. `localLlm.ts` no longer exists: it was merged into `llmClient.ts`.

**Read this before editing `PROMPT_OVERRIDE_KEYS`.** The comment at `settingsTransfer.ts:170-174` says it all. The key list is a **validator** used by `isPromptOverrides`, not a filter. An unlisted key fails shape validation and the whole import is refused. Add `"note"` to both `settings.ts` and `settingsTransfer.ts` in this task.

The compatibility cost is accepted (decision 2; see risk R1). An older build refuses a newer export that carries a `note` override. The export `version` stays `1`, so do not bump it.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/lib/llmClient.test.ts`, add `enrichNote,` to the `./llmClient` import list and `buildNotePrompt,` to the `./prompts` import list, then append:

```ts
describe("enrichNote", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  function systemOf(call: number = 0): string {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return (JSON.parse(init.body as string) as RequestBody).messages[0].content;
  }

  it("sends the note prompt, not the idea prompt", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\ncreated: 2026-09-27\ntags: [note]\n---\n# x\n"),
    );
    await enrichNote("- [ ] call the dentist", CONFIG);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as RequestBody;
    const prompt = buildNotePrompt("- [ ] call the dentist");
    expect(body.messages[0].content).toBe(prompt.system);
    expect(body.messages[1].content).toBe(prompt.user);
  });

  it("normalizes the reply with the note shape (created, tags), not idea's", async () => {
    // Proves chatCompletion gets noteType "note": under "idea" the missing
    // `status` fails normalization and the keys come back in reply order.
    fetchMock.mockResolvedValueOnce(
      makeOkResponse(
        "---\ntags: [note, errands]\ncreated: 2026-09-27\n---\n# Errands\n\n- [ ] call the dentist\n",
      ),
    );
    const result = await enrichNote("call the dentist", CONFIG);
    expect(result.markdown).toBe(
      "---\ncreated: 2026-09-27\ntags: [note, errands]\n---\n# Errands\n\n- [ ] call the dentist\n",
    );
  });

  it("honours a prompt override", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));
    await enrichNote("text", CONFIG, "My own note instructions.");
    expect(systemOf()).toBe("My own note instructions.");
  });

  it("keeps the vault tag vocabulary on an overridden system prompt", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));
    await enrichNote("text", CONFIG, "My own note instructions.", ["errands"]);
    expect(systemOf()).toContain("My own note instructions.");
    expect(systemOf()).toContain("errands");
  });
});
```

In `apps/mobile/src/lib/dispatcher.test.ts`, add `enrichNote,` to the `./dispatcher` import list, then append at the end of the file:

```ts
// ── note capture mode ─────────────────────────────────────────────────────────

describe("dispatcher enrichNote", () => {
  function systemOf(call = 0): string {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return (JSON.parse(init.body as string) as { messages: Array<{ content: string }> })
      .messages[0].content;
  }

  // The vault-tag block above installs a persistent per-profile
  // implementation (no restoreMocks in vitest.config.ts); start clean.
  beforeEach(() => {
    vi.mocked(getVaultTagStrings).mockReset().mockResolvedValue([]);
  });

  it("forwards overrides.note — never overrides.idea", async () => {
    vi.mocked(getPromptOverrides).mockResolvedValueOnce({
      idea: "OVERRIDE-IDEA-7f3a",
      note: "OVERRIDE-NOTE-4c7a",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichNote("text");

    expect(systemOf()).toBe("OVERRIDE-NOTE-4c7a");
  });

  it("uses the capture's vault tags after the active profile has switched", async () => {
    vi.mocked(getVaultTagStrings).mockImplementation(
      async (profileIdOrLimit?: string | number) => {
        const profileId = typeof profileIdOrLimit === "string" ? profileIdOrLimit : undefined;
        return profileId === "personal" ? ["personal-only"] : ["work-secret"];
      },
    );
    fetchMock.mockResolvedValueOnce(makeOkResponse("---\n---\n# x\n"));

    await enrichNote("deferred A capture", {
      vaultContext: { profileId: "personal", rootUri: "file:///personal" },
    });

    expect(getVaultTagStrings).toHaveBeenCalledWith("personal");
    expect(systemOf()).toContain("personal-only");
    expect(systemOf()).not.toContain("work-secret");
  });
});
```

In `apps/mobile/src/lib/settingsTransfer.test.ts`, the test `"round-trips every prompt override key, including the two non-capture-mode ones"` (`:85`) is the allowlist guard. Add `note: "Keep my lines",` to its `overrides` fixture. This extends the guard to the new key, which is its purpose. The title stays accurate.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- llmClient.test dispatcher.test settingsTransfer`
Expected: FAIL.
- The llmClient and dispatcher tests fail with `TypeError: enrichNote is not a function`.
- The transfer round-trip throws `This settings export is incomplete or malformed.`, because `note` is not in the allowlist.

- [ ] **Step 3: Add `llmClient.enrichNote`**

Add `buildNotePrompt,` to the `./prompts` import in `apps/mobile/src/lib/llmClient.ts`, then add directly after `enrichIdea`:

```ts
/** Enrich a captured note. Unlike enrichIdea, the prompt keeps the user's
 * lines and only adds a title, tags and checkboxes — see buildNotePrompt.
 * Normalized as noteType "note" (created, tags): "idea" would fail
 * normalization on the `status` key the note prompt never emits. */
export async function enrichNote(
  text: string,
  config: ProviderConfig,
  override?: string,
  availableTags: string[] = [],
): Promise<EnrichResult> {
  const model = assertModelConfigured(config.model, config.label);
  const base = withSystemOverride(buildNotePrompt(text), override);
  // The hint goes on the FINAL system string: withSystemOverride replaces
  // the whole message, so hinting before the override would lose it.
  const pair = { ...base, system: withTagHint(base.system, availableTags) };
  return chatCompletion(
    config.baseUrl,
    config.apiKey,
    model,
    pair,
    "note",
    config.label,
    resolveEnrichmentTimeoutMs(config.baseUrl),
    config.allowInsecureTransport ?? false,
  );
}
```

In the module header's "Each method corresponds to one capture mode" list, add a line after `enrichIdea`:

```
 *   enrichNote    — task list / working notes → titled, tagged, never expanded
```

- [ ] **Step 4: Add `dispatcher.enrichNote`**

In `apps/mobile/src/lib/dispatcher.ts`, directly after `enrichIdea`:

```ts
export async function enrichNote(
  text: string,
  options?: EnrichmentOptions,
): Promise<EnrichResult> {
  // Same shape as enrichIdea: the vocabulary comes from the capture's own
  // profile (options.vaultContext), never whichever profile is active now.
  const [settings, overrides, vaultTags] = await Promise.all([
    getSettings(),
    getPromptOverrides(),
    getVaultTagStrings(options?.vaultContext?.profileId),
  ]);
  const availableTags = settings.useExistingTagsForAutoTag ? vaultTags : [];
  const outcome = await withFallbackChain(settings, settings.activeProviderId, (config) =>
    llmClient.enrichNote(text, config, overrides.note, availableTags),
  );
  return withFallbackMarker(outcome);
}
```

- [ ] **Step 5: Add the `note` override key in all three places**

In `apps/mobile/src/lib/settings.ts`'s `PromptOverrides`, after `sharedLink?: string;`:

```ts
  /** Override for the note capture prompt (buildNotePrompt). */
  note?: string;
```

and in the `enhanceProse` doc on the next field, change `Unlike the five\n   * capture modes above` to `Unlike the capture\n   * modes above`.

In `apps/mobile/src/lib/settingsTransfer.ts`, append `"note",` as the last entry of `PROMPT_OVERRIDE_KEYS`, after `"retrospective",`.

In `apps/mobile/src/components/PromptOverridesSection.tsx`, make three changes:

1. Add `buildNotePrompt,` to the `../lib/prompts` import.
2. In `PROMPT_MODES`, add after the `idea` row:

```ts
  { key: "note", label: "Note", icon: "checkbox-marked-outline" },
```

3. In `defaultPromptFor`, which `tsc` now forces to be exhaustive, add after the `"idea"` case:

```ts
    case "note":
      return buildNotePrompt("placeholder").system;
```

- [ ] **Step 6: Run the focused tests, then the mobile gate**

Run: `npm -w @carnet/mobile test -- llmClient.test dispatcher.test settingsTransfer`
Expected: PASS.

Then run the **mobile gate**.
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/llmClient.ts apps/mobile/src/lib/llmClient.test.ts \
        apps/mobile/src/lib/dispatcher.ts apps/mobile/src/lib/dispatcher.test.ts \
        apps/mobile/src/lib/settings.ts \
        apps/mobile/src/lib/settingsTransfer.ts apps/mobile/src/lib/settingsTransfer.test.ts \
        apps/mobile/src/components/PromptOverridesSection.tsx
git commit -m "feat(note): add vault-pinned enrichNote and the note prompt override"
```

---

### Task 5: Pin Drive Inbox's receipt resume, then teach the save-first flow to serve notes

This task makes two commits. The first is a characterization test of today's behaviour, landed **before** any generalisation (decision 3). The second is the generalisation itself.

**Files:**
- Test only (commit 1): `apps/mobile/src/lib/notificationQuickIdea.test.ts`. Append a new describe and change no existing line.
- Modify (commit 2): `apps/mobile/src/lib/ideaSaveFirst.ts`, `apps/mobile/src/lib/saveFirstRouting.ts`
- Test (commit 2): `apps/mobile/src/lib/ideaSaveFirst.test.ts`, `apps/mobile/src/lib/saveFirstRouting.test.ts`
- **Not touched:** `apps/mobile/src/lib/notificationQuickIdea.ts`

**Interfaces:**
- Consumes: `writeNote` (Task 2), `dispatcher.enrichNote` (Task 4), and `SaveFirstTextMode` (Task 3).
- Produces:
  - `saveFirstModeOf(input: { mode?: SaveFirstTextMode }): SaveFirstTextMode`, in `saveFirstRouting.ts`. An absent mode means `"idea"`.
  - `RawIdeaInput` **stays the idea-only shape**: `mode?: "idea"` and `receiptId?: string`. This is why `notificationQuickIdea.ts:160` (`const ctx: RawIdeaInput = { text, tags: [] }`) and `:213` (`{ ...ctx, receiptId }`) compile unchanged.
  - `RawNoteInput`: `mode: "note"` and `receiptId?: never`.
  - `RawCaptureInput = RawIdeaInput | RawNoteInput`.
  - `RewriteRawIdeaInput = RawCaptureInput & { filepath: string }`. It is now a type alias, because an interface cannot extend a union.
  - `buildRawIdeaMarkdown(input: RawCaptureInput, …)`: throws if a receipt meets a non-idea mode.
  - `writeRawIdea(input: RawCaptureInput, now?, root?)`: routes `writeNote` or `writeIdea`, and keeps the `root` branch.
  - `rewriteRawIdea(input: RewriteRawIdeaInput, now?)`
  - `deriveRawIdeaSlug(text, mode = "idea")`: the fallback slug is the mode's name.
  - `EnrichIdeaInPlaceInput.mode?: SaveFirstTextMode`: `enrichIdeaInPlace` routes `enrichNote` or `enrichIdea`, still passing `{ vaultContext }`.
  - Re-exports: `isSaveFirstTextMode`, `saveFirstModeOf`, `type SaveFirstTextMode`.

All of these shapes, including the `notificationQuickIdea.ts` lines, were compiled in isolation with the repo's `tsc --strict`.

- [ ] **Step 1: Characterize the receipt-resume path (today's behaviour)**

Nothing tests this path today: every other test in the file lists an empty vault. Append to `apps/mobile/src/lib/notificationQuickIdea.test.ts`. Change nothing above it, so the Drive Inbox gate's "no existing line changed" check holds:

```ts
// ── Drive Inbox receipt resume (characterization — note-capture-mode Task 5) ─
//
// Pinned BEFORE ideaSaveFirst learns the note mode. findReceiptRawNote scans
// Ideas/ only — which is why a Drive Inbox receipt must never be written as a
// note: its raw file would land in Notes/, a restarted task would never find
// it, and the retry would write a duplicate.

describe("handleQuickIdeaCapture — Drive Inbox receipt resume", () => {
  const RECEIPT = "55555555-5555-5555-5555-555555555555";
  const CONTEXT = { profileId: "receipt-profile", rootUri: "file:///receipt-vault" };
  const MARKED = `---\ncreated: 2026-09-27\nstatus: pending-enrich\ncarnet_drive_inbox_receipt: ${RECEIPT}\n---\ncar reply\n`;

  it("resumes the raw note already in Ideas/ instead of writing a second one", async () => {
    const { extractFrontmatterField } = await import("./frontmatter");
    // Once: the scan reads exactly one file (the Ideas/ one), so nothing leaks
    // into later tests — this file's beforeEach never resets this mock.
    vi.mocked(extractFrontmatterField).mockImplementationOnce((markdown, field) =>
      field === "carnet_drive_inbox_receipt" && markdown.includes(RECEIPT) ? RECEIPT : null,
    );
    listNoteFilesInRootMock.mockResolvedValueOnce([
      { uri: "file:///receipt-vault/Notes/car-reply.md", name: "car-reply.md", subdir: "Notes" },
      { uri: "file:///receipt-vault/Ideas/car-reply.md", name: "car-reply.md", subdir: "Ideas" },
    ] as never[]);
    readNoteMock.mockResolvedValue(MARKED);
    enrichIdeaInPlaceMock.mockResolvedValue({ kind: "updated" });

    const result = await handleQuickIdeaCapture("car reply", CONTEXT, RECEIPT);

    expect(result).toEqual({ kind: "enriched" });
    expect(writeRawIdeaMock).not.toHaveBeenCalled();
    // The Notes/ entry carries the same marker but is never even read.
    expect(readNoteMock).toHaveBeenCalledTimes(1);
    expect(readNoteMock).toHaveBeenCalledWith("file:///receipt-vault/Ideas/car-reply.md");
    expect(enrichIdeaInPlaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filepath: "file:///receipt-vault/Ideas/car-reply.md",
        expectedContent: MARKED,
        vaultContext: CONTEXT,
      }),
    );
    expect(completeDriveInboxReceiptMock).toHaveBeenCalledWith(RECEIPT);
  });
});
```

Run: `npm -w @carnet/mobile test -- notificationQuickIdea`
Expected: PASS on the current code. This is a characterization test, so there is no red phase.

Then run the **mobile gate** and the **Drive Inbox gate**.
Expected: clean, with all three gate lines as listed.

```bash
git add apps/mobile/src/lib/notificationQuickIdea.test.ts
git commit -m "test(drive-inbox): characterize the Ideas/-only receipt resume path"
```

- [ ] **Step 2: Write the failing tests for the generalisation**

In `apps/mobile/src/lib/saveFirstRouting.test.ts`, change the import to `import { isSaveFirstTextMode, saveFirstModeOf } from "./saveFirstRouting";` and append:

```ts
describe("saveFirstModeOf", () => {
  it("reads the input's mode", () => {
    expect(saveFirstModeOf({ mode: "note" })).toBe("note");
    expect(saveFirstModeOf({ mode: "idea" })).toBe("idea");
  });

  it("treats a missing mode as idea — every pre-Note caller builds its input without one", () => {
    expect(saveFirstModeOf({})).toBe("idea");
  });
});
```

In `apps/mobile/src/lib/ideaSaveFirst.test.ts`, make these harness additions: the new code path reaches `llmClient.enrichNote` through the real dispatcher.
- Add `const enrichNoteMock = vi.fn();` next to `enrichIdeaMock`.
- Add `enrichNote: (...args: unknown[]) => enrichNoteMock(...args),` to the `vi.mock("./llmClient", …)` factory, after `enrichIdea`.
- Add `enrichNoteMock.mockReset();` to the top-level `beforeEach`, after `enrichIdeaMock.mockReset();`.
- Add `type RawCaptureInput,` to the `./ideaSaveFirst` import list.
- Add `import { resolveProfileRoot } from "./vaultRoot";` after the `./vaultTagHint` import.

Then append:

```ts
// ── note mode (note-capture-mode Task 5) ─────────────────────────────────────

describe("save-first note mode", () => {
  const NOTE_MD =
    "---\ncreated: 2026-09-27\ntags: [note, errands]\n---\n# Weekend errands\n\n- [ ] call the dentist\n";

  it("writes a raw note under Notes/, not Ideas/", async () => {
    const { filepath, markdown } = await writeRawIdea({
      mode: "note",
      text: "Weekend errands\n- [ ] call the dentist",
      tags: [],
    });
    expect(filepath).toBe("file:///data/carnet/Notes/weekend-errands.md");
    expect(markdown).toContain(`status: ${PENDING_ENRICH_STATUS}`);
    expect(markdown).toContain("- [ ] call the dentist");
  });

  it("writes a raw note into the pinned vault root", async () => {
    const root = resolveProfileRoot({ rootUri: "file:///data/work-vault" });
    const { filepath } = await writeRawIdea({ mode: "note", text: "pinned", tags: [] }, undefined, root);
    expect(filepath).toBe("file:///data/work-vault/Notes/pinned.md");
  });

  it("still writes an idea under Ideas/ when no mode is given", async () => {
    const { filepath } = await writeRawIdea({ text: "Build a kite", tags: [] });
    expect(filepath).toBe("file:///data/carnet/Ideas/build-a-kite.md");
  });

  it("falls back to the mode's name for text that slugifies to nothing", () => {
    expect(deriveRawIdeaSlug("🚀", "note")).toBe("note");
    expect(deriveRawIdeaSlug("🚀")).toBe("idea");
  });

  it("enriches a note through the note prompt and never the idea prompt", async () => {
    const { filepath, mtime } = await writeRawIdea({ mode: "note", text: "call the dentist", tags: [] });
    enrichNoteMock.mockResolvedValue({ markdown: NOTE_MD, model: "test" });

    const outcome = await enrichIdeaInPlace({
      mode: "note",
      filepath,
      expectedMtime: mtime,
      text: "call the dentist",
      tags: [],
    });

    expect(outcome).toEqual({ kind: "updated", markdown: NOTE_MD });
    expect(enrichNoteMock).toHaveBeenCalledTimes(1);
    expect(enrichIdeaMock).not.toHaveBeenCalled();
    expect(_files.get(filepath)!.content).toBe(NOTE_MD);
  });

  it("uses the note's captured profile tags after the active profile changes", async () => {
    const { filepath, mtime } = await writeRawIdea({ mode: "note", text: "personal note", tags: [] });
    vi.mocked(getVaultTagStrings).mockImplementation(async (profileIdOrLimit?: string | number) =>
      typeof profileIdOrLimit === "string" && profileIdOrLimit === "personal"
        ? ["personal-only"]
        : ["work-secret"],
    );
    enrichNoteMock.mockResolvedValue({ markdown: NOTE_MD, model: "test" });

    await enrichIdeaInPlace({
      mode: "note",
      filepath,
      expectedMtime: mtime,
      text: "personal note",
      tags: [],
      vaultContext: { profileId: "personal", rootUri: "file:///personal" },
    });

    expect(getVaultTagStrings).toHaveBeenCalledWith("personal");
    expect(enrichNoteMock.mock.calls[0]?.[0]).toBe("personal note");
    expect(enrichNoteMock.mock.calls[0]?.[3]).toEqual(["personal-only"]);
  });

  it("refuses a Drive Inbox receipt on a note at compile time", () => {
    // @ts-expect-error — receipts are idea-only (findReceiptRawNote scans Ideas/ only)
    const bad: RawCaptureInput = { mode: "note", text: "car reply", tags: [], receiptId: "55555555-5555-5555-5555-555555555555" };
    expect(bad.mode).toBe("note");
  });

  it("refuses a Drive Inbox receipt on a note at runtime, before anything is written", async () => {
    // Headless-task data crosses the native bridge untyped; the type alone
    // cannot hold the line.
    const bad = {
      mode: "note",
      text: "car reply",
      tags: [],
      receiptId: "55555555-5555-5555-5555-555555555555",
    } as unknown as RawCaptureInput;
    await expect(writeRawIdea(bad)).rejects.toThrow(
      "A Drive Inbox receipt can only be written as an idea.",
    );
    expect(_files.size).toBe(0);
  });
});
```

The `@ts-expect-error` must stay directly above a **single-line** declaration: the error is reported on that line, and `tsc` covers test files.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- ideaSaveFirst saveFirstRouting`
Expected: FAIL.
- `saveFirstModeOf is not a function`.
- The note is written to `Ideas/`.
- The note enrichment comes back `{ kind: "failed" }`: it went to the reset `enrichIdeaMock`, which returns `undefined`, so `enrichNoteMock` is never called.
- The `"note"` slug fallback returns `"idea"`.
- The runtime receipt test resolves instead of rejecting.

`npm -w @carnet/mobile run typecheck` also fails, with:
- TS2305 for `RawCaptureInput`
- TS2724 for `saveFirstModeOf`
- TS2353 for `mode`
- TS2554 for `deriveRawIdeaSlug`'s second argument
- TS2578 for the not-yet-needed `@ts-expect-error`

- [ ] **Step 4: Add `saveFirstModeOf` to the leaf**

Append to `apps/mobile/src/lib/saveFirstRouting.ts`:

```ts
/** The mode a save-first input routes as. Absent means idea — every caller
 * that predates Note (notificationQuickIdea's quick-reply and Drive Inbox
 * path, persisted queue rows) builds its input without one. */
export function saveFirstModeOf(input: { mode?: SaveFirstTextMode }): SaveFirstTextMode {
  return input.mode ?? "idea";
}
```

- [ ] **Step 5: Generalise `ideaSaveFirst.ts` by mode**

**Imports.**
- Add `writeNote,` to the `./writer` import.
- Add `enrichNote,` to the `./dispatcher` import.
- After `import type { VaultContext } from "./vaultContext";`, add:

```ts
import { saveFirstModeOf, type SaveFirstTextMode } from "./saveFirstRouting";

// Defined in the leaf ./saveFirstRouting (its header says why); re-exported so
// this module's API still names the whole save-first surface.
export { isSaveFirstTextMode, saveFirstModeOf, type SaveFirstTextMode } from "./saveFirstRouting";
```

**Module header.** Replace the paragraph `Journal and Person are intentionally NOT routed through this module: … Only Idea is save-first, and only when Settings.previewBeforeSave is off (the default).` with:

```
 * Journal and Person are intentionally NOT routed through this module: Journal
 * keeps its deferred-write model and Person keeps enrich-then-preview. Idea and
 * Note are save-first; `mode` (default "idea") picks the folder — Ideas/ vs
 * Notes/ — and the prompt — enrichIdea vs enrichNote. Idea may opt back into
 * the blocking preview (Settings.previewBeforeSave, see usesSaveFirst); a Note
 * never does.
```

**Input types.** Replace the `RawIdeaInput` interface (`:78-91`) with:

```ts
/** Fields every save-first text capture carries. Attachments are the
 * post-write rel-path references (binaries already on disk), matching the
 * online + offline paths so all three inject identically. */
interface RawCaptureFields {
  /** The user's raw text — becomes the note body verbatim. */
  text: string;
  /** User-entered tags, merged into the frontmatter deterministically. */
  tags: string[];
  /** User-selected `lat,lon`, injected into frontmatter when set. */
  location?: string;
  attachments?: AttachmentRef[];
}

/** A save-first Idea. `mode` is optional so every pre-Note caller —
 * notificationQuickIdea.ts above all — compiles and routes unchanged. */
export interface RawIdeaInput extends RawCaptureFields {
  mode?: "idea";
  /** Native Android Auto receipt; omitted for normal in-app/notification ideas. */
  receiptId?: string;
}

/** A save-first Note (Notes/, note prompt). Never carries a Drive Inbox
 * receipt: a restarted headless task finds its raw note by scanning Ideas/
 * only (notificationQuickIdea.ts findReceiptRawNote), so a receipt on a Notes/
 * file would never be found and the retry would write a duplicate. */
export interface RawNoteInput extends RawCaptureFields {
  mode: "note";
  receiptId?: never;
}

/** Everything the save-first write accepts. */
export type RawCaptureInput = RawIdeaInput | RawNoteInput;

/** Runtime backstop for RawNoteInput's `receiptId?: never`: headless-task data
 * crosses the native bridge untyped, so the type alone can't hold the line. */
function assertReceiptIsIdeaOnly(input: RawCaptureInput): void {
  if (input.receiptId !== undefined && saveFirstModeOf(input) !== "idea") {
    throw new Error("A Drive Inbox receipt can only be written as an idea.");
  }
}
```

**`deriveRawIdeaSlug`.** Change the signature to `export function deriveRawIdeaSlug(text: string, mode: SaveFirstTextMode = "idea"): string`, and its last line to `return slugify(firstLine.slice(0, 80)) || mode;`. In its doc, change `Falls back to "idea"` to `Falls back to the mode's name ("idea"/"note")`.

**`buildRawIdeaMarkdown`.** Change the parameter type to `input: RawCaptureInput`, and make its first statement:

```ts
  assertReceiptIsIdeaOnly(input);
```

**`writeRawIdea`.** Replace it with:

```ts
export async function writeRawIdea(
  input: RawCaptureInput,
  now?: Date,
  root?: Root,
): Promise<WriteRawIdeaResult> {
  const mode = saveFirstModeOf(input);
  const slug = deriveRawIdeaSlug(input.text, mode);
  const markdown = buildRawIdeaMarkdown(input, now);
  // Same raw stub, same collision suffixing, same pinned root — only the
  // folder differs: Notes/ for a note, Ideas/ for an idea.
  const write = mode === "note" ? writeNote : writeIdea;
  const { filepath } = root
    ? await write(slug, markdown, root)
    : await write(slug, markdown);
  const mtime = await getModificationTime(filepath);
  return { filepath, slug, mtime, markdown };
}
```

**`RewriteRawIdeaInput`.** Replace the interface with:

```ts
/** A revised draft plus the already-on-disk note it overwrites — NOT re-derived
 * from the text. A type alias: an interface can't extend the RawCaptureInput
 * union. */
export type RewriteRawIdeaInput = RawCaptureInput & { filepath: string };
```

`rewriteRawIdea`'s body is unchanged. It rewrites in place, so the folder never changes.

**`EnrichIdeaInPlaceInput`.** Add after `expectedMtime`:

```ts
  /** Which prompt enriches it: "note" → enrichNote (tidy, never expand);
   * absent or "idea" → enrichIdea. Must match the mode of the raw write. */
  mode?: SaveFirstTextMode;
```

**`enrichIdeaInPlace`.** Replace the first line of its `try` body with:

```ts
    const enrich = saveFirstModeOf(input) === "note" ? enrichNote : enrichIdea;
    const result = await enrich(input.text, { vaultContext: input.vaultContext });
```

Leave everything else untouched: error classification, the transient/permanent split, `applyEnrichedIdea`, `NEVER_PRESERVED_FIELDS` and the conflict guard. They are mode-independent.

- [ ] **Step 6: Run the focused tests, then both gates**

Run: `npm -w @carnet/mobile test -- ideaSaveFirst saveFirstRouting notificationQuickIdea`
Expected: PASS. The pre-existing `ideaSaveFirst` tests are still green, because a missing mode means idea.

Then run the **mobile gate** and the **Drive Inbox gate**.
Expected: all clean, and all three Drive Inbox lines as listed.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/ideaSaveFirst.ts apps/mobile/src/lib/ideaSaveFirst.test.ts \
        apps/mobile/src/lib/saveFirstRouting.ts apps/mobile/src/lib/saveFirstRouting.test.ts
git commit -m "feat(note): route the save-first flow by mode, keeping Drive Inbox receipts idea-only"
```

---

### Task 6: Offline queue: `NotePayload`, a derived `CaptureMode`, and an exhaustive drain

**Files:**
- Modify: `apps/mobile/src/lib/queue.ts`:
  - imports (`:35-52`, `:58`)
  - `CaptureMode` (`:71`)
  - add `NotePayload` after `IdeaPayload` (`:78-100`)
  - `QueuePayload` (`:128-130`)
  - `processRow` (`:384-448`)
- Test: `apps/mobile/src/lib/queue.test.ts`

**Interfaces:**
- Consumes: `dispatcher.enrichNote(text, { vaultContext })` (Task 4) and `writeNote(slug, md, root)` (Task 2).
- Produces:
  - `NotePayload extends Omit<IdeaPayload, "mode"> { mode: "note" }`. It has the same attachments, tags, location, save-first `filepath` and `baseline*` fields as `IdeaPayload`.
  - `QueuePayload = (IdeaPayload | JournalPayload | PersonPayload | NotePayload) & { vaultContext?: VaultContext }`. The intersection that #219 pinning depends on is kept.
  - The queue's `CaptureMode = QueuePayload["mode"]`, derived and so never re-declared. It is plaintext row metadata only: `HomeScreen.tsx:532` stamps it with `modeStamp`. The drain routes on the decrypted `payload.mode`.

There is no "refuse" logic to add. Pinning is `enqueue`'s captured `vaultContext` (`:295-297`) plus `resolveContextRoot` at drain time. Legacy rows fall back to `legacyQueueContext`.

`processRow` today is an if/else-if chain with **no else**. An unroutable row returns normally and `drainQueue` removes it (`:357`) as if it had drained. Decision 10 replaces that with an exhaustive `never` else that throws. The row then burns attempts and ends up failed, visible in the Sync dialog, instead of silently disappearing.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/lib/queue.test.ts`, make these harness additions, which the new drain paths need:

1. In the `vi.mock("./llmClient", …)` factory, after `enrichIdea`:

```ts
  enrichNote: vi.fn().mockResolvedValue({
    markdown: "---\ncreated: 2026-09-27\ntags: [note]\n---\n# Test Note\n\n- [ ] call the dentist\n",
    model: "test",
  }),
```

2. In the `vi.mock("./writer", …)` factory, after `writeIdea`:

```ts
  writeNote: vi.fn().mockResolvedValue({ filepath: "file:///carnet/Notes/test-note.md" }),
  // The save-first (filepath) drain path updates in place; it had no double.
  updateNoteIfUnchanged: vi.fn().mockResolvedValue({ ok: true }),
```

Then append:

```ts
// ── note payloads (note-capture-mode Task 6) ─────────────────────────────────

describe("drainQueue — notes and unknown modes", () => {
  it("drains a note through enrichNote + writeNote into the row's own vault", async () => {
    const { enrichNote, enrichIdea } = await import("./llmClient");
    const { writeNote, writeIdea } = await import("./writer");
    const workRoot = { uri: "file:///work", fs: {} };
    resolveContextRoot.mockReturnValue(workRoot);

    await enqueue({
      mode: "note",
      text: "- [ ] call the dentist",
      vaultContext: { profileId: "work", rootUri: "file:///work" },
    });
    // Plaintext row metadata (the Sync dialog's stamp) says note, not idea.
    expect(rows()[0].mode).toBe("note");

    await drainQueue();

    expect(vi.mocked(enrichNote)).toHaveBeenCalledWith(
      "- [ ] call the dentist",
      expect.any(Object),
      undefined,
      expect.any(Array),
    );
    expect(vi.mocked(enrichIdea)).not.toHaveBeenCalled();
    expect(vi.mocked(writeNote)).toHaveBeenCalledWith("test-note", expect.any(String), workRoot);
    expect(vi.mocked(writeIdea)).not.toHaveBeenCalled();
    expect(rows().length).toBe(0);
  });

  it("updates a save-first note in place and never writes a second file", async () => {
    const { writeNote, updateNoteIfUnchanged } = await import("./writer");
    await enqueue({
      mode: "note",
      text: "- [ ] call the dentist",
      filepath: "file:///carnet/Notes/call-the-dentist.md",
      baselineMtime: 7,
      baselineContent: "RAW",
    });

    await drainQueue();

    expect(vi.mocked(updateNoteIfUnchanged)).toHaveBeenCalledWith(
      "file:///carnet/Notes/call-the-dentist.md",
      expect.stringContaining("# Test Note"),
      7,
      "RAW",
    );
    expect(vi.mocked(writeNote)).not.toHaveBeenCalled();
    expect(rows().length).toBe(0);
  });

  it("keeps a row this build cannot route, instead of removing it as if it had drained", async () => {
    // A row written by a newer build and drained after a downgrade. Before
    // the exhaustive else, processRow returned normally and the row was
    // deleted — silent data loss.
    seed([
      {
        id: "future",
        mode: "task",
        payload_json: JSON.stringify({ mode: "task", text: "from a newer build" }),
        created_at: 1,
        attempts: 0,
        last_error: null,
      },
    ]);

    await drainQueue();

    expect(rows()).toHaveLength(1);
    expect(rows()[0].attempts).toBe(1);
    expect(rows()[0].last_error).toMatch(/Unsupported queued capture mode: task/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- queue.test`
Expected: FAIL.
- `enrichNote`, `writeNote` and `updateNoteIfUnchanged` are never called, because the note row falls through the chain and is removed.
- The unknown row is removed, so `rows()` has length 0.

`npm -w @carnet/mobile run typecheck` also fails: `mode: "note"` is not assignable to `QueuePayload`.

- [ ] **Step 3: Implement**

**Imports.**
- Add `enrichNote,` to the `./dispatcher` import.
- Add `writeNote,` to the `./writer` import.
- Change `import { resolveContextRoot } from "./vaultRoot";` to `import { resolveContextRoot, type Root } from "./vaultRoot";`.

**The queue's `CaptureMode`.** Replace `export type CaptureMode = "idea" | "journal" | "person";` with:

```ts
/** The modes a queue row can carry — derived, so it can never drift from the
 * payload union below. Row-level plaintext metadata only (the Sync dialog
 * stamps it); the drain routes on the decrypted payload's own `mode`. */
export type CaptureMode = QueuePayload["mode"];
```

**`NotePayload`.** Add after `IdeaPayload`:

```ts
/** A note captured offline — or a save-first note whose enrichment failed
 * transiently. Mirrors IdeaPayload exactly (attachments, tags, location, the
 * save-first filepath + baselines); only the prompt and the folder differ. */
export interface NotePayload extends Omit<IdeaPayload, "mode"> {
  mode: "note";
}
```

**`QueuePayload`.** Widen it inside the parentheses only:

```ts
/** Every new row records the vault root it belonged to when queued. */
export type QueuePayload = (IdeaPayload | JournalPayload | PersonPayload | NotePayload) & {
  vaultContext?: VaultContext;
};
```

**`drainSaveFirstText`.** Add it directly above `processRow`. Its body is the old idea branch, verbatim apart from the two mode picks. The order (attachments, then tags, then location) and the in-place update are load-bearing:

```ts
/** Drain an Idea or Note row. One body for both on purpose: the compose order
 * and the save-first in-place update are identical; only the prompt and the
 * folder differ by mode. */
async function drainSaveFirstText(
  payload: IdeaPayload | NotePayload,
  vaultContext: VaultContext,
  root: Root,
): Promise<void> {
  const enrich = payload.mode === "note" ? enrichNote : enrichIdea;
  const result = await enrich(payload.text, { vaultContext });
  // Binaries were already written to disk at enqueue; fold their rel-paths
  // back into the body so the drained note matches the online capture.
  // Tags are merged AFTER attachments so the frontmatter merge sees the final body.
  const md = injectLocation(
    mergeUserTags(injectAttachments(result.markdown, payload.attachments ?? []), payload.tags),
    payload.location,
  );
  if (payload.filepath) {
    // Save-first: the raw note is already on disk — update it in place,
    // guarded so a synced/user edit during the queue window is kept rather
    // than clobbered. A skipped write (conflict) still counts as processed;
    // the raw note stays and the user's edit wins.
    await updateNoteIfUnchanged(
      payload.filepath,
      md,
      payload.baselineMtime ?? null,
      payload.baselineContent ?? null,
    );
    return;
  }
  const title = deriveTitle(result.markdown);
  const slug = slugify(title) || "untitled";
  const write = payload.mode === "note" ? writeNote : writeIdea;
  await write(slug, md, root);
}
```

**`processRow`.**
- Replace the whole `if (payload.mode === "idea") { … }` branch (`:392-416`) with:

```ts
  if (payload.mode === "idea" || payload.mode === "note") {
    await drainSaveFirstText(payload, vaultContext, root);
  } else if (payload.mode === "journal") {
```

- Keep the `journal` and `person` bodies as they are.
- Close the chain after the `person` branch's `}` with:

```ts
  } else {
    // A row this build can't route (e.g. written by a newer build, then the
    // app was downgraded). Throwing keeps it in the queue — it burns attempts
    // and ends up failed, visible in the Sync dialog — instead of drainQueue
    // removing it as if it had drained.
    const unhandled: never = payload;
    throw new Error(
      `Unsupported queued capture mode: ${String((unhandled as { mode?: unknown }).mode)}`,
    );
  }
```

The `never` binding makes `tsc` fail the day someone adds a payload variant without a branch.

- [ ] **Step 4: Run the focused tests, then both gates**

Run: `npm -w @carnet/mobile test -- queue.test`
Expected: PASS. That includes the existing `"drains through the stored vault root"` test, which asserts `writeIdea("test-idea", …, workRoot)`.

Then run the **mobile gate** and the **Drive Inbox gate**.
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/queue.ts apps/mobile/src/lib/queue.test.ts
git commit -m "feat(note): queue and drain notes; keep rows the drain cannot route"
```

---

### Task 7: Re-enrich a note, never a saved answer (one atomic change)

Decision 6 requires all of this to land in **one** commit. Any subset is broken:

- Adding `note` to `RE_ENRICHABLE_MODES` alone sends a task list through the **Person** prompt. The `reEnrichNoteInPlace` `else` at `:256` handles every non-idea mode as a contact.
- Without a `mode` input, `finishPendingEnrichment` runs a pending note through the **expanding Idea** prompt.
- The folder gate would keep hiding Re-enrich on captured notes.

This task lands **before** the capture surface (Task 8), so no commit exists in which a user can create a note whose pending or re-enrich path uses the wrong prompt.

**Files:**
- Modify: `apps/mobile/src/lib/finishEnrichment.ts`:
  - header (`:5`)
  - imports (`:26`)
  - `RE_ENRICHABLE_MODES` and its doc (`:64-74`)
  - `finishPendingEnrichment` (`:96-150`)
  - `reEnrichNoteInPlace` (`:198-255`)
- Modify: `apps/mobile/src/screens/RecentDetailScreen.tsx`:
  - imports (`:80-96`)
  - `handleFinishEnrichment` (`:321-339`)
  - the gate (`:814-818`)
- Modify: `apps/mobile/src/lib/noteSubdirs.ts`: the `subdirForUri` doc (`:30-37`)
- Test: `apps/mobile/src/lib/finishEnrichment.test.ts`, `apps/mobile/src/screens/RecentDetailScreen.test.tsx`

**Interfaces:**
- Consumes: `isSynthesisNote` (Task 1), `isSaveFirstTextMode` (Task 3), and `EnrichIdeaInPlaceInput.mode` (Task 5).
- Produces:
  - `RE_ENRICHABLE_MODES = ["idea", "person", "note"]`
  - `finishPendingEnrichment({ body, filepath, mode?: CaptureMode, vaultContext? })`. A `"note"` mode gets the note prompt; anything else keeps the idea prompt, exactly as before.
  - `reEnrichNoteInPlace`:
    - routes `idea`/`note` through `enrichIdeaInPlace({ …, mode })`
    - routes `person` through `enrichPersonInPlace` as before
    - refuses a synthesis note **after its disk read**
  - RecentDetail's gate: `!missing && isReEnrichableMode(entry.mode) && !isSynthesisNote(body)`

**Why the defensive refusal in the lib too.** The screen's `body` is `""` until the note loads, so `isSynthesisNote(body)` is briefly false and the gate can pass. The lib reads the *current* file anyway (`:222-227`), so it checks there. Synthesis notes reach it with mode `note` now.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/lib/finishEnrichment.test.ts`, append:

```ts
// ── note mode (note-capture-mode Task 7) ─────────────────────────────────────

const CAPTURED_NOTE = `---
created: 2026-09-27
tags: [note, errands]
---
# Weekend errands

- [ ] call the dentist
`;

const SYNTHESIS = `---
created: 2026-09-13
tags: [synthesis]
question: "what have I been thinking about"
---
# what have I been thinking about

You wrote about kites.
`;

describe("note mode", () => {
  it("treats a captured note as re-enrichable — one note per file, like idea", () => {
    expect(isReEnrichableMode("note")).toBe(true);
  });

  it("re-enriches a captured note through the note prompt, never the Person prompt", async () => {
    mockReadNote.mockResolvedValue(CAPTURED_NOTE);
    const out = await reEnrichNoteInPlace({ body: CAPTURED_NOTE, filepath: "n.md", mode: "note" });
    expect(out.kind).toBe("updated");
    expect(mockEnrich.mock.calls[0][0].mode).toBe("note");
    expect(mockEnrich.mock.calls[0][0].tags).toEqual(["note", "errands"]);
    expect(mockPerson).not.toHaveBeenCalled();
  });

  it("threads the frozen vault context into a note re-enrich", async () => {
    mockReadNote.mockResolvedValue(CAPTURED_NOTE);
    const vaultContext = { profileId: "a", rootUri: "file:///vault-a" };
    await reEnrichNoteInPlace({ body: CAPTURED_NOTE, filepath: "n.md", mode: "note", vaultContext });
    expect(mockEnrich.mock.calls[0][0].vaultContext).toEqual(vaultContext);
  });

  it("refuses a saved Ask answer AFTER reading the disk, even if the caller's snapshot looked like a note", async () => {
    // RecentDetail gates on isSynthesisNote(body), but body is "" until the
    // note loads; this is the backstop, and it reads the CURRENT file.
    mockReadNote.mockResolvedValue(SYNTHESIS);
    const out = await reEnrichNoteInPlace({ body: CAPTURED_NOTE, filepath: "s.md", mode: "note" });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.reason).toMatch(/saved answer/i);
    expect(mockReadNote).toHaveBeenCalledWith("s.md");
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockPerson).not.toHaveBeenCalled();
  });

  it("finishes a pending Note with the note prompt", async () => {
    await finishPendingEnrichment({ body: PENDING, filepath: "f.md", mode: "note" });
    expect(mockEnrich.mock.calls[0][0].mode).toBe("note");
  });

  it("finishes a pending note with no mode as an idea, exactly as before", async () => {
    await finishPendingEnrichment({ body: PENDING, filepath: "f.md" });
    expect(mockEnrich.mock.calls[0][0].mode).toBe("idea");
  });
});
```

In `apps/mobile/src/screens/RecentDetailScreen.test.tsx`, make four changes:

1. **Test-double sync, not a changed expectation.** The file's `../lib/finishEnrichment` mock restates the predicate by hand (its comment at `:124-126` says so), so it must track the real list. Change it to:

```tsx
  isReEnrichableMode: (mode: string) => ["idea", "person", "note"].includes(mode),
```

2. Add these fixtures below `SYNTHESIS_MD` (added in Task 3):

```tsx
const CAPTURED_NOTE_MD =
  "---\ncreated: 2026-09-27\ntags: [note, errands]\n---\n# Weekend errands\n\nHello body text.\n\n- [ ] call the dentist\n";
const PENDING_NOTE_MD =
  "---\ncreated: 2026-09-27T10:00:00.000Z\nstatus: pending-enrich\nrev: abc\n---\nHello body text.\n- [ ] call the dentist\n";
```

3. **Rewrite the test at `:652-668`**, `"does not offer Re-enrich for a synthesis note in Notes/, even though its mode reports idea"`. Its premise, "hide Re-enrich for any `Notes/` note whose body is a plain enriched note", is now **wrong**: a captured note in `Notes/` must be re-enrichable. What must stay hidden is a saved answer, and that is decided by frontmatter. The test fails after the gate swap because its expectation is wrong, not because the implementation is wrong. It keeps `mode: "idea"`, which now models a recents or cached-index row written before `Notes/` mapped to `note` (risk R2), and swaps the body for a real synthesis note. Replace the whole test with:

```tsx
  it("does not offer Re-enrich for a saved answer whose entry still says idea (cached row)", async () => {
    // Rewritten for note capture mode: the old premise — hide Re-enrich for
    // ANY Notes/ note — is wrong now that Notes/ holds captured notes too (the
    // next test). A saved Ask answer is what must stay hidden, decided by its
    // frontmatter. mode "idea" here is a recents/cached-index row written
    // before Notes/ mapped to "note".
    vi.mocked(readNote).mockResolvedValue(SYNTHESIS_MD);
    const { navigation } = renderScreen({
      ...ENTRY,
      mode: "idea",
      filepath: "file:///v/Notes/synth.md",
    });
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);

    expect(await screen.findByText("File info")).toBeTruthy();
    expect(screen.queryByText("Re-enrich")).toBeNull();
  });
```

4. Append inside `describe("RecentDetailScreen — re-enrich family")`:

```tsx
  it("offers Re-enrich on a captured note in Notes/ and re-enriches it as a note", async () => {
    vi.mocked(readNote).mockResolvedValue(CAPTURED_NOTE_MD);
    const note: CaptureEntry = { ...ENTRY, mode: "note", filepath: "file:///v/Notes/weekend-errands.md" };
    const { navigation } = renderScreen(note);
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Re-enrich"));

    await waitFor(() =>
      expect(reEnrichNoteInPlace).toHaveBeenCalledWith({
        body: CAPTURED_NOTE_MD,
        filepath: note.filepath,
        mode: "note",
        vaultContext: expect.objectContaining({ profileId: "default" }),
      }),
    );
  });

  it("Finish enrichment passes the note's mode, so a pending Note never gets the idea prompt", async () => {
    vi.mocked(readNote).mockResolvedValue(PENDING_NOTE_MD);
    const { navigation } = renderScreen({
      ...ENTRY,
      mode: "note",
      filepath: "file:///v/Notes/call-the-dentist.md",
    });
    await screen.findByText(/Hello body text\./);
    openActionsSheet(navigation);
    fireEvent.click(await screen.findByText("Finish enrichment"));

    await waitFor(() =>
      expect(finishPendingEnrichment).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "note" }),
      ),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- finishEnrichment RecentDetailScreen`
Expected: FAIL.
- `isReEnrichableMode("note")` is false, and the note re-enrich returns "cannot be re-enriched".
- The synthesis refusal reason doesn't match `/saved answer/`, and `readNote` is never called for mode `note`.
- The pending-note tests see `mode` `undefined`.
- The captured-note Re-enrich row is hidden by the folder gate.
- `finishPendingEnrichment` receives no `mode`.

The rewritten `:652` test and Task 3's guard both still pass.

- [ ] **Step 3: Implement in `finishEnrichment.ts`**

**Imports.** Replace line 26 with:

```ts
import { extractFrontmatterField, getFrontmatterTags, isSynthesisNote, stripFrontmatter } from "./frontmatter";
```

and add after the `./personInPlace` import:

```ts
import { isSaveFirstTextMode } from "./saveFirstRouting";
```

Import from the leaf, not `./ideaSaveFirst`: `finishEnrichment.test.ts` mocks that module wholesale.

**Header.** Change line 5 to ` * Finish the enrichment of a save-first Idea or Note that never got enriched.`

**`RE_ENRICHABLE_MODES`.** Its doc comment ends `…it runs before anything is written.) */` on one line. Move that `*/` onto its own line, and put this paragraph between them:

```
 *
 * `note` (a captured task note in Notes/) re-enriches through the note prompt,
 * as `idea` does through its own. A saved Ask answer — also in Notes/, also
 * mode "note" — is refused by isSynthesisNote, never by mode.
```

and change the array to:

```ts
const RE_ENRICHABLE_MODES = ["idea", "person", "note"] as const;
```

**`finishPendingEnrichment`.**
- Add to its input type, after `filepath: string;`:

```ts
  /** The note's capture mode. A pending Note must get the note prompt — never
   * the expanding idea prompt; every other pending note is a raw Idea. */
  mode?: CaptureMode;
```

- In its `enrichIdeaInPlace({ … })` call, add after `expectedContent,`:

```ts
      mode: input.mode === "note" ? "note" : "idea",
```

**`reEnrichNoteInPlace`.**
- Directly after the `try { source = await readNote(…) … } catch { … }` block, insert:

```ts
    if (isSynthesisNote(source)) {
      // RecentDetail gates on isSynthesisNote(body), but body is "" until the
      // note loads. A saved Ask answer is computed from other notes; running a
      // capture prompt over it would overwrite the answer with a rewrite.
      return {
        kind: "failed",
        reason: "A saved answer can't be re-enriched — ask the question again instead.",
      };
    }
```

- Replace `if (input.mode === "idea") {` with `if (isSaveFirstTextMode(input.mode)) {`.
- In that branch's `enrichIdeaInPlace({ … })`, add after `expectedContent,`:

```ts
          mode: input.mode,
```

Leave the Person path (`:256-275`) unchanged: `person` is the only mode left that reaches it.

- [ ] **Step 4: Swap RecentDetail's gate**

In `apps/mobile/src/screens/RecentDetailScreen.tsx`:
- Remove `subdirForUri,` from the `../lib/vault` import. This was its only use, and `noUnusedLocals` enforces the removal through `tsc`.
- Add `import { isSynthesisNote } from "../lib/frontmatter";` after `import { FALLBACK_PROVIDER_FIELD } from "../lib/dispatcher";`.

In `handleFinishEnrichment`:
- Add `mode: entry.mode,` after `filepath: entry.filepath,`.
- Change the dependency array to `[body, entry.filepath, entry.mode, vaultContext]`. Otherwise `react-hooks/exhaustive-deps` warns.

Replace the gate:

```tsx
          canReEnrichGeneral={
            !missing &&
            isReEnrichableMode(entry.mode) &&
            // Was a folder test (`!== "Notes"`); Notes/ now holds captured notes too.
            !isSynthesisNote(body)
          }
```

- [ ] **Step 5: Correct the `subdirForUri` doc**

The claim that re-enrichment is a folder question is now false. In `apps/mobile/src/lib/noteSubdirs.ts`, replace:

```
 * Authoritative where `inferNoteMode` (vault.ts) is not: mode collapses every
 * unknown parent to "idea", which is right for display but wrong for any
 * decision that branches on folder identity (related-notes self-exclusion,
 * whether a note has an in-place re-enrichment path). Returns null outside
 * the known note subdirs.
```

with:

```
 * Authoritative where `inferNoteMode` (vault.ts) is not: mode collapses every
 * unknown parent to "idea" and can lag a cached row, which is fine for display
 * but wrong for any decision that branches on folder identity (related-notes
 * self-exclusion). Re-enrichability is NOT a folder question any more —
 * Notes/ holds captured notes and saved answers alike; see isSynthesisNote
 * (frontmatter.ts). Returns null outside the known note subdirs.
```

- [ ] **Step 6: Run the focused tests, then the mobile gate**

Run: `npm -w @carnet/mobile test -- finishEnrichment RecentDetailScreen`
Expected: PASS.

Then run the **mobile gate**.
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/finishEnrichment.ts apps/mobile/src/lib/finishEnrichment.test.ts \
        apps/mobile/src/lib/noteSubdirs.ts \
        apps/mobile/src/screens/RecentDetailScreen.tsx apps/mobile/src/screens/RecentDetailScreen.test.tsx
git commit -m "feat(note): re-enrich notes with the note prompt and gate saved answers by frontmatter"
```

---

### Task 8: The capture surface: sheet row, save-first submit, and the idea-only preview

**Files:**
- Modify: `apps/mobile/src/components/CaptureFab.tsx`: `CaptureTarget` (`:8-11`) and `SHEET_ROWS` (`:18-53`)
- Modify: `apps/mobile/src/lib/saveFirstRouting.ts`: add `usesSaveFirst` (moved) and `buildSaveFirstRetryPayload`
- Modify: `apps/mobile/src/lib/ideaSaveFirst.ts`: remove `usesSaveFirst` (`:93-100`) and re-export it from the leaf
- Modify: `apps/mobile/src/lib/captureDisplay.ts`: `computeCanSubmit` (`:77-83`) and a new `saveFirstTitle`
- Modify: `apps/mobile/src/screens/CaptureScreen.tsx`: the sites listed in Step 6
- Test:
  - `apps/mobile/src/lib/saveFirstRouting.test.ts`
  - `apps/mobile/src/lib/captureDisplay.test.ts`
  - `apps/mobile/src/screens/CaptureScreen.test.tsx`
  - `apps/mobile/src/screens/HomeScreen.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  - `CaptureTarget`'s `capture` variant gains `"note"`. There is a Note sheet row; the FAB's own tap stays Idea (PRD §5, AUDIT.md §3.1).
  - `usesSaveFirst(previewBeforeSave: boolean, mode: SaveFirstTextMode = "idea"): boolean`. It is `true` for a note regardless of the setting, per decision 1: the setting is labelled "Preview ideas before saving" (`SettingsScreen.tsx:687`), and PRD §6 says there is nothing to preview-gate. The existing `ideaSaveFirst.test.ts` `usesSaveFirst` tests keep passing through the re-export.
  - `buildSaveFirstRetryPayload(input, { filepath, baselineMtime, baselineContent, vaultContext? }): QueuePayload`. This is the transient-failure queue row. Its `mode` comes from the input, so a note retries as a note.
  - `saveFirstTitle(text: string, mode: SaveFirstTextMode = "idea"): string`, which is `deriveTitle(text) || formatMode(mode)`.
  - `computeCanSubmit`: a note needs non-blank `text`, like an idea. It previously fell through to the Contact rule, where OCR text counted.

**Deliberately untouched.**
- The preview path stays **idea-only**: `enrichIdea` at `:666`, the `enqueue({ mode: "idea" })` at `:683` (keep that literal, since only an idea can be in that branch), `confirmSave` at `:882` → `confirmSaveIdea` → `Ideas/` (`captureConfirmSave.ts`), `buildPreviewSubtitle`, and `showStatusRow={mode === "idea"}` at `:1080`, since maturity is an Idea concept. A note never reaches any of them.
- `notificationQuickIdea.ts` is untouched: the Drive Inbox and quick reply stay idea-only.

**CaptureScreen must not grow (1105 lines).** The net line change is about −2:
- \+1 for the `saveFirstRouting` import
- \+1 for `saveFirstTitle` in the `captureDisplay` import list
- \+2 for the two `mode: ctx.mode,` lines
- −3 for the draft object literal → typed local
- −3 for the queue payload literal → `buildSaveFirstRetryPayload`

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/lib/saveFirstRouting.test.ts`, change the import to `import { buildSaveFirstRetryPayload, isSaveFirstTextMode, saveFirstModeOf, usesSaveFirst } from "./saveFirstRouting";` and append:

```ts
describe("usesSaveFirst", () => {
  it("keeps Idea's opt-in blocking preview", () => {
    expect(usesSaveFirst(false, "idea")).toBe(true);
    expect(usesSaveFirst(true, "idea")).toBe(false);
  });

  it("always saves a Note first — 'Preview ideas before saving' gates ideas only", () => {
    expect(usesSaveFirst(false, "note")).toBe(true);
    expect(usesSaveFirst(true, "note")).toBe(true);
  });
});

describe("buildSaveFirstRetryPayload", () => {
  const retry = {
    filepath: "file:///v/Notes/errands.md",
    baselineMtime: 7,
    baselineContent: "RAW",
    vaultContext: { profileId: "work", rootUri: "file:///work" },
  };

  it("queues a note as a note row, so the drain uses the note prompt", () => {
    expect(
      buildSaveFirstRetryPayload({ mode: "note", text: "- [ ] call the dentist", tags: ["errands"] }, retry),
    ).toEqual({
      mode: "note",
      text: "- [ ] call the dentist",
      tags: ["errands"],
      filepath: "file:///v/Notes/errands.md",
      baselineMtime: 7,
      baselineContent: "RAW",
      vaultContext: { profileId: "work", rootUri: "file:///work" },
    });
  });

  it("queues an input with no mode as an idea row (pre-Note callers)", () => {
    expect(buildSaveFirstRetryPayload({ text: "kite", tags: [] }, retry).mode).toBe("idea");
  });
});
```

In `apps/mobile/src/lib/captureDisplay.test.ts`, add `saveFirstTitle,` to the `./captureDisplay` import and append:

```ts
describe("computeCanSubmit — note", () => {
  it("needs non-blank text, like idea; stray OCR text never enables it", () => {
    expect(computeCanSubmit({ phase: "input", mode: "note", text: "", transcript: "", ocrText: "" })).toBe(false);
    expect(computeCanSubmit({ phase: "input", mode: "note", text: "   ", transcript: "", ocrText: "" })).toBe(false);
    expect(computeCanSubmit({ phase: "input", mode: "note", text: "- [ ] x", transcript: "", ocrText: "" })).toBe(true);
    // Under the Contact rule this was true.
    expect(computeCanSubmit({ phase: "input", mode: "note", text: "", transcript: "", ocrText: "scanned" })).toBe(false);
  });
});

describe("saveFirstTitle", () => {
  it("uses the text's first line, else the mode's own name", () => {
    expect(saveFirstTitle("Weekend errands\n- [ ] x", "note")).toBe("Weekend errands");
    expect(saveFirstTitle("", "note")).toBe("Note");
    expect(saveFirstTitle("", "idea")).toBe("Idea");
    expect(saveFirstTitle("")).toBe("Idea");
  });
});
```

In `apps/mobile/src/screens/CaptureScreen.test.tsx`, append:

```tsx
// ── Note capture (note-capture-mode Task 8) ───────────────────────────────────

describe("CaptureScreen (note)", () => {
  // The Edit test at ~:836 installs a PERSISTENT enrichIdeaInPlace
  // implementation (mockReturnValue(deferred)), and vi.clearAllMocks keeps
  // implementations — without this reset every test appended after it
  // inherits a never-resolving enrichment. Restore the factory default.
  beforeEach(() => {
    vi.mocked(enrichIdeaInPlace).mockReset().mockResolvedValue({
      kind: "updated",
      markdown: "---\n---\n# My Idea\n\nmy idea\n",
    });
  });

  it("save-first Send writes the raw note as a note and enriches it with the note prompt", async () => {
    const { navigation } = renderScreen("note");
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "Weekend errands\n- [ ] call the dentist" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(writeRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "note", text: "Weekend errands\n- [ ] call the dentist" }),
      expect.anything(),
      expect.anything(),
    );
    expect(enrichIdeaInPlace).toHaveBeenCalledWith(expect.objectContaining({ mode: "note" }));
    expect(recordCapture).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "note", title: "Weekend errands" }),
      "default",
    );
    expect(enrichIdea).not.toHaveBeenCalled();
    expect(enrichPerson).not.toHaveBeenCalled();
    expect(clearDraft).toHaveBeenCalledWith("note", "default");
  });

  it("stays save-first with previewBeforeSave on — a Note never enters the idea preview", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      previewBeforeSave: true,
    } as Awaited<ReturnType<typeof getSettings>>);
    const { navigation } = renderScreen("note");
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "- [ ] call the dentist" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(writeRawIdea).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "note", text: "- [ ] call the dentist" }),
      expect.anything(),
      expect.anything(),
    );
    // The preview path's blocking enrichIdea (→ confirmSaveIdea → Ideas/) never runs.
    expect(enrichIdea).not.toHaveBeenCalled();
  });

  it("queues a transient enrichment failure as a note row, never an idea row", async () => {
    vi.mocked(enrichIdeaInPlace).mockResolvedValueOnce({
      kind: "failed",
      transient: true,
      reason: "network down",
    });
    renderScreen("note");
    const input = await screen.findByPlaceholderText("What's on your mind?");
    fireEvent.change(input, { target: { value: "- [ ] call the dentist" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "note", text: "- [ ] call the dentist" }),
      ),
    );
  });
});
```

In `apps/mobile/src/screens/HomeScreen.test.tsx`, append after the `"FAB tap goes straight into Idea capture…"` test:

```tsx
  it("the chevron sheet offers a Note capture", async () => {
    const { navigation } = renderScreen();
    await screen.findByText("Jack's Baseball Team");
    fireEvent.click(screen.getByLabelText("More capture modes"));
    fireEvent.click(await screen.findByText("A task list or working notes"));
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith("Capture", { mode: "note" }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- saveFirstRouting captureDisplay CaptureScreen HomeScreen`
Expected: FAIL.
- `usesSaveFirst`, `buildSaveFirstRetryPayload` and `saveFirstTitle` are not functions.
- The note OCR case returns `true`.
- The note submit is inert: Task 3's guard returns it to input, so `goBack` is never called.
- There is no "A task list or working notes" row.

- [ ] **Step 3: Move `usesSaveFirst` into the leaf, and add the retry payload**

In `apps/mobile/src/lib/saveFirstRouting.ts`, add these type-only imports below the `./storage` one. They are erased at runtime, so the leaf stays import-free:

```ts
import type { QueuePayload } from "./queue";
import type { VaultContext } from "./vaultContext";
import type { AttachmentRef } from "./writer";
```

and append:

```ts
/**
 * Whether a save-first text capture skips the blocking preview. Settings'
 * `previewBeforeSave` is labelled "Preview ideas before saving" and gates Idea
 * only. A Note is ALWAYS save-first: its prompt tidies and never expands, so
 * there is nothing to review before it lands (PRD §6), and the preview path's
 * confirmSaveIdea writes to Ideas/.
 */
export function usesSaveFirst(previewBeforeSave: boolean, mode: SaveFirstTextMode = "idea"): boolean {
  return mode === "note" || !previewBeforeSave;
}

/** What a save-first capture carries into the queue. Structural, so this leaf
 * never imports ideaSaveFirst.ts's RawCaptureInput at runtime. */
interface SaveFirstRetryInput {
  mode?: SaveFirstTextMode;
  text: string;
  tags: string[];
  location?: string;
  attachments?: AttachmentRef[];
}

/**
 * The queue row for a save-first capture whose enrichment failed transiently.
 * The raw note is already on disk at `filepath`, so the drain updates it in
 * place (guarded by the baselines) instead of writing a twin — and it drains
 * through the SAME mode's prompt: a queued Note must never be retried through
 * the expanding Idea prompt.
 */
export function buildSaveFirstRetryPayload(
  input: SaveFirstRetryInput,
  retry: {
    filepath: string;
    baselineMtime: number | null;
    baselineContent: string | null;
    vaultContext?: VaultContext;
  },
): QueuePayload {
  return {
    mode: saveFirstModeOf(input),
    text: input.text,
    attachments: input.attachments,
    tags: input.tags,
    location: input.location,
    filepath: retry.filepath,
    baselineMtime: retry.baselineMtime,
    baselineContent: retry.baselineContent,
    vaultContext: retry.vaultContext,
  };
}
```

In `apps/mobile/src/lib/ideaSaveFirst.ts`:
- Delete the `usesSaveFirst` function and its doc comment (`:93-100`).
- Add `usesSaveFirst` to the Task 5 re-export: `export { isSaveFirstTextMode, saveFirstModeOf, usesSaveFirst, type SaveFirstTextMode } from "./saveFirstRouting";`

- [ ] **Step 4: `captureDisplay.ts`**

Replace `import type { CaptureResponse } from "@carnet/shared";` with:

```ts
import { deriveTitle, type CaptureResponse } from "@carnet/shared";
import { formatMode } from "./recentDetailView";
import { isSaveFirstTextMode, type SaveFirstTextMode } from "./saveFirstRouting";
```

In `computeCanSubmit`, replace `  if (mode === "idea") return text.trim().length > 0;` with:

```ts
  // Idea and Note share one text surface (CaptureModeInput) — only `text` counts.
  if (isSaveFirstTextMode(mode)) return text.trim().length > 0;
```

and append:

```ts
/** Recents-history title for a save-first capture: the raw text's H1 or first
 * line, else the mode's own label — an emoji-only Note is "Note", not "Idea". */
export function saveFirstTitle(text: string, mode: SaveFirstTextMode = "idea"): string {
  return deriveTitle(text) || formatMode(mode);
}
```

- [ ] **Step 5: `CaptureFab.tsx`**

```ts
export type CaptureTarget =
  | { kind: "capture"; mode: "idea" | "note" | "journal" | "person" }
  | { kind: "photo" }
  | { kind: "audio" };
```

Add this as the **first** entry of `SHEET_ROWS`. It is the FAB's closest sibling: text, like the FAB's own Idea tap.

```ts
  {
    key: "note",
    title: "Note",
    description: "A task list or working notes",
    icon: "checkbox-marked-outline",
    target: { kind: "capture", mode: "note" },
  },
```

- [ ] **Step 6: Wire `CaptureScreen.tsx` without growing it**

Re-locate each site with `grep -n` before editing; the numbers are as of `12ab026`.

1. **Imports.**
   - In the `../lib/ideaSaveFirst` import, change `type RawIdeaInput,` to `type RawCaptureInput,`.
   - Below that import, add:

   ```ts
   import { buildSaveFirstRetryPayload, isSaveFirstTextMode, usesSaveFirst } from "../lib/saveFirstRouting";
   ```

   - Add `saveFirstTitle,` to the `../lib/captureDisplay` import list.
2. **`:159`, `:174`.** Change `useRef<RawIdeaInput | null>(null)` to `useRef<RawCaptureInput | null>(null)` in both refs.
3. **`:458`.** In `finishSaveFirst`'s parameters, change `ctx: RawIdeaInput,` to `ctx: RawCaptureInput,`.
4. **`:487-500`.** Replace the literal `await enqueue({ mode: "idea", text: ctx.text, … vaultContext: attemptVaultContextRef.current ?? undefined });` (13 lines, including its "Update the raw note we already wrote in place" comment) with:

   ```ts
           // In-place retry of the raw note already on disk, through ctx's own
           // mode — see buildSaveFirstRetryPayload.
           await enqueue(
             buildSaveFirstRetryPayload(ctx, {
               filepath,
               baselineMtime: mtime,
               baselineContent,
               vaultContext: attemptVaultContextRef.current ?? undefined,
             }),
           );
   ```

5. **`:540` (`reEnrichSaved`).** In its `enrichIdeaInPlace({ … })`, insert `      mode: ctx.mode,` between `expectedContent: baselineContent,` and `text: ctx.text,`.
6. **`:580` (`runEditInstead`).** Change `if (mode === "idea") {` to `if (isSaveFirstTextMode(mode)) {`, and in its comment at `:610` change `Only\n          // Idea needs it` to `Only\n          // Idea/Note need it`.
7. **`:662` (`submit`).** Change `if (mode === "idea") {` to `if (isSaveFirstTextMode(mode)) {`.
8. **`:663-664`.** Change the comment to `// Blocking-preview (opt-in, Idea only — a Note is always save-first):` and `if (previewBeforeSave) {` to `if (!usesSaveFirst(previewBeforeSave, mode)) {`. Leave `:683`'s `mode: "idea",` as it is: only an idea reaches that branch.
9. **`:699-703`.** Replace the 5-line `submittedDraftRef.current = { text: text.trim(), tags, location: location ?? undefined, };` with:

   ```ts
           const draft: RawCaptureInput = { mode, text: text.trim(), tags, location: location ?? undefined };
           submittedDraftRef.current = draft;
   ```

10. **`:724`.** Change `const ctx: RawIdeaInput = { ...submittedDraftRef.current, attachments };` to:

    ```ts
            const ctx: RawCaptureInput = { ...draft, attachments };
    ```

    This must read `draft`, not the ref. Once `mode` is a union, `tsc` loses the ref's assignment narrowing, and the spread would include the `null` branch; this was verified. `draft` is the same object. Any Edit or resubmit that could replace the ref bumps the generation first, so `superseded()` at `:711` has already returned.
11. **`:749`.** Change `const title = deriveTitle(ctx.text) || "Idea";` to:

    ```ts
            const title = saveFirstTitle(ctx.text, ctx.mode);
    ```

12. **`:790` (submit's `enrichIdeaInPlace`).** Insert `          mode: ctx.mode,` between `expectedContent: rawMarkdown,` and `text: ctx.text,`.

`deriveTitle` stays imported: `:670` and `:1001` still use it.

- [ ] **Step 7: Run the focused tests, the size check, then both gates**

Run: `npm -w @carnet/mobile test -- saveFirstRouting captureDisplay CaptureScreen HomeScreen ideaSaveFirst`
Expected: PASS. That includes Task 3's no-Contact tests and every pre-existing idea test.

Run: `wc -l apps/mobile/src/screens/CaptureScreen.tsx`
Expected: at most `1105` (about `1103`).

Then run the **mobile gate** and the **Drive Inbox gate**.
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/components/CaptureFab.tsx \
        apps/mobile/src/lib/saveFirstRouting.ts apps/mobile/src/lib/saveFirstRouting.test.ts \
        apps/mobile/src/lib/ideaSaveFirst.ts \
        apps/mobile/src/lib/captureDisplay.ts apps/mobile/src/lib/captureDisplay.test.ts \
        apps/mobile/src/screens/CaptureScreen.tsx apps/mobile/src/screens/CaptureScreen.test.tsx \
        apps/mobile/src/screens/HomeScreen.test.tsx
git commit -m "feat(note): add the Note capture row and a save-first submit that never previews"
```

---

### Task 9: Repro-harness case, `verify:capture-flow`, docs, full gate, PR, on-device

**Files:**
- Create: `apps/mobile/test/fixtures/omniroute/note-tasklist.json`
- Modify: `apps/mobile/test/fixtures/repro.test.ts`
- Modify: `apps/mobile/package.json` (the `verify:capture-flow` script)
- Modify:
  - `docs/CODEMAPS/data.md`
  - `docs/CODEMAPS/architecture.md`
  - `docs/CODEMAPS/backend.md`
  - `README.md`
  - `CLAUDE.md`
  - `TODO.md`
  - this plan

- [ ] **Step 1: Add the acceptance case unit tests can't express**

This case pins the **deterministic half** of acceptance criteria 2–4: sanitize and normalize as `note`, then `writeNote`, then the todo scan, all against a canned model reply. It does **not** prove that a real model obeys "do not expand". That half stays an on-device check (Step 7).

`apps/mobile/test/fixtures/omniroute/note-tasklist.json`. `input` is the user's raw capture. The reply keeps every line, and puts `tags` before `created` so that normalization must reorder them:

```json
{
  "input": "Weekend errands\ncall the dentist\nbuy stamps\nthe car is in the east lot\n- [ ] renew passport",
  "model": "openrouter/openai/gpt-4o-mini",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "---\ntags: [note, errands, weekend]\ncreated: 2026-09-27\n---\n# Weekend errands\n\n- [ ] call the dentist\n- [ ] buy stamps\nthe car is in the east lot\n- [ ] renew passport\n"
      }
    }
  ]
}
```

In `apps/mobile/test/fixtures/repro.test.ts`:
- Add `writeNote,` to the `../../src/lib/writer` import list, after `writeIdea,`.
- Add `import { extractChecklistLines } from "../../src/lib/checklist";` after the `enrichSanitize` import.
- Append:

```ts
// ── Note capture: a task list survives with every line intact ────────────────
// note-capture-mode PRD acceptance criteria 2-4. Pins sanitize/normalize
// (noteType "note") → writeNote → the todo scan against a canned reply. It
// does NOT prove a real model obeys "do not expand" — that half is on-device.

describe("repro: note capture keeps every line (note-tasklist.json)", () => {
  it("normalizes as a note, lands in Notes/, keeps every input line, and exposes the actions as todos", async () => {
    const fixture = readOmniRouteFixture("note-tasklist.json") as ReturnType<
      typeof readOmniRouteFixture
    > & { input: string };
    const content = fixture.choices?.[0]?.message.content ?? "";

    const normalized = sanitizeAndNormalize(content, "note");
    expect(normalized).not.toBeNull();
    expect(normalized).toMatch(/^---\ncreated: 2026-09-27\ntags: \[note, errands, weekend\]\n---\n/);

    const { filepath } = await writeNote("weekend-errands", normalized ?? "");
    expect(filepath).toBe("file:///data/carnet/Notes/weekend-errands.md");
    const written = await readNote(filepath);

    for (const line of fixture.input.split("\n").map((l) => l.trim()).filter(Boolean)) {
      expect(written).toContain(line);
    }
    // A context line is never turned into a task.
    expect(written).not.toContain("- [ ] the car is in the east lot");
    expect(extractChecklistLines(written).map((t) => t.text)).toEqual([
      "call the dentist",
      "buy stamps",
      "renew passport",
    ]);
  });
});
```

Run: `npm -w @carnet/mobile exec vitest run test/fixtures/repro.test.ts`
Expected: PASS. Everything it exercises landed in Tasks 1 and 2, so this is a regression pin, not a red phase.

- [ ] **Step 2: Extend `verify:capture-flow`**

In `apps/mobile/package.json`, append the save-first routing, save-first, finish-enrichment and capture-display suites to the script. `repro.test.ts` is already in it. The new script value is:

```
"verify:capture-flow": "vitest run src/lib/writer.test.ts src/lib/writerMarkdown.test.ts src/lib/pairedBinaries.test.ts src/lib/noteNaming.test.ts src/lib/mimeTypes.test.ts src/lib/frontmatter.test.ts src/lib/queue.test.ts src/lib/vault.test.ts src/lib/vaultSearch.test.ts src/lib/journalTagIndex.test.ts src/lib/markdownRoundTrip.test.ts test/fixtures/repro.test.ts src/lib/retrospective.test.ts src/lib/saveFirstRouting.test.ts src/lib/ideaSaveFirst.test.ts src/lib/finishEnrichment.test.ts src/lib/captureDisplay.test.ts",
```

In `CLAUDE.md`'s "Reproducing bug reports" paragraph, change `runs the capture-flow test subset\n(writer/frontmatter/queue/vault/search/journal-tag-index/WYSIWYG round-trip) plus` to `runs the capture-flow test subset\n(writer/frontmatter/queue/vault/search/journal-tag-index/WYSIWYG round-trip, plus the\nsave-first routing/save-first/finish-enrichment/capture-display suites) plus`.

- [ ] **Step 3: Fix the stale docs**

`docs/CODEMAPS/data.md:14`: replace the `Notes/{slug}.md           synthesis note  (…)` line with:

```
Notes/{slug}.md           captured note   (Note mode — task list / working notes, tags: [note, …])
                          synthesis note  (saved Ask answer — tags: [synthesis] + question:;
                                           isSynthesisNote tells the two apart, not the folder)
```

`docs/CODEMAPS/architecture.md`:
- `:18`: `Capture (Idea / Journal / Contact / …` becomes `Capture (Idea / Note / Journal / Contact / …`.
- `:29`: `(Idea/Journal default SAVE-FIRST: file lands instantly, enrichment patches after — B4)` becomes `(Idea/Note SAVE-FIRST: file lands instantly, enrichment patches after — B4; Note always, Idea unless previewBeforeSave)`. Journal was never save-first.

`docs/CODEMAPS/backend.md`:
- **The capture table (`:18`).** Add after the Idea row:

```
Note     CaptureScreen   → dispatcher.enrichNote    → writer.writeNote      → Notes/{slug}.md
```

- **`:33`.** Change `` `enrichIdea` `enrichJournal` `` to `` `enrichIdea` `enrichNote` `enrichJournal` ``.
- **`:57`.** Change `` `writeIdea` `writeSynthesis` (Notes/{slug}.md — saved retrospective-query answers) `` to `` `writeIdea` `writeNote` (Notes/{slug}.md — captured notes) `writeSynthesis` (Notes/{slug}.md — saved retrospective-query answers) ``.
- **`:132-139`.** Replace the paragraph from `**The uri is authoritative…**` through `…(storage.ts vs queue.ts).` with:

```
**The uri is authoritative wherever a decision turns on folder identity.**
`inferNoteMode` maps Ideas/→idea, Journal/→journal, People/→person, Notes/→note
and collapses anything else to `"idea"`; a cached row's mode can also lag its
folder until the next refresh. That is fine for display but wrong for the
related-notes self-exclusion, which reads `subdirForUri`. Re-enrich is not a
folder question: `Notes/` holds captured notes (re-enrichable) and saved Ask
answers (never) alike, so `RecentDetailScreen` and `reEnrichNoteInPlace` gate on
`isSynthesisNote` (frontmatter `tags: [synthesis]` or `question:`). `queue.ts`'s
`CaptureMode` is derived from `QueuePayload["mode"]`, so it can't drift from
`storage.ts`'s.
```

`README.md`: change `Five capture modes:` to `Six capture modes:`, and add after the `idea` table row:

```
| `note`    | text / dictation            | `Notes/{slug}.md` (save-first; titled and tagged, never expanded — action lines become `- [ ]` todos) |
```

Then confirm that no stale claims remain:

```bash
grep -rn "no mode of its own\|mode reports idea\|Idea\" for a \`Notes/\`\|Five capture modes" \
  apps/mobile/src docs/CODEMAPS README.md
# AC7: the writeSynthesis docstring no longer calls Notes/ "computed artifacts" (Task 2).
grep -n "computed artifacts" apps/mobile/src/lib/writer.ts
```

Expected: no output from either.

- [ ] **Step 4: Record it in `TODO.md`**

Directly above `## Landed, device verification complete (benefit not yet measured)` (`TODO.md:84`), add:

```markdown
## Landed, pending on-device verification

- [ ] **Note capture mode** (PR #<n>) — a sixth mode, Note, writes create-only into
  `Notes/` through a prompt that titles and tags a task list and NEVER expands it; action
  lines become `- [ ]` and reach TodosScreen with no todo code changed. Always save-first
  ("Preview ideas before saving" gates ideas only); queues offline; re-enrichable. Two
  things not to re-litigate: (1) it deliberately and narrowly reverses the "no new capture
  surface" non-goal of `notes-todo-capture.prd.md` — see the table in
  `.claude/PRPs/prds/note-capture-mode.prd.md`; (2) `Notes/` intentionally holds two kinds
  of file, told apart by frontmatter (`isSynthesisNote`), not folder. Drive Inbox (Android
  Auto) stays idea-only. Plan: `.claude/PRPs/plans/note-capture-mode.plan.md`.
```

- [ ] **Step 5: Run the full gate**

```bash
npm run build:shared
npm -w @carnet/shared test && npm -w @carnet/shared run typecheck
npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test
npm -w @carnet/mobile run verify:capture-flow
bash scripts/check-stale-plans.sh && bash scripts/check-stale-plans.sh --self-test
wc -l apps/mobile/src/screens/CaptureScreen.tsx
```

Then run the **Drive Inbox gate**.

Expected: everything passes, and CaptureScreen is at most `1105` lines.

- [ ] **Step 6: Mark this plan in progress and commit**

Change `Status: draft` to `Status: in-progress` in this file. **Do not** set `shipped` or move the plan to `plans/completed/` before Step 7 has actually happened. `scripts/check-stale-plans.sh` enforces the header, and this repo's most-repeated documentation defect is paperwork that claims shipped ahead of the evidence.

```bash
git status --short   # expect only the paths below, plus the pre-existing "?? AGENTS.md"
git add apps/mobile/test/fixtures/omniroute/note-tasklist.json apps/mobile/test/fixtures/repro.test.ts \
        apps/mobile/package.json CLAUDE.md README.md TODO.md \
        docs/CODEMAPS/data.md docs/CODEMAPS/architecture.md docs/CODEMAPS/backend.md \
        .claude/PRPs/plans/note-capture-mode.plan.md
git commit -m "test(note): repro case for a task list; extend verify:capture-flow; docs"
```

**Task 10 (review follow-ups) lands before this push.** Push and open the PR **only when the human says to**. It is squash-merged into `main`:

```bash
git push -u origin feat/note-capture-mode
gh pr create --base main --title "feat(note): Note capture mode writing into Notes/" \
  --body-file <(printf '%s\n' "Implements .claude/PRPs/prds/note-capture-mode.prd.md per .claude/PRPs/plans/note-capture-mode.plan.md." "" "On-device verification: pending (plan Task 9, Step 7).")
```

- [ ] **Step 7: On-device verification (cannot be done in tests)**

`docs/smoke-test.md` is the manual checklist. Specifically:

1. Capture a Note mixing task lines and context lines. Confirm that:
   - the file is in `Notes/`
   - **every line you typed is still there**
   - task lines became `- [ ]` and context lines did not
2. Open Todos. The checkboxes appear and can be ticked.
3. Turn **Preview ideas before saving** on. Capture a Note: it still saves instantly into `Notes/`, with no preview card. Capture an Idea: it still previews.
4. Re-enrich is offered on that Note and **not** on a saved Ask answer. That includes an answer opened from Search's new Note chip.
5. Capture a Note in airplane mode, then reconnect. It drains, enriches in place, and there is no `-2` twin. Separately, force a note to stay `pending-enrich`, then use "Finish enrichment": the lines are not expanded.
6. Reply to the Android Auto Drive Inbox. It still lands in `Ideas/`, exactly once.
7. Repeat (1) against a local Relais model. A small model is the most likely to ignore "do not expand", which is the prompt's single hard constraint.

Record the results in a `docs/session-handoffs/` entry, then flip this plan to `Status: shipped` and `git mv` it to `.claude/PRPs/plans/completed/`.

### Task 10: Review follow-ups — enforce "never expand" in code (lands before Task 9's push)

An independent critic pass (2026-09-29) approved this plan with fixes. The human chose
**guard + keep raw lines** for finding 1. Tasks 1–9 landed exactly as dry-run; this task
adds the follow-ups as separate test-first commits on the same branch, **before** Task 9
Step 6's push/PR. Every commit ends with the mobile gate and the Drive Inbox gate green.

**Files:**
- Create: `apps/mobile/src/lib/noteLineGuard.ts`, `apps/mobile/src/lib/noteLineGuard.test.ts`
- Modify: `apps/mobile/src/lib/dispatcher.ts` (`enrichNote`), `dispatcher.test.ts`
- Modify: `apps/mobile/src/lib/prompts.ts` (`buildNotePrompt`), `prompts.test.ts`
- Modify: `apps/mobile/src/lib/ideaSaveFirst.ts` (raw write for `note`), its test; `queue.test.ts`
- Modify: `apps/mobile/src/components/NoteCard.tsx` (`modeStamp`), `apps/mobile/src/components/NoteMetaRow.tsx` (or wherever `formatMode`/`modeStamp` is consumed without a default), their tests
- Modify: `apps/mobile/test/fixtures/repro.test.ts`, `apps/mobile/src/screens/CaptureScreen.test.tsx`
- Modify: this plan (R3, Task 9 Step 3 grep)

**1. The line guard (critic HIGH-1; the human's decision).**
- `noteLineGuard.ts` is a pure, dependency-free leaf. `keepsUserLines(input: string, enrichedMarkdown: string): boolean`:
  - Compare *body lines*: split on `\n`, drop frontmatter from the enriched side, trim trailing whitespace, drop blank lines.
  - Normalise a line by stripping one leading list/checkbox marker (`- [ ] `, `- [x] `, `- [X] `, `- `, `* `, `+ `) or ATX heading marker (`#{1,6} `).
  - Every normalised input line must appear in the output, **in order** (a subsequence).
  - Every output body line must match an input line, except the output's first ATX heading, which may be a new title. It also counts as a match for an input line with the same text, so re-enrich of a note that already has `# Title` passes.
  - A line that is `- [x]`/`- [X]` in the input must still be checked in the output. Un-ticking a done todo is a failure.
- `withUserLines(input, enrichedMarkdown): string` builds the fallback: the enriched frontmatter block + the enriched first ATX heading (if any, and if it doesn't already equal the input's first line) + the **input lines verbatim**. It must pass `keepsUserLines` itself (property test over the fixtures).
- Apply at the single chokepoint all note enrichment passes through: `dispatcher.enrichNote`, on a successful result. Submit (`ideaSaveFirst.enrichIdeaInPlace`), the queue drain (`queue.ts` note branch), Finish enrichment and Re-enrich all call it. If `keepsUserLines` fails, replace the markdown with `withUserLines(...)`. No new status, no retry: the capture keeps the model's title and tags, and the user's lines verbatim.
- Tests:
  - guard unit tests in both directions: dropped line, reworded line, added prose line, reordered lines, un-ticked `- [x]`, and bullet→checkbox conversion allowed
  - a dispatcher test where the mocked `llmClient.enrichNote` returns an expanded body and the result carries the user's lines verbatim
  - a dispatcher test where a compliant reply passes through byte-for-byte

**2. Re-enrich prompt rules (critic MEDIUM-2).** Add two rules to `buildNotePrompt`: "If the text already starts with a `# ` heading, reuse it as the title", and "Keep existing `- [ ]` and `- [x]` lines exactly as written". Add prompt tests for both phrases. The guard above is the enforcement; these rules make a compliant reply likely.

**3. `#note` does not depend on the model (critic MEDIUM-3).**
- For `mode: "note"`, the raw save-first write already carries `note` in `tags`. Merge it through the existing tag-merge path (`setFrontmatterTags`/`normalizeTag`); don't hand-build YAML.
- `dispatcher.enrichNote`'s result is also guaranteed to carry `note` (merge, never duplicate), covering submit, drain and re-enrich from one place.
- Tests: `ideaSaveFirst.test` (raw note stub has `note`; raw idea stub unchanged byte-for-byte), and `dispatcher.test` (a model reply without `note` gains it; one with it is unchanged). Idea/Journal/Person serialization must stay byte-identical.

**4. Mode-stamp fallback (critic MEDIUM-4; corrects R3).**
- `modeStamp` (and any `formatMode`-style consumer that a dry-run crash showed has no default, e.g. `NoteMetaRow`) gets a `default:` that binds `const _exhaustive: never = mode` and returns a generic stamp/label. `tsc` keeps catching new modes, but an unknown persisted mode at runtime no longer throws into `CrashBoundary` or the Sync dialog (`HomeScreen.tsx:532`).
- Add a test that casts an unknown mode through.
- Rewrite R3 below: older builds still crash on a `note` entry. That can't be fixed retroactively, and it is the accepted cost. This build and later ones degrade to a generic stamp.

**5. A missing `mode` must not silently expand a note (critic LOW-5).**
- In `enrichIdeaInPlace`, when the target `filepath` is under `Notes/` (`subdirForUri(filepath) === "Notes"`), use the note path even if `mode` was omitted. Test it.
- Synthesis answers never reach here: the Task 7 gates stand.

**6. Guards for the remaining acceptance criteria (critic LOW-6/7/8).**
- Task 9 Step 3's stale-claims grep also checks that `computed artifacts` no longer appears in `writer.ts` (AC7).
- The repro case (`repro.test.ts`) asserts with `keepsUserLines(input, written)` line-by-line, not a whole-document `toContain`.
- The note tests in `CaptureScreen.test.tsx` assert the pinned root and the queued row's `vaultContext`/`filepath`, not `expect.anything()`.

**Commit shape:** one commit per numbered item (1 and 2 may share one), conventional `feat(note)`/`fix(note)`/`test(note)`, staging explicit paths only.

**Deviations, as implemented (one line each):**
- Item 1: `dispatcher.test.ts` runs the real `llmClient` against `fetchMock`, so the expanded/compliant replies go through `makeOkResponse` (and the real sanitizer), not a mocked `llmClient.enrichNote`.
- Item 1: the two matching rules are one check: the body must equal the input lines one-for-one, in order (so a duplicated line fails), trying the first ATX heading both as a match and as a new title.
- Item 1: ~~the guard compares against the user's raw text~~ (superseded by review fix A below).
- Item 1: checked state must match both ways, since a model that ticks a todo fails just as one that un-ticks it does. A todo must also stay a todo: `- [ ] x` turning into `x`, `- x` or `# x` fails, because that would drop it from Todos.
- Item 1: indentation is ignored along with trailing whitespace (the line is trimmed before its marker is stripped).
- Item 1: `withUserLines` puts the model's title *in place of* an identical first input line only when that line is plain text; a first-line todo or bullet is kept under the title. It does this rather than dropping the title so the note keeps an H1 (`injectImageEmbed` puts attachments above the frontmatter when there is none). It does not stack the model's title on an input that already starts with its own `# ` H1 (re-enrich).
- Item 3: the raw note stub did **not** already carry `note` (no `mode` branch in `buildRawIdeaMarkdown`); it now does, merged through `mergeUserTags` → `setFrontmatterTags`. In both places `note` goes first, matching the prompt's `tags: [note, …]`, and a reply that already has it (any spelling) is left byte-for-byte.
- Item 4: `const _exhaustive: never = mode` alone fails `tsc` under `noUnusedLocals` (TS6133), so each `default` binds `unknownMode: never` and reads it with `void`. The throw came from `modeStamp` returning `undefined`, so one `default` there fixes `NoteCard`, `NoteMetaRow`, `RelatedNotesCard`, `SearchScreen` and `HomeScreen:532`; `formatMode` gets the same `default` ("undefined · captured …" in File info). Neither `NoteMetaRow.tsx` nor `HomeScreen.tsx` needed editing. The test is a new `components/NoteCard.test.tsx` plus a `recentDetailView.test.ts` case.
- Item 5: "mode omitted" is almost unreachable, because `finishPendingEnrichment` turns a missing mode into an explicit `"idea"`, and Re-enrich passes the entry's mode, which can be a stale cached `"idea"` (R2). So in `enrichIdeaInPlace` a `Notes/` file gets the note prompt **whatever** mode the caller passed. `Notes/` never holds an idea, because `writeIdea` writes to `Ideas/`.
- Item 6: the CaptureScreen note tests now run with Work as the active profile, because the default mock pins nothing, so a dropped root would go unnoticed. They assert the pinned root by its `uri` (`Root.fs` is a backend object), `vaultContext` equal to Work's, and the queued row's `filepath` and baselines. A mutation that drops the root or the `vaultContext` fails all three tests.
- Review fix A (security HIGH): the fallback's title is the reply's first `# ` H1 **outside any code fence**, following B3's own fence rules, including unclosed fences and `~~~`. It is never taken from inside a fence, and `##` headings don't count.
- Review fix A: the fallback is re-sanitized through `sanitizeMarkdown`, with frontmatter and body done **separately**. A bare fence line in a reply's frontmatter makes B3 treat the whole body as a fence (pre-existing in all modes; see `TODO.md`), and a single pass would inherit that.
- Review fix A: the user's lines in the fallback now go through B3 as well (Templater `<%…%>` is neutralized, and R6 `once = daily` loses its tail). So every enriched note has passed B3 whichever path built it, matching the compliant path, where the model echoes the same lines. The raw save-first stub stays unsanitized, as on `main`.
- Review fix A: to match, the guard judges the reply against `sanitizeMarkdown(text)`, not the raw text. A sanitizer-altered line no longer forces a fallback that throws away every checkbox in the note.

---

## Risks and accepted trade-offs

These are documented, not new work.

- **R1. Settings export compatibility (decision 2).**
  - `isPromptOverrides` (`settingsTransfer.ts:185-191`) is an allowlist used as a *validator*, and the export version stays `1`. So an **older build refuses a newer export that contains a `note` prompt override**, with "incomplete or malformed".
  - Exports without a `note` override still import on old builds, and old exports import on this one.
  - The version is not bumped, because that would make *every* new export unimportable on old builds, not just ones that customise Note.
- **R2. Cached index rows keep the old mode.**
  - The note index caches each row's `mode` (`vault.ts:227`), and the cache has no version check (`vault.ts:334-354`).
  - As a result, existing `Notes/` files keep showing "Idea" on Home cards, and stay under Search's Idea chip rather than the Note chip, until a pull-to-refresh or the next full scan. Recents entries recorded before this change also keep their stored mode.
  - This is safe for Re-enrich: the gate is the note's frontmatter (Task 7 pins a stale `"idea"` synthesis row).
- **R3. App downgrade after capturing notes.** Older builds still crash on a `note` entry. That can't be fixed retroactively, and it is the accepted cost:
  - An older build's `modeStamp` and `formatMode` have no default. Opening a `note` entry in RecentDetail throws in `NoteMetaRow` (`modeStamp(mode).label`, reproduced in the dry run), and destructuring it in a Home/Search `NoteCard` throws too.
  - Its Sync dialog calls `modeStamp(row.mode).label` (`HomeScreen.tsx:532`), which throws on a queued `note` row.
  - Its drain has no `else`, so it silently removes a queued note row.

  This build and later ones degrade instead (Task 10 item 4): `modeStamp` and `formatMode` have a `never`-bound `default` that returns a generic "Capture" stamp/label, so a mode persisted by an even newer build no longer throws into `CrashBoundary` or the Sync dialog, and the drain keeps the row it can't route (decision 10).
- **R4. `Notes/` mixes captured notes and saved Ask answers.**
  - This is deliberate (PRD §3 and its risk table).
  - They are distinguished by `#note` vs `#synthesis` and `question:`, and by `isSynthesisNote` in code.
  - Search's Note chip returns both.
- **R5. The model expands or rewords despite the prompt.**
  - The repro case pins sanitize, write and todo scan against a canned reply only.
  - Model fidelity is verified on device, including a small local model (Task 9, Step 7).
- **R6. A pre-existing sanitizer false positive can delete text from a note.**
  - `neutralizeText`'s `on*=` stripper (`enrichSanitize.ts`, the `[\s/]on[a-z]+\s*=` rule) also fires on plain text such as `once = daily`, which violates "every line survives" for that line.
  - This is not fixed here. The fixture avoids the shape.
- **R7. `isSynthesisNote` heuristics.**
  - A captured note whose frontmatter gains `question:`, or whose tags include `synthesis` (hand-added, or suggested by the model), is treated as a saved answer and loses Re-enrich.
  - This is low-probability and non-destructive, because the note itself is untouched.
- **R8. A stray checkbox on a non-action line** (PRD risk).
  - Mitigated by reusing the "NEVER invent tasks" phrasing.
  - The worst case is a checkbox the user deletes, not data loss.

## Self-Review

**Spec coverage:**

| PRD section | Task(s) |
|---|---|
| §1 `note` CaptureMode | Task 3 |
| §2 the prompt | Task 1 |
| §3 `Notes/` + docstring | Task 2 (docs in Task 9) |
| §4 synthesis by frontmatter | Tasks 1 and 7 |
| §5 sheet row | Task 8 |
| §6 save-first + `RE_ENRICHABLE_MODES` | Tasks 5, 7 and 8 (always save-first) |
| §7 queue | Task 6 |
| §8 enrichment plumbing + `promptOverrides.note` | Task 4 |

| Acceptance criterion | Task(s) |
|---|---|
| 1 | Task 8 |
| 2 | Tasks 2, 3 and 8 (index/Search) |
| 3 | Tasks 1 and 9, plus on-device |
| 4 | Tasks 1 and 9, plus on-device |
| 5 | Tasks 6 and 8 |
| 6 | Task 7 |
| 7 | Task 2 |
| 8 | Task 9 |

**Decision coverage:**

| Decision | Where |
|---|---|
| 1 | Task 8's `usesSaveFirst` and the screen test with `previewBeforeSave: true` |
| 2 | R1 |
| 3 | Task 5: the characterization commit first, `RawNoteInput` plus the runtime throw, and the Drive Inbox gate in Tasks 5, 6, 8 and 9 |
| 4 | Tasks 2, 4, 5, 6 and 7 |
| 5 | Tasks 1 and 4 |
| 6 | Task 7, with Task 3's guard |
| 7 | Task 3 |
| 8 | Task 3, with the deep-link rationale |
| 9 | the `saveFirstRouting.ts` leaf, `ctx.mode`, `saveFirstTitle`, and Task 8's line budget |
| 10 | Task 6 |
| 11 | Task 9 |
| 12 | R2 to R4 |

**Type consistency.** These are used identically across Tasks 1–8:

- `buildNotePrompt(input)`
- `NoteType "note"` = created, tags
- `isSynthesisNote(markdown)`
- `writeNote(slug, markdown, rootOverride?)`
- `llmClient.enrichNote(text, config, override?, availableTags = [])`
- `dispatcher.enrichNote(text, options?: EnrichmentOptions)`
- `SaveFirstTextMode`, `isSaveFirstTextMode`, `saveFirstModeOf`, `usesSaveFirst(previewBeforeSave, mode = "idea")`, `buildSaveFirstRetryPayload`
- `RawIdeaInput | RawNoteInput = RawCaptureInput`
- `RewriteRawIdeaInput = RawCaptureInput & { filepath }`
- `EnrichIdeaInPlaceInput.mode?`
- `NotePayload`
- the queue's `CaptureMode = QueuePayload["mode"]`
- `finishPendingEnrichment({ …, mode?: CaptureMode })`

`CaptureMode` gains exactly one variant, `"note"`. The load-bearing shapes were compiled in isolation against the repo's TypeScript 5.9 with `--strict --noUnusedLocals --noUnusedParameters --noImplicitReturns`:

- the idea/note input split with `notificationQuickIdea.ts:160/:213` unchanged
- both `@ts-expect-error` guards
- the draft-local narrowing
- `enqueue(buildSaveFirstRetryPayload(ctx, …))` against the intersected union
- `QueuePayload["mode"]`
- the `never` else
- `relatedSubdirForMode(): NoteSubdir`

**Placeholder scan.**
- No step says "mirror the existing pattern" without the code.
- Every test uses the file's real helpers and mocks: `renderScreen(entry)`, `openActionsSheet`, the `./llmClient` mocks, `resolveContextRoot`, `seed`/`rows`, `listNoteFilesInRootMock` and so on.
- Line numbers are as of `12ab026`. Re-grep before each edit, because they drift within a task.
- The one deliberate placeholder is the PR number in `TODO.md`, which is unknown until the PR exists.

**Known soft spots the implementer should expect:**
- Test code was dry-run end to end against `12ab026` (see the Revision section). If the tree has moved since then and a harness detail differs, fix the harness line, not the assertion, and note it in the task's commit.
- **The dry run measured CaptureScreen at 1105 after Task 3 and 1103 after Task 8.** If a formatter or lint fix pushes it over 1105, move another literal into `lib/` rather than accepting growth.
- `resolveProfileRoot({ rootUri })` is used to build pinned roots in `writer.test.ts`/`ideaSaveFirst.test.ts`. It only reads the `rootUri` field of its `Pick<VaultProfile, "rootUri">` argument.
