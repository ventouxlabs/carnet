import AsyncStorage from "@react-native-async-storage/async-storage";
import { defaultTodoViewPreferences, normalizeTodoViewPreferences, type TodoViewPreferences } from "./todoView";
import type { VaultContext } from "./vaultContext";

const writes = new Map<string, Promise<void>>();

/** JSON tuple boundaries keep profile/root pairs collision-free, including sandbox "". */
export function todoViewPreferencesKey(context: VaultContext): string {
  return `carnet:todo-view:v1:${JSON.stringify([context.profileId, context.rootUri])}`;
}

export async function getTodoViewPreferences(context: VaultContext): Promise<TodoViewPreferences> {
  const key = todoViewPreferencesKey(context);
  const pending = writes.get(key);
  await pending?.catch(() => undefined);
  // An inaccessible saved view must reach the UI's retry flow rather than
  // masquerading as defaults that a later edit could overwrite.
  const raw = await AsyncStorage.getItem(key);
  try {
    return raw === null ? defaultTodoViewPreferences() : normalizeTodoViewPreferences(JSON.parse(raw));
  } catch {
    return defaultTodoViewPreferences();
  }
}

/** Snapshot before any await; serialize only this vault's saves in invocation order. */
export function setTodoViewPreferences(context: VaultContext, view: TodoViewPreferences): Promise<void> {
  const key = todoViewPreferencesKey(context);
  const snapshot = JSON.stringify(normalizeTodoViewPreferences(view));
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => AsyncStorage.setItem(key, snapshot));
  writes.set(key, next);
  const cleanUp = () => {
    if (writes.get(key) === next) writes.delete(key);
  };
  void next.then(cleanUp, cleanUp);
  return next;
}
