# PRD: Vault checklist aggregation — todo index + safe toggle write-back

**Status:** draft · **Date:** 2026-09-03 · **Supersedes:** the "General Notes & Todo Capture" draft PRP (2026-09-02, five capture surfaces + a new `Todo.md` file) · **Source:** adversarial critique of that draft against the current repo state — see `.claude/PRPs/reviews/` session notes; findings summarized below.

## Why this PRD exists

A draft PRP proposed five new capture surfaces (widget, notification, share sheet, in-app FAB, voice) plus a new `Todo.md` file as the todo destination. A repo-grounded critique found:

- **All five capture surfaces already ship** — widget (`plugins/withCaptureWidget.js`), notification quick-add (`plugins/withCaptureNotification.js` + `lib/notificationQuickIdea.ts`), share sheet (`expo-share-intent` + `ShareReceiveScreen.tsx`), in-app FAB (`CaptureScreen.tsx`), voice (VoiceButton + `expo-speech-recognition`). A sixth (app shortcuts) exists too. Nothing to build here.
- **A `Todo.md` destination doesn't fit the current writer.** `writer.ts`'s `NOTE_SUBDIRS = ["Ideas", "Journal", "People"]` (writer.ts:427) excludes a root file from Search/tag-index/note-index entirely; every writer requires a subdir and is create-only except `appendJournal`, hardcoded to `Journal/<date>.md`. A root `Todo.md` needs a net-new root-write path, append primitive, and enumeration change — an architecture decision, not a config default.
- **The write-back mechanism the draft proposed (cache a line number, write to it later) is a vault-corruption path**, not a hypothetical: Android/Syncthing `content://` URIs report no modification time (`writer.ts:355-364`), so a file can be rewritten by Syncthing between when a line number was cached and when Carnet writes to it, landing `[x]` on unrelated text.
- **The real, much smaller opportunity**: users already type `- [ ] task` checkbox lines inside notes they capture through the existing surfaces, the same way they would in Obsidian. Carnet has no aggregated view of those lines and no way to check one off without opening the note. This PRD scopes exactly that.

## Theme

Extend the note-scan Carnet already performs (`vault.ts`'s note index, which backs Search and TagBrowser) to also pull out `- [ ]` / `- [x]` lines, surface them as one flat, filterable Todos list, and let the user toggle a box from Carnet with a write-back that is anchored to the line's *text*, never to a remembered position — so a stale cache can only fail safely (refuse), never corrupt an unrelated line.

## Current state (verified in-repo, 2026-09-03)

- **Note index**: `vault.ts` caches one AsyncStorage blob (`NOTE_INDEX_KEY = "carnet:noteindex:v1"`, vault.ts:35). `NoteIndexEntry` (vault.ts:63-83) holds `uri/subdir/title/createdOrDate/tags/mode/excerpt/status?`. `buildNoteEntry` (vault.ts:135) builds one row per note from its already-read full markdown; `buildNoteIndex` (vault.ts:157) scans `listNoteFiles()` at `SCAN_CONCURRENCY = 8`. The checklist-line extraction this PRD needs rides the same read — no new IO, no new scan.
- **Optional-field precedent, no cache-version bump**: `status?: string` (vault.ts:78-81) was added to `NoteIndexEntry` as optional specifically so "cached v1 blobs without it stay valid" — absent means no badge. The same pattern applies to a new `todos?` field: old cached blobs simply have no todos until the next rebuild/upsert, no migration needed.
- **Writers** (`writer.ts`): `readByUri`/`writeByUri` are private file-IO primitives; `updateNote` (writer.ts:338) is an unconditional overwrite; `updateNoteIfUnchanged` (writer.ts:396) guards an overwrite against a REMEMBERED baseline (mtime, or file content when mtime is unavailable — the normal case on Android SAF). `serialize()` (writer.ts:142-155) is a per-filepath promise chain already used by `appendJournal` (writer.ts:187-228) to stop two same-device writes to one file from clobbering each other.
- **Sync-conflict handling already exists and needs no changes**: `syncConflicts.ts` + `listSyncConflictFiles` (writer.ts:505) back a Home banner. `.claude/PRPs/prds/capture-timing.decision.md` already settled that any whole-file write (which every write in this app is — "Syncthing replicates files, not blocks") can race a Syncthing pull into a `*.sync-conflict-*.md` file — accepted as reconciliation cost, not data loss. A checklist toggle is just another such write; nothing new to design here.
- **No SQLite** (CLAUDE.md hard constraint, `expo-sqlite` removed #182) — the todo view is index-over-AsyncStorage, like Search and TagBrowser.
- **Screen pattern to mirror**: `SearchScreen.tsx` already does cache-first index read on focus (`getNoteIndex()`) + pull-to-refresh rebuild (`refreshNoteIndex()`) + a `FlatList`. `HomeScreen.tsx:226-244` wires a header `IconButton` to `navigation.navigate("Search")` — the same pattern adds a Todos entry point.
- **`Checkbox.Android`** (react-native-paper) is already used for a *selection* checkbox in `NoteCard.tsx:105`; `SegmentedButtons` is already used in `SettingsScreen.tsx:283`. Both are available without adding a dependency.

## Design — single phase

1. **`lib/checklist.ts` (new, pure, no filesystem)** — `extractChecklistLines(markdown): ChecklistLine[]` (regex over `- [ ]` / `- [x]` lines in the frontmatter-stripped body, case-insensitive `x`, leading-whitespace tolerant for nested lists, text length capped) and `toggleChecklistLine(markdown, text, expectedChecked): ChecklistToggleResult` — re-scans the markdown handed to it for a line whose trimmed text equals `text` AND whose current checked-state equals `expectedChecked`; flips it if there is **exactly one** match; otherwise returns a typed failure (`"not_found"` | `"ambiguous"`), never a guess. This is the concrete fix for the corruption path in the superseded draft: the anchor is the line's own text, checked against markdown read fresh at write time — never a cached line number.
2. **`writer.ts` — `updateChecklistItem(filepath, text, expectedChecked)`** (new export) — `serialize(filepath, …)` (reusing the exact lock `appendJournal` already relies on) → `readByUri` (fresh, not cached) → `toggleChecklistLine` (pure) → write only on success. No new baseline/guard primitive needed: because the read and the write happen inside the same serialized call, the just-read content *is* the anchor.
3. **`vault.ts`** — add `todos?: ChecklistLine[]` to `NoteIndexEntry` (optional, mirrors the `status?` precedent — no `v1`→`v2` cache-key bump), populate it inside `buildNoteEntry` (the single build point already called by both `buildNoteIndex` and the incremental `upsertNoteInIndex`, so incremental upsert picks it up for free), and add `getAllTodos(index: NoteIndex): AggregatedTodo[]` — flattens every note's `todos` into `{ uri, noteTitle, subdir, mode, text, checked }` rows.
4. **`TodosScreen.tsx` (new)** — structurally mirrors `SearchScreen.tsx`: cache-first index load on focus, pull-to-refresh rebuild, `FlatList` over `getAllTodos(index)`, a checked/unchecked `SegmentedButtons` filter. Tapping a row's `Checkbox.Android` calls `updateChecklistItem`, optimistically flips local state, and on `"not_found"`/`"ambiguous"` shows a `Snackbar` telling the user their view is stale (pull to refresh) rather than silently failing or guessing.
5. **Nav wiring** — `Todos: undefined` added to `RootStackParamList` (App.tsx:57-68) + a `Stack.Screen`, plus a header `IconButton` on `HomeScreen.tsx` next to the existing Search/Settings icons (HomeScreen.tsx:226-244), same pattern.

## Non-goals (explicitly cut from the superseded draft)

- **No new capture surface.** Widget/notification/share-sheet/FAB/voice are unchanged — all five already exist and already write notes containing whatever text the user typed, checkbox syntax included.
- **No `Todo.md` file, no root-level vault writes, no new append primitive.** Todos live wherever the user already wrote them (Ideas/Journal/People) — this avoids the `NOTE_SUBDIRS` architecture problem entirely.
- **No note-vs-todo intent auto-classification.** A checkbox is a checkbox; the user types `- [ ]` the same way they would directly in Obsidian. No destination-routing decision, so no pre-write-vs-post-enrichment classification-timing conflict to resolve.
- **No new sync protocol.** Rides the existing whole-file-write + Syncthing-conflict-file model this repo already built and already accepted the cost of.
- **No nested/sub-item indentation UI.** v1 indexes and lists checklist lines flat; visual nesting is a future enhancement, not required for aggregation to be useful.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Duplicate identical checkbox text in one file | Low | `toggleChecklistLine` returns `"ambiguous"` and refuses to write — surfaced to the user as "can't tell which one, edit the text to make it unique" rather than guessing |
| Toggle races a Syncthing pull mid-write | Low | `updateChecklistItem` reads fresh inside the same `serialize()` call it writes from — never from a stale cached copy. A genuine cross-device race still resolves to a `*.sync-conflict-*.md` file, matching the already-accepted model; no new guarantee is claimed |
| AsyncStorage blob growth | Low | Checklist text is bytes already being read for the excerpt; cap stored line length (proposed 300 chars — see Open decisions) so one unformatted line can't blow up the shared ~6 MB ceiling `v0.5-browse-search.prd.md` already flagged for this same blob |
| Stale index shows a todo that was since edited/deleted in Obsidian | Low | Same staleness class Search/TagBrowser already have; toggle's `"not_found"` result plus pull-to-refresh is the existing recovery pattern, not a new one |

## Open decisions

- **Max stored/matched checklist-line text length.** Proposed: 300 characters (longer than `EXCERPT_MAX = 200` since a todo's full text is the point, unlike an excerpt) — confirm at plan time.
- **Nested checklist items** (`  - [ ]` under a parent bullet): index as independent flat rows (recommended for v1), or exclude entirely. Decide before Task 1 so `extractChecklistLines`'s regex and its tests agree.

## Companion plan

`.claude/PRPs/plans/notes-todo-capture.plan.md` — file-level task breakdown, patterns to mirror, and validation commands for this phase.
