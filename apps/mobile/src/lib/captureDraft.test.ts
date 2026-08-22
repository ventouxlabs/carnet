import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory AsyncStorage mock (same pattern as queue.test.ts) ──────────────

const _store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => _store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      _store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      _store.delete(k);
    }),
  },
}));

// ── Crypto backing for at-rest draft encryption (#86) ────────────────────────
// Stub the native modules, not queueCrypto, so these tests exercise the real
// encrypt/decrypt path and can assert the raw store holds ciphertext.
vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: async (n: number) => {
    const out = new Uint8Array(n);
    (globalThis.crypto as Crypto).getRandomValues(out);
    return out;
  },
}));

const _secureStore = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => _secureStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    _secureStore.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    _secureStore.delete(k);
  },
}));

import {
  clearDraft,
  isEmptyDraft,
  loadDraft,
  saveDraft,
} from "./captureDraft";

const IDEA_KEY = "carnet:capture_draft:v1:idea";

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

describe("captureDraft", () => {
  it("round-trips a draft per mode", async () => {
    await saveDraft("idea", { text: "half a thought", transcript: "", ocrText: "" });
    await saveDraft("journal", { text: "", transcript: "spoken words", ocrText: "" });

    const idea = await loadDraft("idea");
    expect(idea?.text).toBe("half a thought");
    expect(idea?.savedAt).toBeTypeOf("number");

    const journal = await loadDraft("journal");
    expect(journal?.transcript).toBe("spoken words");

    // Modes are isolated.
    expect(await loadDraft("person")).toBeNull();
  });

  it("returns null when nothing is stored", async () => {
    expect(await loadDraft("idea")).toBeNull();
  });

  it("treats an all-whitespace draft as empty and removes the key", async () => {
    await saveDraft("idea", { text: "real", transcript: "", ocrText: "" });
    await saveDraft("idea", { text: "   \n", transcript: "", ocrText: "" });
    expect(_store.has(IDEA_KEY)).toBe(false);
    expect(await loadDraft("idea")).toBeNull();
  });

  it("returns null on corrupt stored JSON", async () => {
    _store.set(IDEA_KEY, "{not json");
    expect(await loadDraft("idea")).toBeNull();
  });

  it("returns null on schema-mismatched stored value", async () => {
    _store.set(IDEA_KEY, JSON.stringify({ body: "wrong shape" }));
    expect(await loadDraft("idea")).toBeNull();
  });

  it("clearDraft removes the stored draft", async () => {
    await saveDraft("person", { text: "ctx", transcript: "", ocrText: "ocr" });
    await clearDraft("person");
    expect(await loadDraft("person")).toBeNull();
  });

  it("isEmptyDraft checks all three fields", () => {
    expect(isEmptyDraft({ text: "", transcript: "", ocrText: "" })).toBe(true);
    expect(isEmptyDraft({ text: "", transcript: "", ocrText: "x" })).toBe(false);
  });
});

// ── At-rest encryption (#86 follow-up) ───────────────────────────────────────
// The draft holds the SAME three data classes as the queue — idea text, voice
// transcript, OCR'd business-card PII — and is autosaved every keystroke-ish
// during composition. Encrypting only the queue would leave the in-flight
// capture readable in an `adb pull`, so the mitigation would not actually meet
// its own threat model.
describe("draft at-rest encryption", () => {
  const FIELDS = {
    text: "met at the conference, wants a follow-up",
    transcript: "voice note: call Jane about the acquisition",
    ocrText: "Jane Doe\nVP Eng\njane@example.com\n+1 555 0100",
  };

  it("stores ciphertext, with no plaintext in the raw dump", async () => {
    await saveDraft("idea", FIELDS);
    const dump = _store.get(IDEA_KEY)!;
    // Every needle must be impossible-by-construction in the base64 payload,
    // not just unlikely: short alphanumeric strings CAN appear in random
    // ciphertext ("555" did, in CI — the base64 alphabet includes digits).
    // Safe needles are either long enough to be astronomically improbable or
    // contain characters outside base64 (space, @, .); "555" alone is neither,
    // so assert on the full phone string, whose spaces and '+' can't collide.
    for (const needle of [
      "conference",
      "jane@example.com",
      "+1 555 0100",
      "acquisition",
      "VP Eng",
    ]) {
      expect(dump, `raw store must not contain ${needle}`).not.toContain(needle);
    }
    expect(dump.startsWith("carnet-q1:")).toBe(true);
  });

  it("round-trips every field", async () => {
    await saveDraft("idea", FIELDS);
    const loaded = await loadDraft("idea");
    expect(loaded).toMatchObject(FIELDS);
    expect(typeof loaded!.savedAt).toBe("number");
  });

  it("still reads a legacy plaintext draft written before encryption", async () => {
    _store.set(
      IDEA_KEY,
      JSON.stringify({ ...FIELDS, savedAt: 1_700_000_000_000 }),
    );
    expect(await loadDraft("idea")).toMatchObject(FIELDS);
  });

  it("re-seals a legacy plaintext draft on the next save", async () => {
    _store.set(
      IDEA_KEY,
      JSON.stringify({ ...FIELDS, savedAt: 1_700_000_000_000 }),
    );
    await saveDraft("idea", { ...FIELDS, text: "updated" });
    expect(_store.get(IDEA_KEY)!).not.toContain("conference");
    expect(_store.get(IDEA_KEY)!).not.toContain("updated");
    expect((await loadDraft("idea"))!.text).toBe("updated");
  });

  it("returns null rather than throwing when a draft cannot be decrypted", async () => {
    await saveDraft("idea", FIELDS);
    _secureStore.clear();
    const { __resetQueueKeyCache } = await import("./queueCrypto");
    __resetQueueKeyCache();
    // An unreadable draft must never block the capture screen.
    expect(await loadDraft("idea")).toBeNull();
  });

  it("clearing still removes the entry entirely", async () => {
    await saveDraft("idea", FIELDS);
    await clearDraft("idea");
    expect(_store.has(IDEA_KEY)).toBe(false);
  });
});
