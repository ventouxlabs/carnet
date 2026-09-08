# Session handoff — 2026-09-08 (retrospective query shipped)

Follows `2026-09-06-todo-aggregation-v0.10.0.md`. One feature from "what should
we build next?" to merged, plus the two defect fixes it exposed along the way.

## State at handoff

`main` at **`d2b3c8b`** (#208), CI green. Mobile suite **2216/2216** across 137
files (was 2123), capture-flow gate 347/347. Version still **v0.10.0** — this
work is **unreleased**, and so is #205's vault-path copy fix from the last
cycle. Only open issue: **#182** (F-Droid), unchanged. No open PRs, tree clean,
no active worktrees.

## The feature — retrospective query (#207)

Closes `v0.5-browse-search.prd.md` **Phase 3**, the "what have I been thinking
about regarding X?" question `TODO.md` has carried since v0.1. From Search, ask
about the notes currently on screen; an LLM synthesizes an answer citing them
with `[[wikilinks]]`; the answer is ephemeral until explicitly saved into a new
`Notes/` subdir.

**Why it was unblocked now, since the PRD said otherwise:** that PRD gated
itself with "ship Phase 3 after S4's fate is known." S4's fate *is* known — it
shipped **lexically** as `lib/relatedNotes.ts` (shared tags + term overlap over
the cached index; no embeddings, no vectors). So retrieval stays lexical and the
gate is satisfied. Do not re-open the embeddings question on the strength of the
old PRD text.

**Not the same thing as `enhance-source-citations.plan.md`,** which remains
blocked on an OmniRoute gateway change. That plan is about *external URL*
annotations from `sonar-reasoning-pro`. This feature's citations are *internal
wikilinks* into the user's own vault. If you let "citations" cover both, you
will wrongly conclude this axis is blocked.

### Four decisions, taken with the user — do not relitigate

Full rationale in `.claude/PRPs/prds/retrospective-query.prd.md`.

1. **Ephemeral + explicit Save.** Auto-writing every question litters the vault;
   a RAM-only answer would be the one artifact in Carnet that isn't a file.
2. **Retrieval is whatever is on screen in Search.** This is load-bearing: it is
   why the feature invents **no new ranking**, and why a thin answer is
   diagnosable as a retrieval failure rather than a synthesis one. `SearchScreen`
   builds candidates; `orderCandidates` owns ordering and dedup.
3. **Exposure shown, not blocked.** The button names what will actually be
   *sent* ("Ask about these 12 notes"), and `AskScreen` separately discloses
   "top N of M". Both halves are required and they measure different stages —
   the button counts what will be *picked*, the disclosure what was *packed*
   after unreadable/empty notes drop out. They are not meant to reconcile.
4. **Saved answers land in `Notes/`, not `Ideas/`.** `Ideas/` is a capture-mode
   folder for things the user jotted; a synthesis is a computed artifact citing
   sources. **`Notes/` is now part of the vault schema — renaming it is a
   migration, not a config change.**

### Module map

| File | |
|---|---|
| `lib/retrospective.ts` | new, pure — ordering, budget packing, citation resolution, `disclosureLine`, `normalizeLeadingMarkdown` |
| `lib/noteSubdirs.ts` | new, **zero imports** — `NOTE_SUBDIRS`, `NoteSubdir`, `parentSegment`, `subdirForUri` |
| `lib/prompts.ts` | `buildRetrospectivePrompt` + `stripGuard`/`stripTitle` |
| `lib/dispatcher.ts`, `lib/llmClient.ts` | `askVault` / `askRetrospective`, mirroring `enhanceProse` |
| `lib/writer.ts` | `"Notes"` in `NOTE_SUBDIRS`, `writeSynthesis` |
| `lib/vault.ts` | `readNoteBodies`, `subdirForUri` re-export, uri-first upsert |
| `lib/askExplainer.ts`, `components/AskExplainerDialog.tsx` | new — one-time remote-backend disclosure |
| `screens/AskScreen.tsx` | new — render, cite, save |

### Two defects the new subdir exposed, both fixed

`inferNoteMode` falls back to `"idea"` for any unrecognized folder, so a
`Notes/` note reports `mode: "idea"`. Two places branched on mode where they
meant *folder identity*:

- `noteRelated.ts` computed the related-notes self-exclusion subdir from mode,
  so a synthesis note excluded against `Ideas/`.
- `RecentDetailScreen` gated "Re-enrich" on `isReEnrichableMode`, and `"idea"`
  is re-enrichable — so **Re-enrich was offered on synthesis notes**, which
  would have run the idea prompt over a computed answer and overwritten it.

Both now read the uri via `subdirForUri`. **The display label at
`RecentDetailScreen` still says "Idea" for a `Notes/` note and is knowingly
wrong** — fixing it means adding a `CaptureMode` variant, and that type is
declared twice with different members (`storage.ts` has `photo`/`audio`,
`queue.ts` does not), so it means reconciling both plus every exhaustive
consumer. Deliberately deferred; don't treat it as a bug report.

## Security properties worth not breaking

- **Prompt injection.** `buildRetrospectivePrompt` strips `<USER_INPUT>` tags
  from bodies *and* titles, and additionally strips `[[`/`]]` from titles.
  Without this a hostile note could close its own block (or break out of its own
  wikilink on the header line), open a header naming a **real note in the same
  bundle**, and get a fabricated claim attributed to it. The citation guard
  cannot catch that — its contract is "does this note exist?", never "did this
  claim come from it?" Body brackets are deliberately preserved: they're how
  notes legitimately cross-reference each other.
- **Hallucinated links.** `resolveCitations` linkifies a `[[title]]` only if it
  resolves to a note actually in the retrieval set; anything else renders as its
  literal bracketed text so the user can see the model invented it.
- **Output sanitization** runs before *render*, not only before save — the
  renderer is the first place model output lands.
- **Display normalization is display-only.** The saved vault file keeps real
  markdown, because Obsidian renders `## ` and `- ` natively. There is a test
  reading `writeSynthesis`'s payload specifically to stop someone "simplifying"
  that later.

## How it was built

`.claude/PRPs/` pipeline as usual, executed with subagent-driven development:
eight tasks, an independent reviewer per task, four fix rounds, a whole-branch
review on the strongest model, and a scoped re-review of each fix round.

Things the reviews caught that a plain implementation would have shipped —
listed because they are the argument for keeping this structure:

1. `slugify(question)` was the **only unguarded `slugify` of nine call sites**.
   A CJK/Cyrillic/Arabic question slugifies to `""`, so Save would write a file
   literally named `.md` — invisible in Obsidian — and report success.
2. The index upsert was fire-and-forget, **silently defeating the acceptance
   criterion** requiring a saved note to appear without a manual refresh. The
   plan itself had specified that shape, copying the repo's convention; the
   convention is right everywhere except the one place a criterion contradicts
   it.
3. The Save button re-armed 2.5s after success (the toast flag doubled as the
   latch), so a second tap wrote a **duplicate note** — `writeSynthesis`
   collision-resolves rather than overwrites.
4. A failed ask degraded to a **permanently blank, unrecoverable screen** after
   the error Snackbar self-cleared.
5. `settingsTransfer`'s `isPromptOverrides` is a **validator**, not a filter — a
   settings export containing `retrospective` (or the pre-existing
   `enhanceProse`) was **refused wholesale on re-import**. Now typed
   `keyof Settings["promptOverrides"]`, so future drift is a type error.

Three of the highest-value findings were reviewers catching the **plan**, not
the implementers. Worth remembering when weighing whether the review passes earn
their cost.

## Deferred minors — triaged "ship as-is", don't rediscover them

`packBodies` breaks rather than skips on the first over-budget candidate
(plan-mandated, documented); `WIKILINK` mishandles nested brackets (fails safe
to inert text); dangling "Notes:" header in the Settings prompt preview;
duplicated doc comment between `retrospective` and `enhanceProse`;
`backend.md` formatting; "None of these notes could be read." is unreachable
copy; `askErrorMessage` classifies a `writeSynthesis` failure (wrong owner,
right output); the run-once ref is StrictMode-hostile (latent — no root
`<StrictMode>` today); a dead `@react-navigation/native` mock; a null-resolve
test that may assert early; `handleSave`'s post-await state updates lack a
mounted guard (dev warning only).

## Standing items

- **Device verification is the whole outstanding gap.** Acceptance criteria 6
  (not-configured error) and 7 (local backend, no network) are unverified, and
  `<Text onPress>` citation taps are **structurally unverifiable in jsdom** —
  `accessibilityRole="link"` appears in exactly one file repo-wide, this one, so
  nothing here has proven the pattern on-device.
- **The Syncthing round-trip for Todos** is still open from the v0.10.0 cycle.
  One device session could close it alongside the above.
- **A release is due.** #205's vault-path copy fix has been on `main` unreleased
  since before this work, and this feature now stacks behind it. Cutting a tag
  before the device pass would ship a device-unverified screen.
- Google Play: three human checkboxes, then a manual AAB upload. GitHub Sponsors
  enrollment still unblocks `FUNDING.yml`. #182 Phase 2 is user-side.

## Next session

1. Device pass: criteria 6 and 7, citation taps, and the Todos Syncthing
   round-trip. That is the shortest path to a releasable state.
2. Then a release tag — it would carry #205's copy fix plus this feature.
3. If more feature work is wanted before that, the remaining board is thin by
   design: vault tag awareness (v0.4 S3, never shipped, ~half the cost already
   paid by `getTagIndex`) is the best-specified unbuilt item. "On this day"
   resurfacing and Todos date parsing were both floated and neither has
   validated demand.
