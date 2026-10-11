import { describe, expect, it } from "vitest";
import type { NoteIndex, NoteIndexEntry } from "./vault";
import { defaultTodoViewPreferences, getTodoFilterOptions, groupTodosBySource, normalizeTodoViewPreferences, selectTodos } from "./todoView";

function note(uri: string, patch: Partial<NoteIndexEntry> = {}): NoteIndexEntry {
  return { uri, title: "Source", subdir: "Notes", createdOrDate: 10, mode: "note", tags: [], excerpt: "", todos: [{ text: "first", checked: false }, { text: "second", checked: true }, { text: "third", checked: false }], ...patch };
}
const index = (...notes: NoteIndexEntry[]): NoteIndex => ({ builtAt: 0, notes });
const ids = (todos: ReturnType<typeof selectTodos>) => todos.map((todo) => `${todo.uri}:${todo.ordinal}`);

describe("todo discovery", () => {
  it("defaults to open tasks and keeps original ordinals, including duplicate text", () => {
    const source = note("a", { todos: [{ text: "same", checked: true }, { text: "same", checked: false }, { text: "same", checked: false }] });
    expect(ids(selectTodos(index(source), defaultTodoViewPreferences()))).toEqual(["a:1", "a:2"]);
  });

  it("searches task text or source title with trimmed case-insensitive substrings", () => {
    const sources = index(note("a", { title: "Trip planning" }), note("b", { todos: [{ text: "Plan trip", checked: false }] }));
    expect(ids(selectTodos(sources, { ...defaultTodoViewPreferences(), query: " TRIP " }))).toEqual(["b:0", "a:0", "a:2"]);
    expect(selectTodos(sources, { ...defaultTodoViewPreferences(), query: "absent" })).toEqual([]);
  });

  it("combines search, status, modes and normalized tags; alternatives are OR within a filter", () => {
    const sources = index(
      note("a", { title: "Travel", tags: ["#Work Stuff"], mode: "idea" }),
      note("b", { title: "Travel", tags: ["HOME"], mode: "journal" }),
      note("c", { title: "Travel", tags: ["work-stuff"], mode: "note" }),
      note("d", { title: "Travel", tags: ["other"], mode: "idea" }),
      note("e", { title: "Other", tags: ["home"], mode: "journal" }),
    );
    const view = { ...defaultTodoViewPreferences(), query: "travel", status: "completed" as const, modes: ["idea", "journal"] as const, tags: ["work stuff", "#HOME"] };
    expect(ids(selectTodos(sources, { ...view, modes: [...view.modes] }))).toEqual(["a:1", "b:1"]);
    expect(selectTodos(index(note("a")), { ...defaultTodoViewPreferences(), status: "all" })).toHaveLength(3);
  });

  it("offers all task-source modes and normalized tags, excluding notes without tasks", () => {
    const sources = index(note("a", { tags: ["#Work Stuff", "work-stuff", ""], mode: "journal" }), note("b", { tags: ["HOME"], mode: "idea", todos: [{ text: "done", checked: true }] }), note("c", { tags: ["hidden"], mode: "person", todos: [] }), note("d", { todos: undefined, tags: ["missing"] }));
    expect(getTodoFilterOptions(sources)).toEqual({ modes: ["idea", "journal"], tags: ["home", "work-stuff"] });
  });

  it("sorts by source date with title, URI and ordinal ties independent of index enumeration", () => {
    const notes = [note("b", { title: "Equal" }), note("a", { title: "Equal" }), note("z", { title: "Alpha", createdOrDate: 20 }), note("old", { title: "Zulu", createdOrDate: 0 })];
    const view = defaultTodoViewPreferences();
    const expected = ["z:0", "z:2", "a:0", "a:2", "b:0", "b:2", "old:0", "old:2"];
    expect(ids(selectTodos(index(...notes), view))).toEqual(expected);
    expect(ids(selectTodos(index(...[...notes].reverse()), view))).toEqual(expected);
    expect(ids(selectTodos(index(...notes), { ...view, sort: "oldest" }))).toEqual(["old:0", "old:2", "a:0", "a:2", "b:0", "b:2", "z:0", "z:2"]);
    expect(ids(selectTodos(index(...notes), { ...view, sort: "source" }))).toEqual(expected);
  });

  it("groups equal titles by URI in first-appearance order with source ordinal ordering", () => {
    const todos = selectTodos(index(note("a"), note("b")), { ...defaultTodoViewPreferences(), status: "all" });
    const shuffled = [todos[5], todos[2], todos[3], todos[0], todos[4], todos[1]];
    const before = structuredClone(shuffled);
    const sections = groupTodosBySource(shuffled);
    expect(sections.map(({ uri, title, data }) => ({ uri, title, ordinals: data.map((todo) => todo.ordinal) }))).toEqual([{ uri: "b", title: "Source", ordinals: [0, 1, 2] }, { uri: "a", title: "Source", ordinals: [0, 1, 2] }]);
    expect(shuffled).toEqual(before);
  });

  it("does not mutate index or preferences", () => {
    const sources = index(note("b", { tags: ["#Home"] }), note("a"));
    const view = { ...defaultTodoViewPreferences(), tags: ["HOME"] };
    const before = structuredClone({ sources, view });
    selectTodos(sources, view);
    getTodoFilterOptions(sources);
    expect({ sources, view }).toEqual(before);
  });
});

describe("preference validation", () => {
  it("returns fresh defaults for unknown values", () => {
    for (const value of [null, undefined, 4, "bad", []]) expect(normalizeTodoViewPreferences(value)).toEqual(defaultTodoViewPreferences());
    const first = defaultTodoViewPreferences();
    first.tags.push("changed");
    expect(defaultTodoViewPreferences().tags).toEqual([]);
  });

  it("validates independently, bounds query and normalizes/deduplicates arrays", () => {
    const input = { query: "q".repeat(600), status: "invalid", modes: ["idea", "idea", "note", 2, "invalid"], tags: ["#Work Stuff", "work-stuff", null, "", "###", "HOME"], sort: "oldest", groupBySource: true };
    expect(normalizeTodoViewPreferences(input)).toEqual({ query: "q".repeat(512), status: "open", modes: ["idea", "note"], tags: ["work-stuff", "home"], sort: "oldest", groupBySource: true });
    expect(normalizeTodoViewPreferences({ query: 2, status: "completed", modes: "note", tags: {}, sort: "unknown", groupBySource: "true" })).toEqual({ ...defaultTodoViewPreferences(), status: "completed" });
    const normalized = normalizeTodoViewPreferences(input);
    normalized.modes.push("audio");
    normalized.tags.push("new");
    expect(input.modes).not.toContain("audio");
    expect(input.tags).not.toContain("new");
  });
});
