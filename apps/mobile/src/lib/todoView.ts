import { normalizeTag } from "./frontmatter";
import type { CaptureMode } from "./storage";
import type { AggregatedTodo, NoteIndex } from "./vault";

export interface TodoViewPreferences {
  query: string;
  status: "open" | "completed" | "all";
  modes: CaptureMode[];
  tags: string[];
  sort: "newest" | "oldest" | "source";
  groupBySource: boolean;
}

const CAPTURE_MODES: CaptureMode[] = ["idea", "journal", "person", "photo", "audio", "note"];

export function defaultTodoViewPreferences(): TodoViewPreferences {
  return { query: "", status: "open", modes: [], tags: [], sort: "newest", groupBySource: false };
}

/** Validate each field separately so a damaged field doesn't discard valid choices. */
export function normalizeTodoViewPreferences(value: unknown): TodoViewPreferences {
  const defaults = defaultTodoViewPreferences();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const raw = value as Record<string, unknown>;
  return {
    query: typeof raw.query === "string" ? raw.query.slice(0, 512) : defaults.query,
    status: raw.status === "open" || raw.status === "completed" || raw.status === "all" ? raw.status : defaults.status,
    modes: Array.isArray(raw.modes)
      ? [...new Set(raw.modes.filter((mode): mode is CaptureMode => CAPTURE_MODES.includes(mode as CaptureMode)))]
      : defaults.modes,
    tags: Array.isArray(raw.tags)
      ? [...new Set(raw.tags.filter((tag): tag is string => typeof tag === "string").map(normalizeTag).filter(Boolean))]
      : defaults.tags,
    sort: raw.sort === "newest" || raw.sort === "oldest" || raw.sort === "source" ? raw.sort : defaults.sort,
    groupBySource: typeof raw.groupBySource === "boolean" ? raw.groupBySource : defaults.groupBySource,
  };
}

function compareSource(a: AggregatedTodo, b: AggregatedTodo): number {
  return a.noteTitle.localeCompare(b.noteTitle) || a.uri.localeCompare(b.uri) || a.ordinal - b.ordinal;
}

/** Filter indexed lines without touching the vault or changing their source ordinals. */
export function selectTodos(index: NoteIndex, view: TodoViewPreferences): AggregatedTodo[] {
  const query = view.query.trim().toLowerCase();
  const tags = new Set(view.tags.map(normalizeTag).filter(Boolean));
  const out: AggregatedTodo[] = [];
  for (const note of index.notes) {
    if (view.modes.length && !view.modes.includes(note.mode)) continue;
    if (tags.size && !note.tags.some((tag) => tags.has(normalizeTag(tag)))) continue;
    (note.todos ?? []).forEach((line, ordinal) => {
      if (view.status === "open" && line.checked) return;
      if (view.status === "completed" && !line.checked) return;
      if (query && !line.text.toLowerCase().includes(query) && !note.title.toLowerCase().includes(query)) return;
      out.push({ ...line, uri: note.uri, noteTitle: note.title, subdir: note.subdir, mode: note.mode, createdOrDate: note.createdOrDate, ordinal });
    });
  }
  return out.sort((a, b) => {
    const date = view.sort === "source" ? 0 : view.sort === "oldest"
      ? a.createdOrDate - b.createdOrDate : b.createdOrDate - a.createdOrDate;
    return date || compareSource(a, b);
  });
}

/** Options always describe the unfiltered tasks, including completed tasks. */
export function getTodoFilterOptions(index: NoteIndex): { modes: CaptureMode[]; tags: string[] } {
  const modes = new Set<CaptureMode>();
  const tags = new Set<string>();
  for (const note of index.notes) {
    if (!note.todos?.length) continue;
    modes.add(note.mode);
    note.tags.map(normalizeTag).filter(Boolean).forEach((tag) => tags.add(tag));
  }
  return { modes: [...modes].sort(), tags: [...tags].sort() };
}

export interface TodoSection {
  uri: string;
  title: string;
  data: AggregatedTodo[];
}

/** Source identity is its URI; equal titles still represent different notes. */
export function groupTodosBySource(todos: AggregatedTodo[]): TodoSection[] {
  const sections = new Map<string, TodoSection>();
  for (const todo of todos) {
    let section = sections.get(todo.uri);
    if (!section) {
      section = { uri: todo.uri, title: todo.noteTitle, data: [] };
      sections.set(todo.uri, section);
    }
    section.data.push(todo);
  }
  for (const section of sections.values()) section.data.sort((a, b) => a.ordinal - b.ordinal);
  return [...sections.values()];
}
