/**
 * Vault note + tag index for carnet.
 *
 * The primary artifact is a NOTE INDEX (one metadata row per markdown note),
 * built by scanning every note once (listNoteFiles + readNote) and cached to a
 * single AsyncStorage blob. The tag index (tag → carrying notes) is DERIVED
 * from it — one scan, one blob — so the tag browser, capture autocomplete, and
 * the search screen all share the same cache rather than each paying a separate
 * full-vault scan. Recents (AsyncStorage, max 20) is a capture history, not a
 * vault scan, so it cannot back any of these — they need a real file
 * enumeration, which is what this does.
 *
 * The scan is potentially slow on a large vault (one read per note), so it is
 * bounded-concurrency and the result is cached to AsyncStorage. Callers should
 * read the cache for instant render and refresh lazily (on focus / pull), and
 * upsert incrementally after a capture (upsertNoteInIndex) so the common path
 * never rescans, not on every keystroke.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { deriveTitle } from "@carnet/shared";

import { extractChecklistLines, type ChecklistLine } from "./checklist";
import {
  extractFrontmatterField,
  getFrontmatterTags,
  normalizeTag,
  stripFrontmatter,
} from "./frontmatter";
import { listNoteFiles, readNote, type NoteFileRef, type NoteSubdir } from "./writer";
import type { CaptureEntry, CaptureMode } from "./storage";

/** One AsyncStorage blob holding per-note metadata for browse + search; the tag
 * index is derived from it (deriveTagIndex). One scan, one blob keeps the
 * shared ~6 MB AsyncStorage ceiling from being split across two vault-sized
 * caches. */
const NOTE_INDEX_KEY = "carnet:noteindex:v1";

/** Max characters kept per note excerpt — capped to bound blob growth against
 * the shared AsyncStorage ceiling (see NOTE_INDEX_KEY). */
const EXCERPT_MAX = 200;

/** Max concurrent note reads during a scan — keeps SAF/IPC pressure bounded. */
const SCAN_CONCURRENCY = 8;

export interface TagIndexEntry {
  /** Normalized tag (see normalizeTag). */
  tag: string;
  /** Number of distinct notes carrying the tag. */
  count: number;
  /** URIs of the notes carrying the tag. */
  files: string[];
}

export interface TagIndex {
  /** Epoch ms the index was built — lets callers show staleness / decide refresh. */
  builtAt: number;
  /** Entries sorted by count desc, then tag asc. */
  tags: TagIndexEntry[];
}

/** One metadata row per markdown note — everything browse + search needs
 * without re-reading the file body. Bodies are NOT stored (only a capped
 * excerpt) to keep the blob small against the shared AsyncStorage ceiling. */
export interface NoteIndexEntry {
  /** Full readable URI (file:// or SAF content:// document URI). */
  uri: string;
  /** The note subdir it lives in (Ideas / Journal / People). */
  subdir: NoteSubdir;
  /** H1 title, else the filename (see synthesizeEntry's title rule). */
  title: string;
  /** `created:`/`date:` frontmatter parsed to epoch ms, else 0. */
  createdOrDate: number;
  /** Distinct normalized tags carried by the note. */
  tags: string[];
  /** Capture mode inferred from the subdir. */
  mode: CaptureMode;
  /** First ~200 chars of the stripped body (EXCERPT_MAX), whitespace-collapsed. */
  excerpt: string;
  /** Frontmatter `status` when present (e.g. "pending-enrich" on a save-first
   * raw note awaiting enrichment) — drives the per-note sync badge. Optional
   * so cached v1 blobs without it stay valid; absent means no badge. */
  status?: string;
  /** Checklist lines (`- [ ]` / `- [x]`) found in the body. Optional so
   * cached v1 blobs without it stay valid — absent means "not yet
   * re-indexed", not "no todos"; treat as [] when reading. */
  todos?: ChecklistLine[];
}

export interface NoteIndex {
  /** Epoch ms the index was built — lets callers show staleness / decide refresh. */
  builtAt: number;
  /** One entry per readable note, in vault enumeration order. */
  notes: NoteIndexEntry[];
}

/** Run `fn` over `items` with at most `limit` in flight at once. When `signal`
 * aborts, no NEW items are started (already-issued `fn` calls are allowed to
 * finish — there's no read-cancel primitive for file:// or SAF). */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/** Map a capture mode back to the note subdir it lives in — used when only a
 * URI + markdown are known (incremental upsert) rather than a NoteFileRef. */
function subdirForMode(mode: CaptureMode): NoteSubdir {
  if (mode === "journal") return "Journal";
  if (mode === "person") return "People";
  return "Ideas";
}

/** First ~EXCERPT_MAX chars of the stripped body, with a leading H1 dropped
 * (it duplicates the title), image/file embed syntax removed (a note that
 * STARTS with a photo otherwise shows raw `![](../Photos/…)` markdown as its
 * card excerpt), and whitespace collapsed to single spaces. */
function makeExcerpt(markdown: string): string {
  const body = stripFrontmatter(markdown)
    .replace(/^\s*#\s+.*(?:\n|$)/, "")
    // Image embeds (`![alt](target)`) vanish; plain links keep their label.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return body.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX);
}

/** Build a note index row from a note's ref + markdown. */
function buildNoteEntry(uri: string, subdir: NoteSubdir, markdown: string): NoteIndexEntry {
  const status = extractFrontmatterField(markdown, "status");
  const todos = extractChecklistLines(markdown);
  return {
    uri,
    subdir,
    // Derive from the frontmatter-stripped body: deriveTitle falls back to
    // the first line when there's no H1, and on a raw (save-first) note the
    // full file's first line is the literal "---" delimiter.
    title: deriveTitle(stripFrontmatter(markdown)) || basenameTitle(uri),
    createdOrDate: frontmatterDateMs(markdown) ?? 0,
    tags: tagsForNote(markdown),
    mode: inferNoteMode(uri),
    excerpt: makeExcerpt(markdown),
    ...(status ? { status } : {}),
    ...(todos.length ? { todos } : {}),
  };
}

/**
 * Scan the vault and build the note index fresh (no cache read/write). Notes
 * that fail to read (deleted mid-scan, SAF permission revoked) are skipped.
 * Entries preserve vault enumeration order.
 */
export async function buildNoteIndex(): Promise<NoteIndex> {
  const files = await listNoteFiles();
  const slots: (NoteIndexEntry | null)[] = new Array(files.length).fill(null);
  let skipped = 0;

  await mapWithConcurrency(
    files.map((file, i) => ({ file, i })),
    SCAN_CONCURRENCY,
    async ({ file, i }: { file: NoteFileRef; i: number }) => {
      let markdown: string;
      try {
        markdown = await readNote(file.uri);
      } catch {
        skipped += 1; // unreadable (deleted mid-scan / perm revoked) — skip, don't fail
        return;
      }
      slots[i] = buildNoteEntry(file.uri, file.subdir, markdown);
    },
  );

  if (skipped > 0) {
    console.warn(`[vault] note index skipped ${skipped}/${files.length} unreadable note(s)`);
  }

  return {
    builtAt: Date.now(),
    notes: slots.filter((n): n is NoteIndexEntry => n !== null),
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

/** Derive the tag index (tag → carrying notes, count-sorted) from a note index.
 * Tags are already normalized on each note; a tag is counted once per note. */
function deriveTagIndex(index: NoteIndex): TagIndex {
  const tagToFiles = new Map<string, Set<string>>();
  for (const note of index.notes) {
    for (const tag of note.tags) {
      let set = tagToFiles.get(tag);
      if (!set) {
        set = new Set<string>();
        tagToFiles.set(tag, set);
      }
      set.add(note.uri);
    }
  }
  const tags: TagIndexEntry[] = [...tagToFiles.entries()]
    .map(([tag, set]) => ({ tag, count: set.size, files: [...set] }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { builtAt: index.builtAt, tags };
}

// ── Note index cache lifecycle ────────────────────────────────────────────────

/** Read the cached note index, or null when absent / corrupt. */
export async function loadCachedNoteIndex(): Promise<NoteIndex | null> {
  const raw = await AsyncStorage.getItem(NOTE_INDEX_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NoteIndex;
    if (parsed && typeof parsed.builtAt === "number" && Array.isArray(parsed.notes)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the note index fresh and persist it to the cache. */
export async function refreshNoteIndex(): Promise<NoteIndex> {
  const index = await buildNoteIndex();
  await AsyncStorage.setItem(NOTE_INDEX_KEY, JSON.stringify(index));
  return index;
}

/**
 * Drop the cached note index so the next read rebuilds from the vault. Call
 * (fire-and-forget) after a write that changes note metadata but where an
 * incremental upsert isn't available (offline drain, in-place tag edit). The
 * common capture path should prefer upsertNoteInIndex to avoid a full rescan.
 */
export async function invalidateNoteIndex(): Promise<void> {
  await AsyncStorage.removeItem(NOTE_INDEX_KEY);
}

/**
 * Return the cached note index immediately when present, else build + persist
 * one. Hold the result in memory for the session; refresh lazily via pull.
 */
export async function getNoteIndex(): Promise<NoteIndex> {
  const cached = await loadCachedNoteIndex();
  if (cached) return cached;
  return refreshNoteIndex();
}

/**
 * Incrementally add/replace a single note's row in the cached index — the
 * common capture path, where the URI + content just written are already known,
 * so no full vault rescan is needed. No-op when there is no cached index yet
 * (the next getNoteIndex builds it fresh, which would include this note anyway).
 */
export async function upsertNoteInIndex(uri: string, markdown: string): Promise<void> {
  const cached = await loadCachedNoteIndex();
  if (!cached) return;
  const entry = buildNoteEntry(uri, subdirForMode(inferNoteMode(uri)), markdown);
  const idx = cached.notes.findIndex((n) => n.uri === uri);
  const notes =
    idx === -1
      ? [...cached.notes, entry]
      : cached.notes.map((n, i) => (i === idx ? entry : n));
  await AsyncStorage.setItem(NOTE_INDEX_KEY, JSON.stringify({ builtAt: cached.builtAt, notes }));
}

// ── Tag index (derived from the note index) ───────────────────────────────────

/**
 * Build the tag index fresh (no cache read/write) by scanning the vault into a
 * note index and deriving tags from it. Notes that fail to read or carry no
 * tags contribute nothing; tags are normalized, counted once per note.
 */
export async function buildTagIndex(): Promise<TagIndex> {
  return deriveTagIndex(await buildNoteIndex());
}

/** Read the cached tag index (derived from the cached note index), or null. */
export async function loadCachedTagIndex(): Promise<TagIndex | null> {
  const cached = await loadCachedNoteIndex();
  return cached ? deriveTagIndex(cached) : null;
}

/** Rebuild + persist the note index, returning the derived tag index. */
export async function refreshTagIndex(): Promise<TagIndex> {
  return deriveTagIndex(await refreshNoteIndex());
}

/**
 * Drop the cached index so the next read rebuilds. Kept as the tag-index name
 * for existing call sites; delegates to invalidateNoteIndex since the tag index
 * is now derived from the single note-index blob.
 */
export async function invalidateTagIndex(): Promise<void> {
  await invalidateNoteIndex();
}

/**
 * Return the tag index derived from the cached note index (built on a cold
 * miss). For stale-while-revalidate, render this and fire refreshTagIndex() in
 * the background.
 */
export async function getTagIndex(): Promise<TagIndex> {
  return deriveTagIndex(await getNoteIndex());
}

/** Just the distinct normalized tags carried by a note's markdown. */
export function tagsForNote(markdown: string): string[] {
  const seen = new Set<string>();
  for (const raw of getFrontmatterTags(markdown)) {
    const tag = normalizeTag(raw);
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/**
 * Autocomplete suggestions for a partial tag query against an index: exact
 * prefix matches first (alpha), then substring matches, capped at `limit`. An
 * empty query returns the most-used tags (index is already count-sorted).
 */
export function suggestTags(index: TagIndex, query: string, limit = 8): string[] {
  const all = index.tags.map((entry) => entry.tag);
  const q = normalizeTag(query);
  if (!q) return all.slice(0, limit);
  const prefix = all.filter((tag) => tag.startsWith(q));
  const substring = all.filter((tag) => !tag.startsWith(q) && tag.includes(q));
  return [...prefix, ...substring].slice(0, limit);
}

// ── Tag browser: notes for a tag ──────────────────────────────────────────────

/** Decoded basename of a note URI with the `.md` extension stripped. */
function basenameTitle(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* keep raw */
  }
  const last = decoded.split("/").pop() ?? decoded;
  return last.replace(/\.md$/i, "");
}

/** Infer the capture mode from the note's IMMEDIATE parent subdir. We match the
 * parent segment (not a substring anywhere in the path) so a vault rooted under
 * a folder literally named "Journal"/"People" doesn't misclassify its Ideas. */
export function inferNoteMode(uri: string): CaptureMode {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    /* keep raw */
  }
  const segments = decoded.split("/").filter(Boolean);
  const parent = segments[segments.length - 2];
  if (parent === "Journal") return "journal";
  if (parent === "People") return "person";
  return "idea";
}

/** Parse a `created:`/`date:` frontmatter value to epoch ms, or null. */
function frontmatterDateMs(markdown: string): number | null {
  const raw =
    extractFrontmatterField(markdown, "created") ?? extractFrontmatterField(markdown, "date");
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Build a minimal CaptureEntry for a vault-scanned note that may not be in the
 * 20-item Recents history. Mode comes from the subdir, title from the H1 (else
 * the filename), createdAt from the frontmatter date (else 0). The id is
 * filepath-derived and deliberately NOT a recents id — RecentDetail's history
 * mutations (remove/updateTitle) no-op on unknown ids, so opening or deleting a
 * browsed note never corrupts the recents list.
 */
export function synthesizeEntry(uri: string, markdown: string): CaptureEntry {
  return {
    id: `vault:${uri}`,
    mode: inferNoteMode(uri),
    title: deriveTitle(markdown) || basenameTitle(uri),
    filepath: uri,
    createdAt: frontmatterDateMs(markdown) ?? 0,
  };
}

/**
 * Resolve the notes carrying `tag` into CaptureEntry rows (newest first), ready
 * to hand to RecentDetail. Reads each note (bounded concurrency); unreadable
 * notes are skipped.
 */
export async function notesForTag(index: TagIndex, tag: string): Promise<CaptureEntry[]> {
  const entry = index.tags.find((t) => t.tag === normalizeTag(tag));
  if (!entry) return [];
  const out: CaptureEntry[] = [];
  await mapWithConcurrency(entry.files, SCAN_CONCURRENCY, async (uri) => {
    let markdown: string;
    try {
      markdown = await readNote(uri);
    } catch {
      return;
    }
    out.push(synthesizeEntry(uri, markdown));
  });
  out.sort((a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title));
  return out;
}

// ── Search over the note index ────────────────────────────────────────────────

/** Optional facet filters for a search — narrow to a capture mode or subdir. */
export interface NoteSearchFilters {
  mode?: CaptureMode;
  subdir?: NoteSubdir;
}

/**
 * Rank a note against a lowercased query. Lower is better; null = no match.
 * Field precedence title → tags → excerpt, prefix ahead of substring within a
 * field, matching the tag-suggestion precedent (suggestTags).
 */
function noteMatchTier(entry: NoteIndexEntry, q: string): number | null {
  const title = entry.title.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.includes(q)) return 1;
  if (entry.tags.some((tag) => tag.startsWith(q))) return 2;
  if (entry.tags.some((tag) => tag.includes(q))) return 3;
  if (entry.excerpt.toLowerCase().includes(q)) return 4;
  return null;
}

/**
 * Search the note index. Results are ranked prefix-then-substring over title,
 * then tags, then excerpt, newest-first on ties (then title asc). An empty
 * query returns every note passing the filters, newest-first — i.e. a browse
 * view. Filters (mode / subdir) are applied before ranking.
 */
export function searchNotes(
  index: NoteIndex,
  query: string,
  filters: NoteSearchFilters = {},
): NoteIndexEntry[] {
  const pool = index.notes.filter(
    (n) =>
      (filters.mode === undefined || n.mode === filters.mode) &&
      (filters.subdir === undefined || n.subdir === filters.subdir),
  );
  const byRecency = (a: NoteIndexEntry, b: NoteIndexEntry): number =>
    b.createdOrDate - a.createdOrDate || a.title.localeCompare(b.title);

  const q = query.trim().toLowerCase();
  if (!q) return [...pool].sort(byRecency);

  const scored: Array<{ entry: NoteIndexEntry; tier: number }> = [];
  for (const entry of pool) {
    const tier = noteMatchTier(entry, q);
    if (tier !== null) scored.push({ entry, tier });
  }
  scored.sort((a, b) => a.tier - b.tier || byRecency(a.entry, b.entry));
  return scored.map((s) => s.entry);
}

/**
 * Read a single note and adapt it into a CaptureEntry for RecentDetail —
 * mirrors the per-note resolution notesForTag does, for a search result tap.
 * Returns null when the note became unreadable since it was indexed.
 */
export async function resolveNoteEntry(uri: string): Promise<CaptureEntry | null> {
  let markdown: string;
  try {
    markdown = await readNote(uri);
  } catch {
    return null;
  }
  return synthesizeEntry(uri, markdown);
}

// ── On-demand full-text body search (Phase 2) ─────────────────────────────────

/** ~40 chars of context on each side of the match, in the snippet shown to
 * the user — bounded regardless of the note's line structure (char-based,
 * not line-based). */
const SNIPPET_WINDOW = 40;

/** One body-search hit: the note URI and a short window of body text around
 * the first match, for display without opening the note. */
export interface BodyMatch {
  uri: string;
  snippet: string;
}

/** Nudge a slice boundary off a UTF-16 low-surrogate code unit so we never
 * split a surrogate pair (e.g. an emoji) mid-character. `direction` is which
 * way to nudge: -1 for a start boundary (move earlier), +1 for an end
 * boundary (move later). */
function clampToCodeUnitBoundary(s: string, i: number, direction: -1 | 1): number {
  if (i > 0 && i < s.length) {
    const code = s.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return i + direction;
  }
  return i;
}

/** Extract a snippet around the first case-insensitive match of `query` in
 * `strippedBody`, or null when there's no match. */
function extractSnippet(strippedBody: string, query: string): string | null {
  const idx = strippedBody.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = clampToCodeUnitBoundary(
    strippedBody,
    Math.max(0, idx - SNIPPET_WINDOW),
    -1,
  );
  const end = clampToCodeUnitBoundary(
    strippedBody,
    Math.min(strippedBody.length, idx + query.length + SNIPPET_WINDOW),
    1,
  );
  const prefix = start > 0 ? "…" : "";
  const suffix = end < strippedBody.length ? "…" : "";
  return prefix + strippedBody.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

/**
 * Stream on-demand body matches for `query` across every vault note — the
 * Phase 2 "Search note contents" escape hatch for a match Phase 1's indexed
 * title/tags/excerpt search misses (a hit deeper in the body than the
 * ~200-char excerpt window). Case-insensitive substring match against the
 * frontmatter-stripped body. `onMatch` fires immediately per hit (streaming,
 * not collected into an array) and `onProgress` fires after every note is
 * processed (match or not) so a caller can render a live "N of M" indicator.
 * Checks `signal.aborted` before starting each note's read — already-issued
 * reads are allowed to finish, but no new ones start after cancellation.
 * Unreadable notes (deleted mid-scan, permission revoked) are skipped,
 * matching `buildNoteIndex`'s behavior. Callers must guard against an empty
 * query — it trivially matches every note's body.
 */
export async function searchNoteBodies(
  query: string,
  onMatch: (match: BodyMatch) => void,
  onProgress: (progress: { scanned: number; total: number }) => void,
  signal: AbortSignal,
): Promise<{ scanned: number; total: number }> {
  const files = await listNoteFiles();
  const total = files.length;
  let scanned = 0;

  await mapWithConcurrency(
    files,
    SCAN_CONCURRENCY,
    async (file) => {
      let markdown: string | null = null;
      try {
        markdown = await readNote(file.uri);
      } catch {
        // unreadable — still counts as scanned, no match
      }
      scanned += 1;
      if (markdown !== null) {
        const snippet = extractSnippet(stripFrontmatter(markdown), query);
        if (snippet !== null) onMatch({ uri: file.uri, snippet });
      }
      onProgress({ scanned, total });
    },
    signal,
  );

  return { scanned, total };
}
