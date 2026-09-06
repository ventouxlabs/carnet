# Session handoff — 2026-09-06 (vault todo aggregation shipped, v0.10.0)

Follows `2026-08-22-transport-matrix-closed-v0.9.0-fdroid-ready.md`. Covers
2026-09-02 → 2026-09-06: one feature from draft PRP to release, plus the
follow-up hardening that review turned up along the way.

## State at handoff

`main` at **`4fd9119`** (#205), CI green. Mobile suite **2123/2123** (was 2062
at the last handoff), capture-flow fixture gate 314/314. Release **v0.10.0**
(versionCode 8) published 2026-09-06 15:01 UTC from `fa8f3c9` (#202), signed
APK workflow-verified. Three docs/copy PRs landed on `main` after the release
(#203 this handoff, #204 Pixel 10 results, #205 vault-path helper-text fix) —
**#205 is user-facing copy that is NOT in v0.10.0**; it ships with the next
release. Only open issue: **#182** (F-Droid), unchanged. No open PRs, tree
clean, no active worktrees.

## The feature — vault-wide todo aggregation (#200, #201)

Users already write `- [ ] task` lines inside notes captured through the
existing surfaces. Carnet now indexes those lines across the vault, lists them
in a Todos screen (Open/All filter), and lets you check one off with a
write-back that is **anchored to the line's own text, re-read fresh at write
time — never a remembered line number**. That property is the whole design;
Android/Syncthing `content://` URIs report no mtime, so a file can be rewritten
between index and write, and a positional write-back would corrupt the wrong
line.

- `lib/checklist.ts` (new, pure) — `extractChecklistLines` /
  `toggleChecklistLine`. Both scope to the body via `splitFrontmatter`, so a
  toggle can never touch YAML frontmatter (byte-exact `header + body`).
- `lib/writer.ts` — `updateChecklistItem`: `serialize()`-locked read → pure
  toggle → write. Refuses (`not_found` / `ambiguous`) rather than guess.
- `lib/vault.ts` — `NoteIndexEntry.todos?` (optional; mirrors the `status?`
  precedent — **no `carnet:noteindex:v1` cache-key bump, no migration**; old
  cached blobs simply have no todos until the next rebuild) + `getAllTodos`.
- `screens/TodosScreen.tsx` (new) — optimistic flip, reverts on `{ok:false}`
  AND on a thrown error (the latter was the one Important finding the final
  whole-branch review caught — a thrown SAF error used to leave the checkbox
  asserting a write that never happened).
- Entry point lives on **Search's header next to Tags, not Home's** (#201):
  `App.tsx` documents "one primary action per screen" as why Tags was moved
  off Home; the first cut put Todos back on Home and broke that pattern.

### How it was built (worth knowing before touching it)

The originating PRP proposed five new capture surfaces + a root `Todo.md`.
An adversarial critique found all five surfaces already shipped and that a
root `Todo.md` doesn't fit `writer.ts` (`NOTE_SUBDIRS` excludes root; every
writer is create-only except `appendJournal`). The feature was re-scoped to
the one real gap. Full rationale: `.claude/PRPs/prds/notes-todo-capture.prd.md`;
the plan (now `plans/completed/`) has the task breakdown.

Executed task-by-task with an independent reviewer per task, a final
whole-branch review, then a devil's-advocate pass on the follow-up commit.
Things those reviews caught that a plain implementation would have shipped:

1. `toggleChecklistLine` originally scanned raw markdown incl. frontmatter →
   fixed to `splitFrontmatter` body-only (frontmatter corruption risk).
2. `flipInIndex` matched by `(uri, text)` → two identical-text lines in one
   note both flipped locally on a single tap. Fixed with a per-note `ordinal`
   on `AggregatedTodo` — **UI-local identity only, never sent to
   `updateChecklistItem`**, which stays text-anchored. Then a further guard:
   `flipInIndex` verifies the line at that ordinal still has the expected text
   before trusting the position (a pull-to-refresh landing mid-toggle can
   re-extract the note and shift ordinals). Regression tests for both were
   verified to FAIL against the prior logic before landing.
3. `ChecklistUpdateResult` made a proper discriminated union.

## On-device verification (Pixel 9 Pro Fold, real Syncthing vault)

Built a release APK from the branch and ran the plan's manual checklist against
**real pre-existing vault files** via `adb shell` (full read/write to
`/storage/emulated/0/Documents/carnet`, a live `.stfolder`):

| Check | Result |
|---|---|
| Pre-existing checklist item appears in Todos after pull-to-refresh | ✅ (and correctly showed nothing before refresh — the pre-feature cached index, live) |
| Checking it changes exactly one line on disk | ✅ `diff` of pulled file: `- [ ]`→`- [x]`, nothing else; unchecking restored the file byte-identical |
| Stale item (text edited under the cache) refused, no write | ✅ |
| Two identical lines refused as ambiguous, only tapped row reverts | ✅ |
| **Syncthing round-trip to an Obsidian desktop** | ⚠️ **UNVERIFIED** — needs a second machine; `.stversions` empty, Syncthing app not debuggable/not running at test time, no logcat trace. Genuinely cannot be closed from the phone alone. |

Install notes: the device's existing `com.ventouxlabs.carnet` was already
release-signed, so `adb install -r` upgraded in place (settings/vault path
preserved). `expo prebuild --clean` was required in the fresh worktree.

### Second device — Pixel 10 Pro Fold (Android 17), the *published* v0.10.0 APK

Repeated after the release, on different hardware, using the actual GitHub
Release asset (`carnet-v0.10.0.apk`) rather than a local build. Same four
checks, same results: aggregation after refresh ✅; exactly one line changed on
disk (`diff`, other notes untouched) ✅; stale item refused, disk untouched,
checkbox reverted ✅; two identical lines rendered as independent rows, refused
as ambiguous, disk untouched, only the tapped row reverts ✅. The #201 header
move is confirmed in the shipped build: Home = Sync + Search + Settings only;
"View todos" sits next to "Browse tags" on Search's header. Syncthing
round-trip still ⚠️ — this device has no Syncthing at all.

Things learned that the next session should not rediscover:

- **A typed raw path does not work on Android 17.** Settings' helper text says
  you can "type a path directly (e.g. /storage/emulated/0/carnet)", and the
  field accepts it, but (a) it only updates form state until **Save** is tapped,
  and (b) even saved it becomes `file:///storage/emulated/0/carnet`
  (`vaultRoot.ts:55`), which the app cannot read under scoped storage — it
  holds no storage permission (`READ/WRITE_EXTERNAL_STORAGE granted=false`, no
  `MANAGE_EXTERNAL_STORAGE`). The scan silently finds nothing. **Use "Pick
  folder"** (SAF) — it grants a `content://` tree URI, shown in the field as
  the friendly label `primary:carnet`. The misleading helper text — and the
  same advice in README.md and docs/sync-setup.md (whose troubleshooting row
  recommended the *failing* typed path as the fix for "permission denied") —
  was corrected in **#205** (copy only, field kept for legacy-storage
  devices). Not in v0.10.0; lands with the next release.
- Saving a real folder for the first time runs `migratePreVaultNotes` (#172):
  the two 8/18 QA notes moved from the app sandbox into the folder ("Moved 2
  earlier captures into your vault"). Non-destructive, by design.
- The Bascule scale app (`com.ventouxlabs.bascule`) on this device grabbed
  foreground mid-run (Bluetooth scale event or a stray gesture), which made one
  uiautomator dump look like an empty Todos list. Assert `mCurrentFocus` is
  Carnet before trusting any dump — same lesson as the Pixel 9 blind-tap note.
- A refresh swipe that starts on an empty FlatList can over-scroll into the
  notification shade / app switcher. Start swipes at y≈700, moderate distance,
  and never compute a tap point from an empty uiautomator match (an empty
  match became a tap at (44,44) = the back arrow, which navigated away).

## Release v0.10.0

Minor bump per the repo's exceptionless pattern (v0.3.0→v0.9.0 all minor).
`fastlane/.../changelogs/8.txt` added. `.omc/RELEASE_RULE.md` (gitignored,
local) now documents the channel map derived this session:

- **GitHub Releases** — tag push, fully automated (`release.yml`).
- **IzzyOnDroid** — automatic; pulls each tagged GitHub Release. Nothing to do.
- **Google Play** — NOT automated (no CI publish step, no service account).
  `build-release-apk.sh --aab` builds the bundle for a manual first upload.
  **Correction to an in-session misstatement:** the Ventoux Labs org account is
  *exempt* from the 12-tester closed-test gate. What actually blocks a listing
  is three Play Console checkboxes — merchant/payments profile, accept Play App
  Signing, Data safety + content rating forms. All repo-side prep is done
  (`plans/monetization-play-donations.plan.md`, Track 1).

## Standing items

- Syncthing round-trip for Todos — user-performed, needs a workstation.
  Neither test device could do it: the Pixel 9's Syncthing wasn't observable,
  the Pixel 10 has no Syncthing installed.
- **Pixel 10 device-state change, left in place deliberately:** its Carnet
  vault was switched from the app sandbox to the SAF folder
  `/storage/emulated/0/carnet` (the folder already existed on the device), and
  the migration moved its two 8/18 QA notes there. Reverting the setting would
  hide those notes (they now live in the folder, not the sandbox), so this was
  not undone. The seeded test note was deleted; the two QA notes are intact.
- Google Play: three human checkboxes above, then a manual AAB upload.
- GitHub Sponsors enrollment (Track 2) — unblocks `FUNDING.yml`, README badge,
  Settings "Support development" row. Do NOT commit placeholder handles.
- #182 Phase 2 — copy the validated fdroiddata recipe into a fork, `fdroid
  lint`, open the MR (user).
- Earlier standing items (Pixel 9 pending-badge anomaly, June `stash@{0}`, STT
  model-download prompt) unchanged from the 08-22 handoff.

## Two decisions worth closing rather than leaving open (from TODO.md)

- **On-device Gemma native backend** — TODO.md says "needs a decision, not
  execution." Relais already delivers offline enrichment; the only unbuilt part
  is a ~1.5GB in-process model with battery cost. Recommend closing as
  won't-do unless a concrete need appears.
- **Browse/search Phase 3** (retrospective "what have I been thinking about
  X?" query) — the last piece of that axis and the largest genuinely-new
  feature on the board. Needs an LLM round-trip over retrieved notes via the
  `dispatcher.ts` seam (either backend). This is the recommended next feature
  if one is wanted.

## Next session

1. If the user ran the Syncthing round-trip: record the result here and in
   the #200 PR description (currently marked unverified).
2. Any new-feature work: Phase 3 above, planned via `.claude/PRPs/` as usual.
   `enhance-source-citations.plan.md` stays blocked on the OmniRoute gateway.
3. `apps/mobile/android/` may still exist locally from this session's release
   build — it's gitignored prebuild output, safe to delete.
4. The #205 vault-path copy fix is on `main` but not in any published build.
   Whenever the next release is cut, its changelog should mention that the
   Storage settings text now points users to "Pick folder".
