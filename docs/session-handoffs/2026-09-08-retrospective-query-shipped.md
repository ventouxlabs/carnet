# Session handoff — 2026-09-08 (retrospective query shipped)

Follows `2026-09-06-todo-aggregation-v0.10.0.md`. One feature from "what should
we build next?" to merged, plus the two defect fixes it exposed along the way.

## State at handoff

`main` at **`9e8c3eb`** (#212), CI green. Mobile suite **2216/2216** across 137
files (was 2123), capture-flow gate 347/347.

**v0.11.0 is RELEASED** (versionCode 9), published 2026-09-09 01:49 UTC from
`ab17620` by `release.yml`, cert-verified, and installed on both the Pixel 9 Pro
Fold and Pixel 10 Pro Fold. It carries this feature **and** #205's vault-path
copy fix, which had been stranded on `main` through three cycles. IzzyOnDroid
pulls it automatically; `changelogs/9.txt` shipped in the tagged tree so the
listing has release notes.

Only open issue: **#182** (F-Droid), unchanged. No open PRs, tree clean, no
active worktrees.

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

## On-device verification — Pixel 9 Pro Fold, Android 17 (2026-09-08)

**All seven acceptance criteria pass**, against a *real* Syncthing vault
(`/storage/emulated/0/Documents/carnet`, 7 notes, live `.stfolder`) with an
on-device model (Relais serving `http://127.0.0.1:8080`, Gemma-4-E4B-it).

| # | Check | Result |
|---|---|---|
| 1 | Answer cites only retrieval-set notes | ✅ all 4 resolved to the queried notes |
| 2 | Out-of-set citation renders inert | ✅ **fired naturally — see below** |
| 3 | One file under `Notes/`, frontmatter parses | ✅ `travel.md`, `tags: [synthesis]` |
| 4 | Appears in Search **without** a refresh | ✅ `#synthesis` visible immediately |
| 5 | No Re-enrich on a synthesis note | ✅ actions sheet has none |
| 6 | Not-configured surfaces the real error | ✅ "your LLM provider URL not configured — set it in Settings." |
| 7 | Local backend, **no network** | ✅ answered in ~20s with `Active default network: none`, `ping 8.8.8.8` unreachable |
| — | Citation taps (jsdom-impossible) | ✅ tapping a citation opened that exact note |

**The best result was unplanned.** On the offline run the local model
hallucinated a citation to `[[18:44]]` — a journal timestamp heading, not a note
in the retrieval set. It rendered as **plain bracketed text while every real
citation rendered green and underlined**. The containment guard caught a genuine
hallucination in production, with no adversarial input crafted for it.

Also confirmed on hardware: the Save latch holds past the 2.5s toast dismissal
(a second tap produced no `travel-2.md` — the duplicate-write bug review finding
#1 caught); a failed ask renders a working Retry instead of dead-ending
(finding #2); the exposure explainer appears for a **remote** provider and never
for the local one; the saved file keeps **real `[[wikilinks]]`**, so the
display-only normalisation boundary holds; and the "Idea" mode label on a
`Notes/` note is present exactly as knowingly deferred.

Pixel 10 Pro Fold got the published APK too — install, launch, Ask entry point
and count verified. It has no Relais and no Syncthing, so its pass is
necessarily shallower; a query with no matches correctly showed **no Ask
button**, which no test had covered on device.

### Device-QA lessons worth not rediscovering

- **The on-screen keyboard silently swallows taps.** Three taps on the Ask
  button did nothing until `dumpsys input_method` showed `mInputShown=true`.
  Dismiss the IME before tapping anything low on the screen. Same class as the
  historical STT first-tap bug.
- **The Ask button's centre point sits inside the gesture-nav inset** (button
  spans y 2292–2395 on a 2424-tall screen). Tap ~20px below its top edge, not
  its centre.
- **Relais' ready state reads `LIVE`, not `ONLINE`** — a poll waiting for
  "ONLINE" times out against a server that is already up. It exposes both a LAN
  https endpoint and `127.0.0.1:8080`; only the loopback one survives airplane
  mode.
- **Airplane mode alone does not kill Wi-Fi** on this device (Android remembers
  it). `svc wifi disable` + `svc data disable` were needed for a true offline
  test; verify with `Active default network: none` before believing it.
- Pixel Fold `screencap -p` prefixes a multi-display warning to the PNG — strip
  to the `\x89PNG` magic before reading.

## Standing items

- **The Syncthing round-trip for Todos** is still open from the v0.10.0 cycle —
  it needs a second machine, which neither test device is.
- **One real UX finding from the device run, not a blocker:** citations render as
  the **full note title**, and journal titles here are whole sentences. The prose
  becomes "…continuing to Colmar *My family traveled to France via Strasbourg
  after arriving from the US, while I completed another day of reserve duty.*."
  — correct, but hard to read, with a doubled period where the title's own full
  stop meets the sentence's. Truncating long citation labels is the obvious fix.
  Logged in `TODO.md`.
- Google Play: three human checkboxes, then a manual AAB upload. GitHub Sponsors
  enrollment still unblocks `FUNDING.yml`. #182 Phase 2 is user-side.

## Next session

The board is genuinely clear — feature shipped, released, verified, docs
reconciled. Options, roughly in order of value:

1. **Citation-label truncation** (see Standing items). Small, self-contained,
   and it improves the one screen whose value proposition is readability.
2. **Vault tag awareness** (v0.4 S3, never shipped) — the best-specified unbuilt
   item on the board, with roughly half the cost already paid by `getTagIndex`.
   Auto-tagging currently invents tags freely, so a curated vault accumulates
   `dev` / `development` / `engineering`.
3. **Todos Syncthing round-trip** — needs a workstation, not a phone.
4. "On this day" resurfacing and Todos date parsing were both floated in the
   2026-09-07 planning pass; neither has validated demand. Don't build either
   without asking first.

**A caution learned twice this session:** documentation drift was the real
defect more often than code was. `TODO.md` listed a shipped feature as deferred,
and the codemaps named two source modules (`lib/omniroute.ts`,
`lib/localLlm.ts`) that no longer exist — `backend.md`'s LLM section header
pointed straight at a deleted file. Both were found only because something
forced a re-read. When a claim in these docs looks load-bearing, grep it before
trusting it.
