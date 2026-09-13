# PRD: Note capture mode — a sixth capture mode writing into `Notes/`

**Status:** approved · **Date:** 2026-09-13 · **Partially reverses:** the "No new capture surface" non-goal in `notes-todo-capture.prd.md` (2026-09-03) — see "Why this reverses a prior decision".

## Why this exists

The user's mental model is:

> **Ideas are for brainstorming. Notes are for todo lists and things I need to get done.**

Carnet does not implement that split. Its five capture modes (`idea`, `journal`,
`person`, `photo`, `audio`) route to `Ideas/`, `Journal/` and `People/`; `Notes/`
exists but is written only by `writeSynthesis()` for saved retrospective answers. A
user who wants to capture a task list has one option — an Idea — and the Idea prompt's
explicit job is to *expand a half-formed thought into prose*, which is close to the
worst thing you can do to a todo list.

The todo machinery already works: `- [ ]` lines inside any note are indexed and
aggregated by `TodosScreen` (#200, v0.10.0). What is missing is a capture path whose
prompt preserves a list instead of inflating it, and a destination that matches how
the user already thinks about their vault.

## Why this reverses a prior decision

`notes-todo-capture.prd.md` lists "**No new capture surface**" and "**No `Todo.md`
file, no root-level vault writes**" as non-goals. That decision followed a critique of
a draft proposing five new capture surfaces plus a root `Todo.md`. **Those objections
do not apply here, and it is worth being precise about why rather than quietly
contradicting the earlier document:**

| Original objection | Applies here? |
|---|---|
| "All five capture surfaces already ship — nothing to build" | **N/A.** This adds no new *surface* (no widget, notification, share target). It adds one row to the existing capture sheet — a new mode on a surface that already exists. |
| "A root `Todo.md` doesn't fit the writer: it is excluded from Search/tag-index/note-index, and needs a net-new root-write path and append primitive" | **No.** `Notes/` is already in `NOTE_SUBDIRS`, already indexed by Search, TagBrowser and the todo scan, and `writeSynthesis()` already writes there create-only. No new primitive. |
| "The write-back mechanism (cached line number) is a vault-corruption path" | **N/A.** This PRD writes new files create-only. It does not touch checkbox write-back, which `updateChecklistItem` already solves text-anchored. |
| "No note-vs-todo intent auto-classification" | **Still honoured.** The user picks the mode explicitly. Nothing infers intent. |

The one non-goal genuinely reversed is "no new capture surface", narrowly: one new
mode, on an existing surface. Everything else in that PRD stands.

## Scope

### 1. `note` becomes a real `CaptureMode`

`CaptureMode` (`lib/storage.ts:6`) becomes
`"idea" | "journal" | "person" | "photo" | "audio" | "note"`.

Rejected alternative: keeping mode `"idea"` and adding a separate `destination`
field. That introduces a second dimension every existing mode check must also
consider, and makes "an idea that is not in `Ideas/`" a lie the codebase has to keep
telling. A new variant is honest and the compiler finds the call sites.

### 2. The Note prompt tidies and tags; it never expands

New `buildNotePrompt` in `prompts.ts`. Required behaviour:

- Give the note a concise, slug-friendly title.
- Suggest 2-3 tags, `tags: [note, {tag1}, {tag2}]`.
- **Preserve the user's lines verbatim.** No prose expansion, no rewording, no
  summary paragraph. This is the single hard constraint that distinguishes it from
  `buildIdeaPrompt`, whose step 2 is literally "Expand the thought slightly".
- Render lines that are already actions as `- [ ]` checkboxes so they reach
  `TodosScreen`. **Reuse the established phrasing** from the Idea and Journal
  prompts — "commitments the user actually made… phrased faithfully from the input —
  NEVER invent tasks" — rather than inventing new wording. A line becomes a checkbox
  only if it is already an action the user wrote.
- Carry `INJECTION_GUARD` like every other builder.

Rejected alternative: a deterministic post-pass converting every non-heading line to
a checkbox. Predictable but wrong — it would tick-box context lines and reference
material.

### 3. Destination: `Notes/`, shared with synthesis output

Captured notes and saved Ask answers both live in `Notes/`. No migration, no existing
file moves.

**This changes what `Notes/` means, and the codebase must be updated to match.**
`writeSynthesis`'s docstring (`writer.ts:188`) currently asserts *"Notes/ holds
computed artifacts that cite other notes, as distinct from Ideas/ which holds things
the user jotted."* That invariant is deliberately broken here. The docstring must be
rewritten in the same PR, or the code carries a false statement about its own design.
New meaning: **`Notes/` holds notes the user is working from — captured task notes and
saved answers alike — as distinct from `Ideas/`, which holds thoughts to develop.**

### 4. Distinguishing synthesis notes stops using the folder

Today `RecentDetailScreen.tsx:745` gates Re-enrich on
`subdirForUri(entry.filepath) !== "Notes"`. That works only because
`inferNoteMode` collapses every unrecognised folder to `"idea"`, so a synthesis note
reports a re-enrichable mode and needs a folder-shaped patch.

Once `inferNoteMode` maps `Notes/ → "note"`, the folder can no longer carry that
meaning — both kinds of file live there. Synthesis notes are already distinguishable
by frontmatter: `buildSynthesisNote` (`retrospective.ts:194-199`) always emits
`tags: [synthesis]` and a `question:` field.

Add `isSynthesisNote(markdown): boolean` (frontmatter test) and gate on that. **This
replaces a proxy with a real test and is a small pre-existing weakness fixed in
passing, not a new one introduced.**

### 5. Capture surface

One new row in `SHEET_ROWS` (`components/CaptureFab.tsx:18`), and `CaptureTarget`
(`CaptureFab.tsx:8`) gains `"note"` in its `capture` variant. The FAB's own tap stays
Idea — the fastest path is unchanged, per that file's AUDIT.md §3.1 note.

### 6. Save-first, like Idea

The note is written raw immediately, enrichment updates it in place (B4). Consistent
with the user's "tidy, don't expand" choice — there is nothing to preview-gate.
`"note"` joins `RE_ENRICHABLE_MODES` (`finishEnrichment.ts:73`) so a failed
enrichment can be retried, exactly like Idea.

### 7. Offline queue

`QueuePayload` (`queue.ts:119`) gains `NotePayload`, and the drain routes it to
`dispatcher.enrichNote`. Without this an offline note capture cannot drain.

### 8. Enrichment plumbing

`enrichNote` in `llmClient.ts` and `dispatcher.ts` — the sixth entry point, following
the exact shape of the other five, including the trailing `availableTags: string[] = []`
and `withTagHint` applied to the final system string after any override. A
`promptOverrides.note` key joins the existing five so the note prompt is
user-overridable like every other.

## Non-goals

- **No change to todo aggregation or write-back.** `TodosScreen`,
  `extractChecklistLines` and `updateChecklistItem` are untouched; a captured note's
  checkboxes are picked up by the existing scan for free.
- **No `Todo.md`, no root-level writes.** Unchanged from the prior PRD.
- **No intent classification.** The user picks Note or Idea.
- **No migration of existing notes.** Nothing in `Ideas/` moves.
- **No new capture surfaces** — no widget, notification, or share-target entry for
  Note. The sheet row only. Those can follow if the mode proves useful.
- **No Journal-style append.** Each Note capture is its own create-only file; there is
  no "today's note" to append to.

## Risks

| Risk | Mitigation |
|---|---|
| The model expands or rewords a todo list despite the prompt | The hard constraint is testable: a fixture whose input is a bare task list must round-trip with its lines intact. Make that a repro-harness case, not just a unit assertion. |
| A new `CaptureMode` variant reaches persisted data (capture history, queue rows, drafts) | Same class as the `useExistingTagsForAutoTag` settings field, which occupied 12 sites across 3 files. Enumerate with `grep -rn 'CaptureMode'` and let `tsc` find the rest; ~29 mode-equality sites exist today. Old persisted rows never contain `"note"`, so reads stay valid — this only adds a variant, never removes one. |
| `Notes/` now mixes two kinds of file, confusing in Obsidian | Synthesis notes carry `#synthesis`; captured notes carry `#note`. Both filter cleanly. Accepted deliberately over a split-brain migration. |
| Checkbox normalisation fires on non-actions | Reuses the "NEVER invent tasks" phrasing already proven on Idea/Journal. Worst case is a stray checkbox in a user's own note, which they can delete — not data loss. |

## Acceptance criteria

1. The capture sheet shows a **Note** row; choosing it opens a text capture.
2. A captured note is written to `Notes/<slug>.md`, create-only with collision
   suffixing, and appears on Home and in Search.
3. Its frontmatter carries `tags: [note, …]`, and the enriched body **contains every
   line the user typed, unexpanded**.
4. Lines the user wrote as actions appear as `- [ ]` and show up in `TodosScreen`
   without any further change.
5. Capturing a note offline queues it, and draining after reconnect enriches it.
6. Re-enrich works on a captured note and remains unavailable on a synthesis note —
   the latter now determined by frontmatter, not by folder.
7. `writeSynthesis`'s docstring no longer claims `Notes/` holds only computed
   artifacts.
8. Full gate green: `tsc --noEmit` + vitest in both workspaces, mobile lint, and
   `verify:capture-flow`.
