# Plan: Vault checklist aggregation — todo index + safe toggle write-back

Status: draft

## Summary
Users already write `- [ ] task` lines inside notes captured through Carnet's
existing surfaces (Ideas/Journal/People), the same way they would directly in
Obsidian. There is no aggregated view of those lines and no way to check one
off from Carnet. This plan extends the note-scan `vault.ts` already performs
to also extract checklist lines, adds a content-anchored (never
line-number-anchored) toggle write-back, and adds a `TodosScreen` that lists
them flat with a checked/unchecked filter.

## User Story
As someone who scatters `- [ ] ...` checkboxes across my Ideas/Journal/People
notes, I want to see every open item in one list from Carnet, and check one
off without any risk of corrupting a different line in that file.

## Problem → Solution
No aggregated todo view exists, and the obvious-looking implementation
("remember which line number a todo was on, write to it later") is unsafe:
Android/Syncthing `content://` files report no modification time
(`writer.ts:355-364`), so a file can be rewritten between when a line number
was cached and when Carnet writes to it → `[x]` lands on unrelated text. →
Extend the existing note index with checklist lines (no new IO — it rides the
scan that already reads every note's full markdown), and write back by
re-reading the file fresh and matching the target line by its own text,
refusing on zero or multiple matches instead of guessing.

## Metadata
- **Complexity**: Small–Medium
- **Estimated Files**: 10 (2 new modules + 2 new tests, 4 modified modules +
  their tests, 2 nav-wiring edits)
- **Spec**: `.claude/PRPs/prds/notes-todo-capture.prd.md`

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/lib/vault.ts` | 60-185 | `NoteIndexEntry`, `buildNoteEntry`, `buildNoteIndex` — the single build point `todos` plugs into |
| P0 | `apps/mobile/src/lib/vault.ts` | 251-267 | `upsertNoteInIndex` — confirms incremental upsert calls `buildNoteEntry` too, so `todos` needs no separate wiring there |
| P0 | `apps/mobile/src/lib/writer.ts` | 142-155, 187-228 | `serialize()` and its use in `appendJournal` — the per-filepath lock `updateChecklistItem` reuses |
| P0 | `apps/mobile/src/lib/writer.ts` | 96-105, 332-340 | `readByUri`/`writeByUri` (private) and `updateNote` — the primitives `updateChecklistItem` composes |
| P1 | `apps/mobile/src/lib/writer.ts` | 342-423 | `getModificationTime` / `updateNoteIfUnchanged` — read for context; NOT reused (see Task 2 GOTCHA for why) |
| P1 | `apps/mobile/src/screens/SearchScreen.tsx` | 50-178, 304-463 | The cache-first-index + pull-to-refresh + `FlatList` shape `TodosScreen` mirrors |
| P1 | `apps/mobile/App.tsx` | 57-68 | `RootStackParamList` — add the `Todos` route here |
| P1 | `apps/mobile/src/screens/HomeScreen.tsx` | 226-244 | Header `IconButton` pattern for the new nav entry point |
| P2 | `apps/mobile/src/components/NoteCard.tsx` | 1-2, 105 | Confirms `Checkbox.Android` (react-native-paper) is already in use — no new dependency |
| P2 | `.claude/PRPs/prds/capture-timing.decision.md` | whole | Why "more sync-conflict files" is the accepted cost model — do not re-litigate it in this plan |

---

## Patterns to Mirror

### STATUS_OPTIONAL_FIELD  ← precedent for adding `todos?` without a cache-version bump
```ts
// SOURCE: apps/mobile/src/lib/vault.ts:78-81
/** Frontmatter `status` when present (e.g. "pending-enrich" on a save-first
 * raw note awaiting enrichment) — drives the per-note sync badge. Optional
 * so cached v1 blobs without it stay valid; absent means no badge. */
status?: string;
```

### SERIALIZE_PER_PATH  ← the concurrency lock `updateChecklistItem` reuses
```ts
// SOURCE: apps/mobile/src/lib/writer.ts:146-155, used at :199-227
async function serialize<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeChain.get(filepath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _writeChain.set(filepath, next);
  try {
    return (await next) as T;
  } finally {
    if (_writeChain.get(filepath) === next) _writeChain.delete(filepath);
  }
}
```

### CACHE_FIRST_SCREEN  ← the load/refresh shape `TodosScreen` mirrors
```ts
// SOURCE: apps/mobile/src/screens/SearchScreen.tsx:150-163
useFocusEffect(
  useCallback(() => {
    let active = true;
    setLoading(true);
    void getNoteIndex()
      .then((next) => (active ? setIndex(next) : undefined))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []),
);
```

### HEADER_ICON  ← the nav entry point pattern
```tsx
// SOURCE: apps/mobile/src/screens/HomeScreen.tsx:233-238
<IconButton
  icon="magnify"
  onPress={() => navigation.navigate("Search")}
  accessibilityLabel="Search notes"
/>
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/checklist.ts` | CREATE | Pure extraction + content-anchored toggle transform |
| `apps/mobile/src/lib/checklist.test.ts` | CREATE | Extraction + toggle (found/not_found/ambiguous) coverage |
| `apps/mobile/src/lib/writer.ts` | UPDATE | Add `updateChecklistItem` (serialize + read + pure toggle + write) |
| `apps/mobile/src/lib/writer.test.ts` | UPDATE | Success/not_found/ambiguous/concurrency coverage |
| `apps/mobile/src/lib/vault.ts` | UPDATE | `NoteIndexEntry.todos?`, populate in `buildNoteEntry`, add `getAllTodos` |
| `apps/mobile/src/lib/vault.test.ts` | UPDATE | `todos` populated on build + incremental upsert; `getAllTodos` flattening |
| `apps/mobile/src/screens/TodosScreen.tsx` | CREATE | Aggregated checklist list, checked/unchecked filter, toggle wiring |
| `apps/mobile/src/screens/TodosScreen.test.tsx` | CREATE | Smoke test mirroring the `TagBrowserScreen.test.tsx` pattern |
| `apps/mobile/App.tsx` | UPDATE | `Todos: undefined` in `RootStackParamList` + `Stack.Screen` |
| `apps/mobile/src/screens/HomeScreen.tsx` | UPDATE | Header `IconButton` → `navigation.navigate("Todos")` |

## NOT Building
- **No `Todo.md` file, no root-level vault writes, no new append primitive.** Todos are indexed from wherever the user already wrote them (Ideas/Journal/People) — see PRD Non-goals.
- **No new capture surface.** Widget/notification/share-sheet/FAB/voice are untouched.
- **No note-vs-todo auto-classification.** A checkbox is just a checkbox in whatever note the user already captures.
- **No nested/sub-item indentation UI.** Flat list only in v1; `extractChecklistLines` may still detect indented lines (see Task 1 open decision) but the screen renders them flat.
- **No new sync-conflict machinery.** Reuses the existing Home banner / `syncConflicts.ts` model as-is.
- **No cache-key bump on `NOTE_INDEX_KEY`.** `todos` is optional, mirroring `status?`.

---

## Step-by-Step Tasks

### Task 1: Pure checklist extraction + toggle transform
- **ACTION**: Create `apps/mobile/src/lib/checklist.ts` — no filesystem, no React Native imports, matching the purity of `frontmatter.ts`.
- **IMPLEMENT**:
```ts
import { stripFrontmatter } from "./frontmatter";

/** Cap on stored/matched checklist-line text — mirrors EXCERPT_MAX's role
 * of bounding the shared AsyncStorage note-index blob (vault.ts). */
export const CHECKLIST_TEXT_MAX = 300;

export interface ChecklistLine {
  text: string;
  checked: boolean;
}

const CHECKLIST_LINE_RE = /^[ \t]*-[ \t]+\[([ xX])\][ \t]+(.+)$/gm;

/** Extract every `- [ ]` / `- [x]` line from a note's body (frontmatter
 * stripped first — frontmatter is YAML, never checklist syntax, but this
 * keeps the regex from ever seeing it). Nested/indented items are matched
 * too (leading whitespace is tolerated) and returned as independent flat
 * rows — v1 does not model parent/child structure. Text is trimmed and
 * capped at CHECKLIST_TEXT_MAX so one unformatted line can't blow up the
 * shared note-index blob. */
export function extractChecklistLines(markdown: string): ChecklistLine[] {
  const body = stripFrontmatter(markdown);
  const out: ChecklistLine[] = [];
  for (const match of body.matchAll(CHECKLIST_LINE_RE)) {
    const checked = match[1].toLowerCase() === "x";
    const text = match[2].trim().slice(0, CHECKLIST_TEXT_MAX);
    if (text) out.push({ text, checked });
  }
  return out;
}

export type ChecklistToggleResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: "not_found" | "ambiguous" };

/** Re-scan `markdown` (handed in fresh by the caller — this function never
 * reads a cache) for a checklist line whose trimmed text equals `text` AND
 * whose current checked-state equals `expectedChecked`. Flips it ONLY when
 * there is exactly one such line; a stale caller (the matched text changed
 * or was removed) gets "not_found", and two identical lines get "ambiguous"
 * rather than a guess at which one the user meant. This is the anchor: the
 * line's own text at write time, never a remembered position. */
export function toggleChecklistLine(
  markdown: string,
  text: string,
  expectedChecked: boolean,
): ChecklistToggleResult {
  const target = text.trim().slice(0, CHECKLIST_TEXT_MAX);
  const lines = markdown.split("\n");
  const matchIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*-[ \t]+\[)([ xX])(\][ \t]+)(.+)$/.exec(lines[i]);
    if (!m) continue;
    const checked = m[2].toLowerCase() === "x";
    const lineText = m[4].trim().slice(0, CHECKLIST_TEXT_MAX);
    if (lineText === target && checked === expectedChecked) matchIndexes.push(i);
  }
  if (matchIndexes.length === 0) return { ok: false, reason: "not_found" };
  if (matchIndexes.length > 1) return { ok: false, reason: "ambiguous" };

  const i = matchIndexes[0];
  const m = /^([ \t]*-[ \t]+\[)([ xX])(\][ \t]+)(.+)$/.exec(lines[i])!;
  const nextMark = expectedChecked ? " " : "x";
  const nextLines = [...lines];
  nextLines[i] = `${m[1]}${nextMark}${m[3]}${m[4]}`;
  return { ok: true, markdown: nextLines.join("\n") };
}
```
- **MIRROR**: purity/style of `frontmatter.ts`'s exported helpers.
- **GOTCHA**: `extractChecklistLines` and `toggleChecklistLine` use two
  *separate* regexes deliberately — the extractor uses a global `matchAll`,
  the toggle walks lines one at a time so it can report back the exact index
  to flip. Keep both regexes' checkbox-syntax shape (`- [ ] ` / `- [x] `,
  case-insensitive x, tolerant of leading whitespace) in sync if either
  changes — a test in Task 1 pins both against the same fixture strings so
  they can't silently drift apart.
- **VALIDATE**:
```bash
npm -w @carnet/mobile test -- checklist
```
Cases: unchecked/checked extraction, indented (nested) line extraction,
frontmatter containing something checkbox-shaped is never matched (only body
is scanned), toggle success flips exactly the target line and leaves others
untouched, toggle on a stale/removed line → `not_found`, toggle against two
identical lines → `ambiguous`, `- [X]` (capital) treated as checked on both
extract and toggle.

### Task 2: `updateChecklistItem` in `writer.ts`
- **ACTION**: Add one new exported function, composing existing private
  primitives.
- **IMPLEMENT**:
```ts
import { toggleChecklistLine } from "./checklist";

export interface ChecklistUpdateResult {
  ok: boolean;
  reason?: "not_found" | "ambiguous";
}

/**
 * Toggle one checklist line in a note by TEXT, not by position. Always reads
 * the file fresh (inside the same serialized call it writes from) and hands
 * that exact content to the pure toggleChecklistLine — the read IS the
 * write's baseline, so there is no separate staleness guard to maintain.
 * Serialized per-filepath so two toggles racing on the same file (or a
 * toggle racing an offline-drain write) don't interleave.
 */
export async function updateChecklistItem(
  filepath: string,
  text: string,
  expectedChecked: boolean,
): Promise<ChecklistUpdateResult> {
  return serialize(filepath, async () => {
    const current = await readByUri(filepath);
    const result = toggleChecklistLine(current, text, expectedChecked);
    if (!result.ok) return { ok: false, reason: result.reason };
    await writeByUri(filepath, result.markdown);
    return { ok: true };
  });
}
```
- **MIRROR**: SERIALIZE_PER_PATH.
- **GOTCHA**: Do NOT reuse `updateNoteIfUnchanged` here — that function
  guards against a baseline the CALLER recorded earlier (mtime or a content
  snapshot taken before other work happened). `updateChecklistItem` has no
  such gap: it reads inside the same serialized call it writes from, so the
  content it just read is definitionally current at write time. Adding the
  mtime/content-baseline machinery on top would be redundant complexity, not
  extra safety — the PRD's Non-goals calls this out.
- **VALIDATE**:
```bash
npm -w @carnet/mobile test -- writer
```
Cases: toggling an existing unchecked line rewrites the file with only that
line changed; toggling a since-edited/removed line returns `not_found` and
does NOT write; two identical lines return `ambiguous` and do NOT write; two
concurrent `updateChecklistItem` calls on the same filepath serialize (second
sees the first's write, per the existing `serialize()` contract already
proven by `appendJournal`'s tests).

### Task 3: Extend the note index (`vault.ts`)
- **ACTION**: Add `todos?: ChecklistLine[]` to `NoteIndexEntry`, populate it
  in `buildNoteEntry`, add `getAllTodos`.
- **IMPLEMENT**:
```ts
import { extractChecklistLines, type ChecklistLine } from "./checklist";

// In NoteIndexEntry (after `status?: string;`):
  /** Checklist lines (`- [ ]` / `- [x]`) found in the body. Optional so
   * cached v1 blobs without it stay valid — absent means "not yet
   * re-indexed", not "no todos"; treat as [] when reading. */
  todos?: ChecklistLine[];

// In buildNoteEntry, alongside the existing `status` line:
function buildNoteEntry(uri: string, subdir: NoteSubdir, markdown: string): NoteIndexEntry {
  const status = extractFrontmatterField(markdown, "status");
  const todos = extractChecklistLines(markdown);
  return {
    uri,
    subdir,
    title: deriveTitle(stripFrontmatter(markdown)) || basenameTitle(uri),
    createdOrDate: frontmatterDateMs(markdown) ?? 0,
    tags: tagsForNote(markdown),
    mode: inferNoteMode(uri),
    excerpt: makeExcerpt(markdown),
    ...(status ? { status } : {}),
    ...(todos.length ? { todos } : {}),
  };
}

export interface AggregatedTodo extends ChecklistLine {
  uri: string;
  noteTitle: string;
  subdir: NoteSubdir;
  mode: CaptureMode;
  createdOrDate: number;
}

/** Flatten every note's checklist lines into one list, newest-note-first
 * (ties by note title) — the source TodosScreen renders. */
export function getAllTodos(index: NoteIndex): AggregatedTodo[] {
  const out: AggregatedTodo[] = [];
  for (const note of index.notes) {
    for (const line of note.todos ?? []) {
      out.push({
        ...line,
        uri: note.uri,
        noteTitle: note.title,
        subdir: note.subdir,
        mode: note.mode,
        createdOrDate: note.createdOrDate,
      });
    }
  }
  return out.sort(
    (a, b) => b.createdOrDate - a.createdOrDate || a.noteTitle.localeCompare(b.noteTitle),
  );
}
```
- **MIRROR**: STATUS_OPTIONAL_FIELD.
- **GOTCHA**: `upsertNoteInIndex` (vault.ts:257) already calls
  `buildNoteEntry` for its single-note incremental update — verify with a
  test rather than adding a second call site; do not duplicate the
  `extractChecklistLines` call there.
- **VALIDATE**:
```bash
npm run build:shared && npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile test -- vault
```
Cases: a note with checklist lines produces `todos` on `buildNoteEntry`; a
note with none produces no `todos` key at all (not an empty array — matches
the `status` precedent of omitting absent optional fields); `upsertNoteInIndex`
against a note whose body changed reflects new `todos` without a full
rescan; `getAllTodos` flattens multiple notes' todos in the documented sort
order; a cached index loaded from a pre-`todos` blob (no `todos` key on any
entry) doesn't throw — `getAllTodos` treats `undefined` as `[]`.

### Task 4: `TodosScreen`
- **ACTION**: Create `apps/mobile/src/screens/TodosScreen.tsx`, mirroring
  `SearchScreen.tsx`'s index-load/refresh shape.
- **IMPLEMENT**: A `FlatList` over `getAllTodos(index)`, filtered by a
  `SegmentedButtons` with values `"open" | "all"` (default `"open"` —
  unchecked-first is the useful default; "all" also shows checked items).
  Each row renders `Checkbox.Android` + the todo text + a small subtitle
  (`noteTitle`, tappable → `resolveNoteEntry(uri)` → `RecentDetail`, mirroring
  `SearchScreen`'s `openNote`). Tapping the checkbox:
```ts
const onToggle = useCallback(
  async (todo: AggregatedTodo) => {
    // Optimistic: flip immediately, revert on failure.
    setIndex((prev) => prev && flipInIndex(prev, todo));
    const result = await updateChecklistItem(todo.uri, todo.text, todo.checked);
    if (!result.ok) {
      setIndex((prev) => prev && flipInIndex(prev, todo)); // revert
      setToggleError(
        result.reason === "ambiguous"
          ? "Can't tell which item — edit the text in the note to make it unique."
          : "That item changed — pull to refresh and try again.",
      );
      return;
    }
    // Keep the cache in sync without a full rescan.
    await upsertNoteInIndex(todo.uri, await readNote(todo.uri));
  },
  [],
);
```
  (`flipInIndex` is a small local helper that returns a new `NoteIndex` with
  the one matching `(uri, text, checked)` row's `checked` flipped — write it
  immutably, per this repo's coding-style: never mutate `prev` in place.)
- **MIRROR**: CACHE_FIRST_SCREEN, HEADER_ICON's `IconButton` usage for any
  in-screen icon needs, `Checkbox.Android` from `NoteCard.tsx:105`,
  `SegmentedButtons` from `SettingsScreen.tsx:283`.
- **GOTCHA**: `todo.checked` at toggle time is the OPTIMISTIC pre-flip value
  captured in the closure over the *original* `AggregatedTodo`, which is what
  `updateChecklistItem`'s `expectedChecked` must receive — it needs to match
  what's still on disk, not what the UI already flipped to. Do not read
  `expectedChecked` from state after the optimistic update.
- **VALIDATE**:
```bash
npm -w @carnet/mobile test -- TodosScreen
```
Smoke test mirroring `TagBrowserScreen.test.tsx`'s pattern (jsdom +
`@testing-library/react`, rendered under `PaperProvider`): renders todos from
a seeded index, toggling a checkbox calls `updateChecklistItem` with the
correct `(uri, text, expectedChecked)`, an `"ambiguous"`/`"not_found"` result
reverts the optimistic flip and shows the Snackbar text, the "open"/"all"
filter changes what's rendered.

### Task 5: Nav wiring
- **ACTION**: Add the `Todos` route and a header entry point.
- **IMPLEMENT**: In `App.tsx`, extend `RootStackParamList`:
```ts
export type RootStackParamList = {
  Home: undefined;
  Capture: { mode: CaptureMode };
  Settings: undefined;
  ShareReceive: undefined;
  PhotoCapture: undefined;
  AudioCapture: undefined;
  RecentDetail: { entry: CaptureEntry };
  TagBrowser: { tag?: string } | undefined;
  Search: { tag?: string } | undefined;
  Todos: undefined;
};
```
  and add `<Stack.Screen name="Todos" component={TodosScreen} options={{ title: "Todos" }} />`
  alongside the existing `TagBrowser` screen registration. In
  `HomeScreen.tsx`'s `headerRight`, add one more `IconButton` (icon
  `"checkbox-marked-outline"` or similar from the already-bundled
  MaterialCommunityIcons set) calling `navigation.navigate("Todos")`, next to
  the existing Search/Settings icons.
- **MIRROR**: HEADER_ICON.
- **GOTCHA**: `Todos` is intentionally NOT added to the `linking.config.screens`
  deep-link map (App.tsx:88-100) — same reasoning `RecentDetail` is
  deliberately excluded: no external deep-link use case yet, and the
  App.tsx comment block above `linking` documents the passive-route security
  model new routes must follow if that ever changes.
- **VALIDATE**:
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile test
```
Manual: tapping the new header icon from Home opens Todos; back navigation
returns to Home.

---

## Testing Strategy

| Test | Input | Expected | Edge? |
|---|---|---|---|
| extract unchecked/checked | `- [ ] a`, `- [x] b` | 2 lines, checked flags correct | no |
| extract capital X | `- [X] a` | checked: true | yes |
| extract indented | `  - [ ] a` under a parent bullet | still extracted as a flat row | yes |
| extract ignores frontmatter | checkbox-shaped text inside `---` block | not matched | yes |
| toggle success | matching unchecked line | exactly that line flips, others untouched | no |
| toggle not_found | text no longer present | `{ ok: false, reason: "not_found" }`, no write | yes |
| toggle ambiguous | two identical unchecked lines | `{ ok: false, reason: "ambiguous" }`, no write | yes |
| updateChecklistItem serializes | two concurrent calls, same filepath | second sees first's write | yes |
| buildNoteEntry omits todos key | note with no checkboxes | no `todos` field present | yes |
| upsertNoteInIndex refreshes todos | body changed to add a checkbox | cached entry's `todos` reflects it, no rescan | no |
| getAllTodos sort | 3 notes, mixed dates | newest-note-first, title tiebreak | no |
| pre-todos cached blob | entries with no `todos` key | `getAllTodos` treats as `[]`, no throw | yes |
| TodosScreen optimistic revert | toggle returns `ambiguous` | checkbox flips back, Snackbar shown | yes |

---

## Validation Commands
```bash
npm run build:shared && npm -w @carnet/mobile run typecheck   # zero errors
npm -w @carnet/mobile test -- checklist writer vault TodosScreen
npm -w @carnet/mobile test                                     # no regressions
npm -w @carnet/mobile run lint                                 # clean
npm -w @carnet/mobile run verify:capture-flow                  # unaffected, must stay green
```

### Manual Validation
- [ ] A note with `- [ ] buy milk` shows up in Todos after a pull-to-refresh
- [ ] Checking it in Carnet writes `- [x] buy milk` to the exact file, and
      only that line changes (diff the file before/after)
- [ ] The same edit is visible on the Obsidian desktop side after Syncthing
      sync
- [ ] Checking an item that was already edited on the workstation
      (text changed) surfaces the "pull to refresh" message, does not
      silently write
- [ ] Two identical `- [ ] call back` lines in one note both refuse to toggle
      until the text is made unique

---

## Acceptance Criteria
- [ ] Every task complete, all validation commands pass
- [ ] No cached-line-number write path exists anywhere in the diff — every
      write-back re-reads and matches by text (grep the diff for this)
- [ ] `NOTE_INDEX_KEY` unchanged (`carnet:noteindex:v1`) — `todos` ships as
      an optional field, no migration
- [ ] No new capture surface, no `Todo.md`, no root-level vault write path
- [ ] No type errors, no lint errors, `verify:capture-flow` still green

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ambiguous/not_found UX feels like a dead end | Medium | User friction on duplicate text | Snackbar message tells them exactly what to do (edit the text); acceptable for v1, revisit if it's a common complaint |
| Checklist regex diverges between extract/toggle over time | Low | A line indexes but won't toggle, or vice versa | Task 1's test suite pins both against shared fixture strings |
| Large vaults with many checklist lines slow the Todos screen | Low | Same exposure Search already has (index-in-memory, no pagination) | `getAllTodos` is a pure in-memory flatten over an already-built index — no new scan cost; revisit only if a real vault shows jank |

## Notes
- This plan intentionally does NOT reintroduce any of the superseded draft's
  five "new" capture surfaces or the `Todo.md` file — see the PRD's Non-goals
  for the reasoning. If a future need for a dedicated todo *capture* surface
  (as opposed to this aggregation-and-toggle view) shows up, it should be
  scoped as its own follow-up plan against this one's `getAllTodos`/
  `updateChecklistItem` primitives, not folded back in here.
