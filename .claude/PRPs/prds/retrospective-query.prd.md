# PRD: retrospective query — "what have I been thinking about regarding X?"

**Status:** approved design, plan pending · **Date:** 2026-09-07 · **Axis:** closes
`v0.5-browse-search.prd.md` Phase 3, the last unbuilt piece of the retrieval axis ·
**Source:** design session 2026-09-07, decisions taken with the user inline (see
"Decisions taken").

## Theme

Capture is solved. Retrieval is solved *mechanically* — Phase 1 (note index + Search
screen) and Phase 2 (on-demand full-text body scan) both shipped. What is still missing
is the question `TODO.md` has carried since v0.1: **"what have I been thinking about
regarding X?"** — a synthesized answer across many notes, rather than a list of files
you then read yourself.

## Why this is unblocked now (it wasn't when the v0.5 PRD was written)

`v0.5-browse-search.prd.md` §Phase 3 gated itself explicitly:

> "If v0.4 S4 (embeddings) ships, its vectors upgrade retrieval from substring to
> semantic; Phase 3 is designed against the *retrieval interface* (query → ranked note
> URIs), not against either implementation. **Ship Phase 3 after S4's fate is known;
> do not build embeddings inside this axis.**"

**S4's fate is now known.** It shipped in *lexical* form — `lib/relatedNotes.ts`
(shared tags + term overlap over the cached note index; no embeddings, no vectors, no
network), surfaced in `RecentDetailScreen` with wikilink insertion. `TODO.md` records
it as having superseded most of the original "cross-capture linking" item. So retrieval
stays lexical, the gate is satisfied, and Phase 3 designs against the retrieval
interface exactly as the PRD required.

### Not to be confused with `enhance-source-citations.plan.md`

That plan is **blocked** on an OmniRoute gateway change and concerns *external URL*
annotations from `sonar-reasoning-pro`. This feature's citations are **internal
`[[wikilinks]]` into the user's own vault**. Different provenance, different
mechanism, not blocked. Do not let "citations" conflate the two.

## Current state (verified against the tree at `4fd9119`, 2026-09-07)

| Seam | Where | Note |
|---|---|---|
| Indexed search | `vault.ts:488` `searchNotes()` | title/tags/excerpt, ranked, filterable |
| Full-text search | `vault.ts:588` `searchNoteBodies()` | streaming, `SCAN_CONCURRENCY` 8, `AbortSignal`, per-note snippet |
| Search UI | `screens/SearchScreen.tsx` (474 lines) | holds `results` (`NoteIndexEntry[]`) and `bodyMatches` (`BodyMatch[]`), filters, cancellable deep scan |
| Backend seam | `lib/dispatcher.ts` | uniform over OmniRoute *and* local (Relais); `enhanceProse` (`:430`) is the closest precedent |
| Fallback chain | `dispatcher.ts:223` `withFallbackChain` | primary → fallback provider, `shouldRetryWithFallback` gated |
| Prompt overrides | `settings.ts:62` `PromptOverrides` | already carries a non-capture-mode key (`enhanceProse`) — precedent for a seventh |
| LLM output safety | `enrichSanitize.ts:76` `sanitizeMarkdown` | neutralizes Dataview/Templater/script/`javascript:` |
| Prompt injection guard | `prompts.ts:29` `INJECTION_GUARD` | wraps user content in `<USER_INPUT>` tags, data-only |
| Note subdirs | `writer.ts:454` `NOTE_SUBDIRS` | `["Ideas","Journal","People"]`; `listNoteFiles`/`buildNoteIndex`/`buildTagIndex` all **iterate the array** — they hardcode no count |
| Note writer | `writer.ts:164` `writeIdea` | 7-line wrapper over `findOrCreateSubdir` + `findCollisionFreeName` + `writeNewFile` |
| Navigation | `vault.ts:518` `resolveNoteEntry` | uri → `CaptureEntry`; the path TagBrowser and Search already use into `RecentDetail` |

## Decisions taken

Four forks were put to the user and settled before this document was written. They are
recorded here with rationale so the plan does not relitigate them.

1. **The answer is ephemeral, with an explicit Save.** It renders in-app; a Save button
   writes it to the vault only on request. Rejected: always-write (litters the vault
   with exploratory questions) and never-write (an answer you liked is unrecoverable,
   and a RAM-only artifact is the one thing in Carnet that isn't a file).
2. **Retrieval is what is on screen in Search.** The entry point is a button on
   `SearchScreen`; the candidate set is its current `results` ∪ `bodyMatches`. Rejected:
   a dedicated Ask screen with its own ranking — it would re-invent ranking Search
   already has and make retrieval invisible, so a thin answer could not be diagnosed as
   a retrieval failure vs. a synthesis failure. **This choice is load-bearing: it is why
   this feature invents no new ranking.**
3. **Exposure is shown, not blocked.** The button names the cost — "Ask about these 12
   notes" — and a one-time explainer appears the first time the feature is used against
   a *remote* backend. **The number in the button is what will actually be sent, not
   what is on screen.** With 50 results showing and `MAX_NOTES` 12, the button reads
   "Ask about these 12 notes" and `AskScreen` states "synthesized from the top 12 of 50
   matches". Naming the on-screen count would overstate the exposure; naming the sent
   count without disclosing the shortfall would hide that the answer is partial. Rejected: a per-question modal (gets click-throughed) and no
   disclosure at all. Rationale: every existing enrich call sends *one note the user
   chose to send*; this sends **a bundle of past notes, including ones never chosen for
   enrichment**. That is a real escalation in exposure and it should be legible at the
   decision point.
4. **Saved answers land in a new `Notes/` subdir.** Rejected: folding them into
   `Ideas/`. `Ideas/` is a capture-mode folder for things the user jotted; a synthesis
   is a computed artifact citing sources. Cost of the fourth subdir was measured, not
   assumed — see below.

### Cost of the `Notes/` subdir (measured, 2026-09-07)

An earlier draft of this design claimed a fourth subdir would touch "indexing,
scanning, and every prebuild assumption." **That was wrong and is corrected here.**
`listNoteFiles`, `buildNoteIndex`, and `buildTagIndex` all iterate `NOTE_SUBDIRS`; none
encodes the number three. Nothing in `apps/mobile/plugins/` or `apps/mobile/scripts/`
references note-folder names at all. The actual change set:

- `writer.ts` — add `"Notes"` to `NOTE_SUBDIRS` (one array entry). Indexing, tag
  indexing, note indexing, and full-text scan pick it up with no further change.
- `writer.ts` — a `writeSynthesis` wrapper, same seven-line shape as `writeIdea`.
- `vault.ts` `inferNoteMode` — one branch. Returns `"idea"`; see below.
- `screens/SettingsScreen.tsx:320` — one line of user-facing copy listing the folders.
- `docs/CODEMAPS/{architecture,data,backend}.md`, `docs/sync-setup.md` — folder-list
  prose.

**`inferNoteMode` returns `"idea"` for `Notes/` deliberately.** A distinct `CaptureMode`
variant is *not* introduced in this feature. `CaptureMode` is declared twice with
different members (`storage.ts:6` includes `photo`/`audio`; `queue.ts:63` does not), so
adding a variant means reconciling two type declarations and every exhaustive consumer
— real work, unrelated to this feature. Deferred as an explicit non-goal.

**But that shortcut has three traced consequences, and two are functional.** They are
listed here because an implementer who takes the one-line `inferNoteMode` branch and
stops will ship all three:

1. **Related-notes self-exclusion breaks (functional).** `noteRelated.ts:34` builds its
   query with `subdir: relatedSubdirForMode(entry.mode)`, whose own doc comment says
   "the mode maps 1:1 onto the subdir" — an invariant `Notes/` violates. A synthesis
   note would report `subdir: "Ideas"` while living in `Notes/`. **Fix: derive the
   subdir from the uri.** `computeRelatedNotes` already receives `entry.filepath`, so
   this is a small change at one call site, and it removes a latent assumption rather
   than adding a special case.
2. **"Re-enrich" is offered on a synthesis note (functional).**
   `RecentDetailScreen.tsx:741` gates it on `isReEnrichableMode(entry.mode)`, and
   `"idea"` is re-enrichable — so the idea prompt would run over a computed answer and
   overwrite it. **Fix: gate on the uri-derived subdir, excluding `Notes/`.**
3. **`RecentDetail` labels it "Idea" (cosmetic).** Via `formatMode(entry.mode)` at
   `:770`. Accepted as-is; it is the only one of the three that is purely display, and
   fixing it properly is the deferred `CaptureMode` variant.

The pattern: `mode` stays the storage/display default, and the two behaviors that
actually branch on folder identity read the **uri**, which is authoritative.

## Design

### Modules

| Module | Status | Role |
|---|---|---|
| `lib/retrospective.ts` | **new, pure** | Candidate selection, budget enforcement, payload assembly, answer validation, wikilink resolution. Zero network, zero RN — fully fixture-testable. |
| `lib/llmClient.ts` | edit | `askRetrospective(payload, config, override)` mirroring `enhanceProse` (`:629`): `assertModelConfigured` + `assertUrlConfigured`, `withSystemOverride`, `chatCompletion`. |
| `lib/dispatcher.ts` | edit | `askVault()` mirroring `enhanceProse` (`:430`): provider resolution, `withFallbackChain`, provider label returned for the snackbar. |
| `lib/prompts.ts` | edit | `buildRetrospectivePrompt` + `INJECTION_GUARD` over the whole bundle. |
| `lib/settings.ts` | edit | `retrospective?: string` on `PromptOverrides`; `sanitisePromptOverrides` picks it up via `Object.keys`, no change needed there. |
| `lib/writer.ts` | edit | `NOTE_SUBDIRS` entry + `writeSynthesis`. |
| `lib/recentDetailView.ts` + `lib/noteRelated.ts` | edit | Derive subdir from uri, not mode — see the three traced consequences above. |
| `screens/AskScreen.tsx` | **new** | Renders answer, tappable sources, Save. Gets `AskScreen.test.tsx` per the 7-of-9 screen-coverage norm. |
| `screens/SearchScreen.tsx` | edit | A button and a `navigation.navigate` — deliberately near-zero growth; the file is already 474 lines. |

### Flow

Terminology, used precisely below: **candidates** are every note on screen in Search;
the **retrieval set** is the subset actually selected and sent after the budget binds.
Steps 2, 6 and the security section all mean the retrieval set, not the candidates.

1. **Candidates.** Union by `uri` of `SearchScreen`'s `bodyMatches` and `results`. Body
   matches rank first (they are evidence of a real hit in the body, not just an excerpt
   window); indexed results follow **in the order Search already displays them**. No new
   ranking function is written.
2. **Budget.** Take candidates in that order until either cap binds:
   `MAX_NOTES = 12`, `PER_NOTE_CHARS = 2000`, `TOTAL_BUDGET_CHARS = 16000`. The total is
   the binding constraint by construction; the per-note cap exists so one long note
   cannot consume the bundle. A truncated note is marked as truncated in the payload so
   the model knows it is seeing a fragment. All three live as constants in
   `retrospective.ts` — one place to tune.
3. **Read.** Full bodies for selected notes only, via `readNote` at the existing
   `SCAN_CONCURRENCY` 8 bound, abortable. Unreadable notes are skipped, matching
   `buildNoteIndex`/`searchNoteBodies` behavior.
4. **Ask.** Through `dispatcher.askVault`. Works against either backend by construction.
5. **Sanitize.** `sanitizeMarkdown` on the answer **before rendering**, not only before
   saving — the output reaches a markdown renderer first, and that is the same gate B3
   established for LLM output reaching the vault.
6. **Linkify defensively.** A `[[title]]` becomes tappable **only if it resolves to a
   note that was in the retrieval set**. A citation the model invented renders as inert
   text rather than a link to nothing. Taps go `resolveNoteEntry` → `RecentDetail`.
7. **Save (explicit).** `writeSynthesis` into `Notes/`, slug from the question via the
   existing `slugify`, collision handling inherited from `findCollisionFreeName`.
   **The write must be paired with `upsertNoteInIndex`**, matching every other write
   site in the app (`CaptureScreen.tsx:426,706,810`, `RecentDetailScreen.tsx:341`,
   `TodosScreen.tsx:146`; the queue and edit-session use `invalidateNoteIndex`
   instead). Without it the saved note is on disk but absent from Search and
   TagBrowser until a manual pull-to-refresh — which reads to the user as "I saved it
   and it vanished."

### Saved note shape

```markdown
---
created: YYYY-MM-DD
tags: [synthesis]
question: "what have I been thinking about X?"
---
# {derived title}

{answer}

## Sources

- [[note-a]]
- [[note-b]]
```

`tags: [synthesis]` makes these filterable in both Carnet's TagBrowser and Obsidian
without any new mechanism. Frontmatter must stay byte-compatible with existing vault
files — verify against `lib/frontmatter.ts` and its tests before changing serialization.

### Prompt contract

The system prompt constrains the model to: answer **only** from the supplied notes; say
so plainly when the notes do not support an answer (rather than reaching for general
knowledge); cite as `[[title]]`; never invent. This differs materially from
`buildEnhanceProsePrompt`, which deliberately *adds* real-world fact — which is why this
is a new prompt rather than a reuse of Enhance.

`chatCompletion`'s `NoteType` argument is **inert for a bare-prose call** — see the
comment at `llmClient.ts:620` explaining exactly this for `enhanceProse`. Pass
`"journal"` and mirror that reasoning in a comment.

### Security

- **Prompt injection is a first-class risk here, more than anywhere else in the app.**
  Every other enrich call wraps *one* user-authored capture in `INJECTION_GUARD`. This
  call bundles up to twelve notes — a single note containing "ignore previous
  instructions" would ride along with eleven innocent ones. Every note body goes inside
  the `<USER_INPUT>` guard, and each note is individually delimited so the model can
  attribute content to a source.
- **Output sanitization** at step 5, before render and before save.
- **Hallucinated-link containment** at step 6.
- No new network hosts: the call goes through the same `dispatcher` → `llmClient` →
  `netAllowlist` path as every existing enrichment.

## Non-goals

- Embeddings / semantic retrieval — S4's fate is lexical; do not reopen it here.
- Token-by-token streaming of the answer (`chatCompletion` is non-streaming).
- Multi-turn follow-up questions. One question, one answer.
- Editing the answer in-app before saving. Save it, then edit it in `RecentDetail` or
  Obsidian like any other note.
- A distinct `CaptureMode` variant for synthesis notes (see rationale above).
- A `carnet://ask` deep link.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A local backend (Relais) with a small context window rejects a 16k-char bundle | **Medium** | Conservative default budget; failure surfaces through the dispatcher's existing error classification, not a new error path. Constants are tunable in one place. Calibrate against a real Relais model during implementation. |
| Answer quality depends on the user having framed a good search first | Medium | Accepted, and inherent to decision 2 — retrieval is visible precisely so a thin answer is diagnosable. The button naming the note count is part of this. |
| Prompt injection from note content | Medium | `INJECTION_GUARD` over the whole bundle, per-note delimiters, output sanitization, hallucinated-link containment. |
| Twelve `readNote` calls add latency before the LLM call | Low | Bounded at concurrency 8, abortable, and strictly smaller than the Phase 2 full-vault scan the user may already have run. |
| `Notes/` grows unbounded with saved answers | Low | Saving is explicit per decision 1; `tags: [synthesis]` makes them bulk-filterable. |
| Index drift vs. Syncthing edits | Low | Pre-existing exposure shared with the tag/note index; pull-to-refresh is the documented recovery. |

## Testing

- `retrospective.ts` unit tests over the existing `test/fixtures/vault/` notes: selection
  order (body matches first), budget truncation (both caps), per-note truncation
  marking, answer validation, and **the hallucinated-wikilink guard**.
- Per the pattern the Todos work used, the guard tests are **verified to fail against
  the unguarded logic before landing** — a regression test that never went red proves
  nothing.
- `AskScreen.test.tsx` for wiring/render, jsdom + `@testing-library/react` under
  `PaperProvider`, matching `TagBrowserScreen.test.tsx`.
- Extend `verify:capture-flow` with `retrospective.test.ts`.
- Gates unchanged: `tsc --noEmit` + vitest per workspace, plus mobile lint.

## Acceptance criteria

1. From a Search with results, "Ask about these N notes" produces a synthesized answer
   citing only notes that were in the retrieval set.
2. A citation to a note **not** in the retrieval set renders as inert text, not a link.
3. Save writes exactly one file under `Notes/`, with frontmatter that round-trips
   through `lib/frontmatter.ts` unchanged.
4. The saved note appears in Search and TagBrowser (under `synthesis`) **without a
   manual refresh** — proving both the one-line `NOTE_SUBDIRS` change and the paired
   `upsertNoteInIndex`. A pass that requires pull-to-refresh is a failure of this
   criterion, not a pass with a caveat.
5. Opening a saved synthesis note in `RecentDetail` offers **no "Re-enrich" action**,
   and its related-notes self-exclusion resolves against `Notes/`, not `Ideas/`.
6. With no backend configured, the button surfaces the existing not-configured error
   rather than a blank answer or an opaque fetch failure.
7. The whole flow works against a local backend with no network.

## Open decisions

**Settled 2026-09-07:** the subdir is **`Notes/`** (confirmed with the user; `Syntheses/`
and `Questions/` were the alternatives). This was raised as blocking because it is a
one-string change before the first write and a migration afterwards. It is now closed —
do not reopen it at plan time.

**At plan time:**

- Whether the one-time remote-backend explainer is a dialog or an inline dismissible
  banner on `AskScreen`.
- Budget constants ship **conservative by default** (`MAX_NOTES` 12 / `PER_NOTE_CHARS`
  2000 / `TOTAL_BUDGET_CHARS` 16000) and are tuned on device. Calibrating against a real
  Relais model is desirable but explicitly *not* a prerequisite — Relais runs as a
  separate app on the handset and may not be reachable from the dev environment, so a
  plan that blocks on it would stall. The constants live in one place for exactly this
  reason.
