import { beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { defaultTodoViewPreferences } from "./todoView";
import { getTodoViewPreferences, setTodoViewPreferences, todoViewPreferencesKey } from "./todoViewPreferences";
import type { VaultContext } from "./vaultContext";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => store.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
} }));
const context: VaultContext = { profileId: "default", rootUri: "file:///vault" };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
beforeEach(() => { store.clear(); vi.mocked(AsyncStorage.getItem).mockReset().mockImplementation(async (key) => store.get(key) ?? null); vi.mocked(AsyncStorage.setItem).mockReset().mockImplementation(async (key, value) => { store.set(key, value); }); });

describe("vault-scoped todo preferences", () => {
  it("defaults for missing, corrupt and unknown values", async () => {
    expect(await getTodoViewPreferences(context)).toEqual(defaultTodoViewPreferences());
    for (const raw of ["broken", "null", "[]", "true", '"unknown"']) {
      store.set(todoViewPreferencesKey(context), raw);
      expect(await getTodoViewPreferences(context)).toEqual(defaultTodoViewPreferences());
    }
  });

  it("propagates storage failure without replacing the saved view, allowing a read retry", async () => {
    const key = todoViewPreferencesKey(context);
    const saved = JSON.stringify({ ...defaultTodoViewPreferences(), query: "saved", tags: ["home"] });
    store.set(key, saved);
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error("unavailable"));
    await expect(getTodoViewPreferences(context)).rejects.toThrow("unavailable");
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(store.get(key)).toBe(saved);
    expect(await getTodoViewPreferences(context)).toEqual({ ...defaultTodoViewPreferences(), query: "saved", tags: ["home"] });
  });

  it("loads valid individual fields from partially damaged preferences", async () => {
    store.set(todoViewPreferencesKey(context), JSON.stringify({ status: "completed", sort: "invalid", query: "find", tags: ["#HOME", "home", null], modes: ["idea", "alien"], groupBySource: 1 }));
    expect(await getTodoViewPreferences(context)).toEqual({ ...defaultTodoViewPreferences(), status: "completed", query: "find", tags: ["home"], modes: ["idea"] });
  });

  it("isolates both profile and root, including sandbox, with collision-free keys", async () => {
    const contexts = [context, { ...context, profileId: "other" }, { ...context, rootUri: "file:///other" }, { ...context, rootUri: "" }, { profileId: "a:b", rootUri: "c" }, { profileId: "a", rootUri: "b:c" }];
    expect(new Set(contexts.map(todoViewPreferencesKey)).size).toBe(contexts.length);
    for (let i = 0; i < contexts.length; i++) await setTodoViewPreferences(contexts[i], { ...defaultTodoViewPreferences(), query: String(i) });
    for (let i = 0; i < contexts.length; i++) expect((await getTodoViewPreferences(contexts[i])).query).toBe(String(i));
    expect([...store.keys()].every((key) => key.startsWith("carnet:todo-view:v1:"))).toBe(true);
  });

  it("snapshots context and validated data before awaiting earlier writes", async () => {
    const gate = deferred();
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => { await gate.promise; store.set(key, value); });
    const first = setTodoViewPreferences(context, { ...defaultTodoViewPreferences(), query: "first" });
    await vi.waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
    const mutableContext = { ...context };
    const view = { ...defaultTodoViewPreferences(), query: "last", tags: ["#HOME"] };
    const last = setTodoViewPreferences(mutableContext, view);
    mutableContext.rootUri = "file:///switched";
    view.query = "mutated";
    view.tags.push("later");
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, last]);
    expect(await getTodoViewPreferences(context)).toEqual({ ...defaultTodoViewPreferences(), query: "last", tags: ["home"] });
    expect(store.has(todoViewPreferencesKey(mutableContext))).toBe(false);
  });

  it("allows independent vault writes to finish while earlier writes wait", async () => {
    const gate = deferred();
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => { await gate.promise; store.set(key, value); });
    const first = setTodoViewPreferences(context, { ...defaultTodoViewPreferences(), query: "slow" });
    await vi.waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
    const other = { ...context, rootUri: "file:///independent" };
    await setTodoViewPreferences(other, { ...defaultTodoViewPreferences(), query: "fast" });
    expect((await getTodoViewPreferences(other)).query).toBe("fast");
    expect(store.has(todoViewPreferencesKey(context))).toBe(false);
    gate.resolve();
    await first;
  });

  it("rejects failed saves but recovers the queue and keeps the latest save", async () => {
    const gate = deferred();
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async () => gate.promise);
    const first = setTodoViewPreferences(context, defaultTodoViewPreferences());
    const rejected = expect(first).rejects.toThrow("failed");
    const last = setTodoViewPreferences(context, { ...defaultTodoViewPreferences(), query: "recovered" });
    gate.reject(new Error("failed"));
    await rejected;
    await last;
    expect((await getTodoViewPreferences(context)).query).toBe("recovered");
    await setTodoViewPreferences(context, { ...defaultTodoViewPreferences(), query: "later" });
    expect((await getTodoViewPreferences(context)).query).toBe("later");
  });

  it("captures read context before delayed storage resolves", async () => {
    const gate = deferred();
    const mutableContext = { ...context };
    store.set(todoViewPreferencesKey(context), JSON.stringify({ query: "original" }));
    vi.mocked(AsyncStorage.getItem).mockImplementationOnce(async (key) => { await gate.promise; return store.get(key) ?? null; });
    const read = getTodoViewPreferences(mutableContext);
    mutableContext.profileId = "switched";
    gate.resolve();
    expect((await read).query).toBe("original");
  });

  it("waits for queued saves before immediate reentry reads the latest preferences", async () => {
    store.set(todoViewPreferencesKey(context), JSON.stringify({ query: "old" }));
    const gate = deferred();
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => { await gate.promise; store.set(key, value); });
    const first = setTodoViewPreferences(context, { ...defaultTodoViewPreferences(), query: "first" });
    const latest = setTodoViewPreferences(context, { ...defaultTodoViewPreferences(), query: "latest" });
    const read = getTodoViewPreferences(context);
    await vi.waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1));
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    const other = { ...context, profileId: "independent" };
    expect(await getTodoViewPreferences(other)).toEqual(defaultTodoViewPreferences());
    gate.resolve();
    await Promise.all([first, latest]);
    expect((await read).query).toBe("latest");
  });

  it("still loads persisted preferences if a pending save fails", async () => {
    store.set(todoViewPreferencesKey(context), JSON.stringify({ query: "persisted" }));
    const gate = deferred();
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async () => gate.promise);
    const save = setTodoViewPreferences(context, defaultTodoViewPreferences());
    const rejected = expect(save).rejects.toThrow("failed");
    const read = getTodoViewPreferences(context);
    gate.reject(new Error("failed"));
    await rejected;
    expect((await read).query).toBe("persisted");
  });
});
