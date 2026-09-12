import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory AsyncStorage mock ───────────────────────────────────────────────
// Same pattern as storage.test.ts — the queue is now a JSON array under one key
// instead of a SQLite table. We can't pull in the real native binding under Node.

interface Row {
  id: string;
  mode: string;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

const QUEUE_KEY = "carnet:queue:v1";
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

vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

// ── Crypto backing for the at-rest queue encryption ──────────────────────────
// queueCrypto pulls expo-crypto → expo-modules-core, which needs the native
// __DEV__ global. Stub the two native modules rather than the crypto module
// itself, so these tests exercise the REAL encrypt/decrypt path and can assert
// that what lands in AsyncStorage is genuinely ciphertext.
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

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    llmProviders: [
      {
        id: "omniroute",
        label: "OmniRoute",
        baseUrl: "",
        model: "",
        visionModel: "",
        preset: "omniroute",
      },
      {
        id: "relais",
        label: "Relais (local)",
        baseUrl: "http://127.0.0.1:8080",
        model: "",
        visionModel: "",
        preset: "relais",
      },
    ],
    activeProviderId: "omniroute",
    omniRouteApiKey: "",
    localLlmApiKey: "",
    captureFolderPath: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    richEditorEnabled: false,
    previewBeforeSave: false,
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "",
  }),
  getPromptOverrides: vi.fn().mockResolvedValue({}),
  DEFAULT_OMNIROUTE_MODEL: "openrouter/openai/gpt-4o-mini",
}));

// providerKeys.ts (dispatcher's per-provider SecureStore lookup) is not
// mocked directly — it reads through the real expo-secure-store mock above,
// which is fine since no test here asserts on a specific key value.

// ── Mock llmClient (dispatcher's single merged client) ───────────────────────

vi.mock("./llmClient", () => ({
  enrichIdea: vi.fn().mockResolvedValue({
    markdown: "---\nstatus: seedling\n---\n# Test Idea\n\nbody\n",
    model: "test",
  }),
  enrichJournal: vi.fn().mockResolvedValue({
    markdown: "---\ndate: 2026-05-16\n---\n# Journal\n\n## Notes\n- thing\n",
    model: "test",
  }),
  enrichPerson: vi.fn().mockResolvedValue({
    markdown: "---\nname: Jane Doe\n---\n# Jane Doe\n",
    model: "test",
  }),
  enrichSharedImage: vi.fn(),
  enrichSharedLink: vi.fn(),
  promoteIdea: vi.fn(),
  ocrCardViaVision: vi.fn(),
  listModels: vi.fn(),
  healthCheck: vi.fn(),
  DEFAULT_LOCAL_LLM_URL: "http://127.0.0.1:8080",
  LlmClientError: class LlmClientError extends Error {},
  // Tests inject network errors via mockRejectedValue. None of them throw
  // LlmClientError, so isPermanentError returns false → drain treats as
  // transient and increments attempts (the existing test expectation).
  isPermanentError: vi.fn().mockReturnValue(false),
  // Default false; the not-configured drain test flips it on for one pass.
  isNotConfiguredError: vi.fn().mockReturnValue(false),
  // Same deal for the insecure-transport drain test.
  isInsecureTransportError: vi.fn().mockReturnValue(false),
}));

// ── Mock writer ───────────────────────────────────────────────────────────────

vi.mock("./writer", () => ({
  writeIdea: vi.fn().mockResolvedValue({ filepath: "file:///carnet/Ideas/test-idea.md" }),
  appendJournal: vi.fn().mockResolvedValue({ filepath: "file:///carnet/Journal/2026-05-16.md" }),
  writePerson: vi.fn().mockResolvedValue({ filepath: "file:///carnet/People/Jane-Doe.md" }),
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
  rewriteFrontmatterField: vi.fn(),
  readNote: vi.fn(),
  updateNote: vi.fn(),
  // Lightweight stand-in for the real injectAttachments (unit-tested in
  // writer.test.ts). Enough to assert processRow wires attachments → body →
  // writeIdea/appendJournal: images become embeds, files become links.
  injectAttachments: vi.fn(
    (md: string, atts: { kind: string; rel: string; filename: string }[]) =>
      atts.reduce(
        (acc, a) =>
          a.kind === "image"
            ? `${acc}\n![](${a.rel})\n`
            : `${acc}\n[${a.filename}](${a.rel})\n`,
        md,
      ),
  ),
  // Same idea for places: a stand-in that emits the real section shape, enough
  // to assert the drain wires payload.places → body → appendJournal.
  injectPlaces: vi.fn(
    (md: string, places: { name: string; coords: { lat: number; lon: number } }[]) =>
      places.length === 0
        ? md
        : `${md}\n\n## Places\n\n${places
            .map((p) => `[${p.name}](geo:${p.coords.lat},${p.coords.lon})`)
            .join("\n\n")}\n`,
  ),
}));

// ── Mock @carnet/shared ───────────────────────────────────────────────────────

vi.mock("@carnet/shared", () => ({
  deriveTitle: vi.fn((md: string) => {
    for (const line of md.split("\n")) {
      if (line.startsWith("# ")) return line.slice(2).trim();
    }
    return "Untitled";
  }),
}));

// Import after all mocks are set up
import {
  enqueue,
  getQueueCounts,
  getQueueDepth,
  drainQueue,
  listQueueRows,
} from "./queue";

/** Current persisted queue rows (parsed from the AsyncStorage mock). */
function rows(): Row[] {
  const raw = _store.get(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as Row[]) : [];
}

/** Directly seed the queue store, bypassing enqueue (for ordering tests). */
function seed(seedRows: Row[]): void {
  _store.set(QUEUE_KEY, JSON.stringify(seedRows));
}

describe("getQueueCounts", () => {
  it("splits pending vs permanently-failed rows", async () => {
    seed([
      { id: "a", mode: "idea", payload_json: "{}", created_at: 1, attempts: 0, last_error: null },
      { id: "b", mode: "idea", payload_json: "{}", created_at: 2, attempts: 3, last_error: "5xx" },
      { id: "c", mode: "idea", payload_json: "{}", created_at: 3, attempts: 10, last_error: "401" },
    ]);
    expect(await getQueueCounts()).toEqual({ pending: 2, failed: 1 });
  });

  it("returns zeros on an empty queue", async () => {
    _store.delete(QUEUE_KEY);
    expect(await getQueueCounts()).toEqual({ pending: 0, failed: 0 });
  });
});

describe("listQueueRows", () => {
  it("returns a snapshot whose mutation doesn't touch the stored queue", async () => {
    seed([
      { id: "a", mode: "idea", payload_json: "{}", created_at: 1, attempts: 2, last_error: "5xx" },
    ]);
    const snapshot = await listQueueRows();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].attempts).toBe(2);
    snapshot[0].attempts = 99;
    expect((await listQueueRows())[0].attempts).toBe(2);
  });
});

beforeEach(() => {
  _store.clear();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enqueue", () => {
  it("adds a row to the queue", async () => {
    await enqueue({ mode: "idea", text: "my idea" });
    expect(rows().length).toBe(1);
    const row = rows()[0];
    expect(row.mode).toBe("idea");
    // payload_json is sealed at rest — read it back through listQueueRows,
    // which decrypts. See the "at-rest encryption" block below.
    const [decrypted] = await listQueueRows();
    expect(JSON.parse(decrypted.payload_json)).toMatchObject({
      mode: "idea",
      text: "my idea",
    });
  });

  it("increments queue depth", async () => {
    await enqueue({ mode: "idea", text: "idea 1" });
    await enqueue({ mode: "idea", text: "idea 2" });
    await enqueue({ mode: "idea", text: "idea 3" });
    const depth = await getQueueDepth();
    expect(depth).toBe(3);
  });
});

describe("drainQueue", () => {
  it("removes rows on successful processing", async () => {
    const { enrichIdea } = await import("./llmClient");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({ markdown: "---\nstatus: seedling\n---\n# Test Idea\n\nbody\n", model: "t" });
    vi.mocked(writeIdea).mockResolvedValue({ filepath: "file:///carnet/Ideas/test-idea.md" });

    await enqueue({ mode: "idea", text: "drain me" });
    expect(rows().length).toBe(1);

    await drainQueue();
    expect(rows().length).toBe(0);
  });

  it("removes a corrupt payload_json row during drain", async () => {
    seed([
      { id: "x", mode: "idea", payload_json: "{not valid json", created_at: 1, attempts: 0, last_error: null },
    ]);
    await drainQueue();
    expect(rows().length).toBe(0);
  });

  it("increments attempts on failure and leaves row in queue", async () => {
    const { enrichIdea } = await import("./llmClient");
    vi.mocked(enrichIdea).mockRejectedValue(new Error("network error"));

    await enqueue({ mode: "idea", text: "fail me" });
    await drainQueue();

    expect(rows().length).toBe(1);
    const row = rows()[0];
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("network error");
  });

  it("leaves rows untouched (no attempts burned) when OmniRoute is not configured", async () => {
    const { enrichIdea, isNotConfiguredError } = await import("./llmClient");
    vi.mocked(enrichIdea).mockRejectedValue(new Error("not configured"));
    // Classify the first failure as a config problem (drain breaks after one,
    // so Once is enough and won't leak into later tests via clearAllMocks).
    vi.mocked(isNotConfiguredError).mockReturnValueOnce(true);

    // Two pending rows: the pass must stop on the first without bumping either.
    seed([
      { id: "a", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "one" }), created_at: 100, attempts: 0, last_error: null },
      { id: "b", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "two" }), created_at: 200, attempts: 0, last_error: null },
    ]);

    await drainQueue();

    // Both rows survive with attempts still 0 — they'll drain once a URL is set.
    expect(rows().length).toBe(2);
    expect(rows().every((r) => r.attempts === 0)).toBe(true);
    expect(rows().every((r) => r.last_error === null)).toBe(true);
  });

  it("leaves rows untouched (no attempts burned) when the provider URL is insecure http", async () => {
    const { enrichIdea, isInsecureTransportError } = await import("./llmClient");
    vi.mocked(enrichIdea).mockRejectedValue(
      new Error("Insecure URL: use https:// for remote hosts"),
    );
    // Same drain-breaks-after-one reasoning as the not-configured test above.
    vi.mocked(isInsecureTransportError).mockReturnValueOnce(true);

    seed([
      { id: "a", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "one" }), created_at: 100, attempts: 0, last_error: null },
      { id: "b", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "two" }), created_at: 200, attempts: 0, last_error: null },
    ]);

    await drainQueue();

    expect(rows().length).toBe(2);
    expect(rows().every((r) => r.attempts === 0)).toBe(true);
    expect(rows().every((r) => r.last_error === null)).toBe(true);

    // Settings fixed (https now): the untouched rows drain on the next pass —
    // no attempt was spent on a request that could never have succeeded.
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\nstatus: seedling\n---\n# Test Idea\n\nbody\n",
      model: "t",
    });
    await drainQueue();

    expect(rows().length).toBe(0);
  });

  it("processes rows oldest-first", async () => {
    const { enrichIdea } = await import("./llmClient");
    const calls: string[] = [];
    vi.mocked(enrichIdea).mockImplementation(async (text: string) => {
      calls.push(text);
      return { markdown: `---\nstatus: seedling\n---\n# ${text}\n`, model: "t" };
    });

    // Seed with explicit created_at ordering (second appears first in the array).
    seed([
      { id: "b", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "second" }), created_at: 200, attempts: 0, last_error: null },
      { id: "a", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "first" }), created_at: 100, attempts: 0, last_error: null },
    ]);

    await drainQueue();
    expect(calls[0]).toBe("first");
    expect(calls[1]).toBe("second");
  });

  it("processes journal payloads via enrichJournal + appendJournal", async () => {
    const { enrichJournal } = await import("./llmClient");
    const { appendJournal } = await import("./writer");

    await enqueue({ mode: "journal", transcript: "today I did things", notes: "", date: "2026-05-16" });
    await drainQueue();

    expect(vi.mocked(enrichJournal)).toHaveBeenCalledWith(
      { transcript: "today I did things", notes: "" },
      expect.any(Object),
      undefined,
      // v0.4 S3: the offline drain goes through dispatcher.enrich*, so a
      // queued capture carries the vault tag vocabulary too (empty here —
      // no note index is cached in this suite).
      expect.any(Array),
    );
    expect(vi.mocked(appendJournal)).toHaveBeenCalled();
    expect(rows().length).toBe(0);
  });

  it("processes person payloads via enrichPerson + writePerson", async () => {
    const { enrichPerson } = await import("./llmClient");
    const { writePerson } = await import("./writer");

    await enqueue({ mode: "person", ocrResult: "Jane Doe CEO", context: "conference" });
    await drainQueue();

    expect(vi.mocked(enrichPerson)).toHaveBeenCalledWith(
      { ocrResult: "Jane Doe CEO", context: "conference" },
      expect.any(Object),
      undefined,
      // v0.4 S3: the offline drain goes through dispatcher.enrich*, so a
      // queued capture carries the vault tag vocabulary too (empty here —
      // no note index is cached in this suite).
      expect.any(Array),
    );
    expect(vi.mocked(writePerson)).toHaveBeenCalled();
    expect(rows().length).toBe(0);
  });

  it("folds queued attachments into the body before writing (idea)", async () => {
    const { writeIdea, injectAttachments } = await import("./writer");

    await enqueue({
      mode: "idea",
      text: "with files",
      attachments: [
        { kind: "image", rel: "../Photos/a.jpg", filename: "a.jpg" },
        { kind: "file", rel: "../Files/b.pdf", filename: "b.pdf" },
      ],
    });
    await drainQueue();

    // Attachments were handed to injectAttachments, and its output reached disk.
    expect(vi.mocked(injectAttachments)).toHaveBeenCalledWith(
      expect.any(String),
      [
        { kind: "image", rel: "../Photos/a.jpg", filename: "a.jpg" },
        { kind: "file", rel: "../Files/b.pdf", filename: "b.pdf" },
      ],
    );
    const writtenBody = vi.mocked(writeIdea).mock.calls[0][1];
    expect(writtenBody).toContain("![](../Photos/a.jpg)");
    expect(writtenBody).toContain("[b.pdf](../Files/b.pdf)");
    expect(rows().length).toBe(0);
  });

  it("drains a legacy row with no attachments field unchanged", async () => {
    // Rows queued before this feature have no `attachments` key — they must
    // drain exactly as before (injectAttachments gets an empty list).
    const { writeIdea } = await import("./writer");
    seed([
      { id: "old", mode: "idea", payload_json: JSON.stringify({ mode: "idea", text: "legacy" }), created_at: 1, attempts: 0, last_error: null },
    ]);

    await drainQueue();

    expect(vi.mocked(writeIdea)).toHaveBeenCalledTimes(1);
    expect(rows().length).toBe(0);
  });

  it("merges queued tags into the idea frontmatter on drain (offline parity)", async () => {
    const { enrichIdea } = await import("./llmClient");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\nstatus: seedling\n---\n# Tagged Idea\n\nbody\n",
      model: "t",
    });

    await enqueue({ mode: "idea", text: "tag me", tags: ["work", "urgent"] });
    await drainQueue();

    const writtenBody = vi.mocked(writeIdea).mock.calls[0][1];
    expect(writtenBody).toContain("tags: [work, urgent]");
    expect(rows().length).toBe(0);
  });

  it("preserves LLM-emitted tags when merging queued user tags (idea)", async () => {
    const { enrichIdea } = await import("./llmClient");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\ntags: [seedling]\n---\n# Merge Idea\n\nbody\n",
      model: "t",
    });

    await enqueue({ mode: "idea", text: "merge me", tags: ["Work"] });
    await drainQueue();

    expect(vi.mocked(writeIdea).mock.calls[0][1]).toContain("tags: [seedling, work]");
  });

  it("merges queued tags into journal + person frontmatter on drain", async () => {
    const { appendJournal, writePerson } = await import("./writer");

    await enqueue({
      mode: "journal",
      transcript: "did things",
      notes: "",
      date: "2026-05-16",
      tags: ["daily"],
    });
    await enqueue({ mode: "person", ocrResult: "Jane", context: "conf", tags: ["lead"] });
    await drainQueue();

    expect(vi.mocked(appendJournal).mock.calls[0][1]).toContain("tags: [daily]");
    // writePerson(firstName, lastName, markdown) — markdown is the 3rd arg.
    expect(vi.mocked(writePerson).mock.calls[0][2]).toContain("tags: [lead]");
  });

  it("leaves the body untouched when a queued row carries no tags", async () => {
    const { enrichIdea } = await import("./llmClient");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\nstatus: seedling\n---\n# Untagged\n\nbody\n",
      model: "t",
    });

    await enqueue({ mode: "idea", text: "no tags", tags: [] });
    await drainQueue();

    expect(vi.mocked(writeIdea).mock.calls[0][1]).not.toContain("tags:");
  });

  it("injects a queued location into the idea frontmatter on drain", async () => {
    const { enrichIdea } = await import("./llmClient");
    const { writeIdea } = await import("./writer");
    vi.mocked(enrichIdea).mockResolvedValue({
      markdown: "---\nstatus: seedling\n---\n# Located\n\nbody\n",
      model: "t",
    });

    await enqueue({ mode: "idea", text: "where", location: "38.90720,-77.03690" });
    await drainQueue();

    expect(vi.mocked(writeIdea).mock.calls[0][1]).toContain("location: 38.90720,-77.03690");
  });

  it("injects a queued location into journal + person frontmatter on drain", async () => {
    const { appendJournal, writePerson } = await import("./writer");

    await enqueue({
      mode: "journal",
      transcript: "t",
      notes: "",
      date: "2026-05-16",
      location: "1,2",
    });
    await enqueue({ mode: "person", ocrResult: "Jane", context: "conf", location: "3,4" });
    await drainQueue();

    expect(vi.mocked(appendJournal).mock.calls[0][1]).toContain("location: 1,2");
    expect(vi.mocked(writePerson).mock.calls[0][2]).toContain("location: 3,4");
  });

  it("round-trips journal places through enqueue → drain into the entry body", async () => {
    const { appendJournal } = await import("./writer");

    await enqueue({
      mode: "journal",
      transcript: "t",
      notes: "",
      date: "2026-05-16",
      places: [
        { name: "Rud-Alpe", coords: { lat: 47.2011, lon: 10.1166 } },
        { name: "Lech", coords: { lat: 47.2063, lon: 10.1435 } },
      ],
    });
    await drainQueue();

    const body = vi.mocked(appendJournal).mock.calls[0][1];
    expect(body).toContain("## Places");
    expect(body).toContain("[Rud-Alpe](geo:47.2011,10.1166)");
    expect(body).toContain("[Lech](geo:47.2063,10.1435)");
  });

  it("adds no Places section when a journal payload carries none", async () => {
    const { appendJournal } = await import("./writer");

    await enqueue({ mode: "journal", transcript: "t", notes: "", date: "2026-05-16" });
    await drainQueue();

    expect(vi.mocked(appendJournal).mock.calls[0][1]).not.toContain("## Places");
  });

  it("marks 4xx (permanent) errors as permanent failure immediately", async () => {
    const { enrichIdea, isPermanentError } = await import("./llmClient");
    vi.mocked(enrichIdea).mockRejectedValue(new Error("401 Unauthorized"));
    // Classify this error as permanent.
    vi.mocked(isPermanentError).mockReturnValueOnce(true);

    await enqueue({ mode: "idea", text: "doomed" });
    await drainQueue();

    expect(rows().length).toBe(1);
    const row = rows()[0];
    // Permanent failure sets attempts to MAX so it won't be re-tried in
    // subsequent drains (queue depth excludes attempts >= MAX).
    expect(row.attempts).toBe(10);
  });

  it("redacts Bearer tokens from stored last_error", async () => {
    const { enrichIdea } = await import("./llmClient");
    vi.mocked(enrichIdea).mockRejectedValue(
      new Error("upstream said: Bearer sk-very-secret-token-xyz invalid"),
    );

    await enqueue({ mode: "idea", text: "leaky" });
    await drainQueue();

    const row = rows()[0];
    expect(row.last_error).not.toContain("sk-very-secret-token-xyz");
    expect(row.last_error).toContain("Bearer [redacted]");
  });

  it("single-flight: parallel drainQueue calls do not double-process", async () => {
    const { enrichIdea } = await import("./llmClient");
    const calls: string[] = [];
    let resolveFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => { resolveFirst = resolve; });
    vi.mocked(enrichIdea).mockImplementation(async (text: string) => {
      calls.push(text);
      // Hold the first call so a parallel drainQueue() runs while we're mid-process.
      if (calls.length === 1) await firstHold;
      return { markdown: `---\nstatus: seedling\n---\n# ${text}\n`, model: "t" };
    });

    await enqueue({ mode: "idea", text: "only-once" });

    const drain1 = drainQueue();
    // While drain1 is still mid-flight (awaiting firstHold), kick off a parallel drain.
    const drain2 = drainQueue();
    // Now release the first call.
    resolveFirst();
    await Promise.all([drain1, drain2]);

    // The row should have been processed exactly once.
    expect(calls).toEqual(["only-once"]);
    expect(rows().length).toBe(0);
  });
});

// ── At-rest encryption (#86) ─────────────────────────────────────────────────
// The queue holds raw idea text, voice transcripts and OCR'd business-card PII.
// AsyncStorage is an unencrypted file in the app sandbox, so a raw dump (adb
// pull on a rooted/debug device) must yield ciphertext, not readable capture
// content. These assert against the RAW store, not the decrypting accessors.
describe("queue at-rest encryption", () => {
  // The phone-number stand-in is a 20+-char sentinel, not a bare "+1 555
  // 0100" — a short digit run like "555" occasionally turns up BY CHANCE
  // inside the base64 ciphertext/nonce/HMAC this test asserts against
  // (observed flaking in CI: random AES output happened to contain "555"),
  // since a 3-char substring has real odds of a coincidental match across a
  // few hundred base64 characters. A sentinel this long is, for any
  // practical purpose, impossible to hit by chance.
  const PII_PHONE_SENTINEL = "PHONE-5550100-COLLISION-PROOF-MARKER";
  const PII = `Jane Doe jane@example.com ${PII_PHONE_SENTINEL} confidential idea`;

  it("stores payloads as ciphertext, with no plaintext in the raw dump", async () => {
    await enqueue({ mode: "idea", text: PII });

    const dump = _store.get(QUEUE_KEY)!;
    expect(dump).not.toContain("Jane Doe");
    expect(dump).not.toContain("jane@example.com");
    expect(dump).not.toContain(PII_PHONE_SENTINEL);
    expect(dump).not.toContain("confidential");
    expect(rows()[0].payload_json.startsWith("carnet-q1:")).toBe(true);
  });

  it("restores the exact plaintext on read", async () => {
    await enqueue({ mode: "idea", text: PII });
    const [row] = await listQueueRows();
    expect(JSON.parse(row.payload_json)).toMatchObject({
      mode: "idea",
      text: PII,
    });
  });

  it("keeps the key in SecureStore and never in AsyncStorage", async () => {
    await enqueue({ mode: "idea", text: PII });
    expect(_secureStore.size).toBe(1);
    const key = [..._secureStore.values()][0];
    for (const v of _store.values()) expect(v).not.toContain(key);
  });

  it("reads legacy plaintext rows written before encryption shipped", async () => {
    seed([
      {
        id: "legacy",
        mode: "idea",
        payload_json: JSON.stringify({ mode: "idea", text: "old capture" }),
        created_at: 1,
        attempts: 0,
        last_error: null,
      },
    ]);
    const [row] = await listQueueRows();
    expect(JSON.parse(row.payload_json)).toMatchObject({ text: "old capture" });
  });

  it("seals legacy plaintext rows on the next write (upgrade migration)", async () => {
    seed([
      {
        id: "legacy",
        mode: "idea",
        payload_json: JSON.stringify({ mode: "idea", text: "old capture" }),
        created_at: 1,
        attempts: 0,
        last_error: null,
      },
    ]);
    expect(_store.get(QUEUE_KEY)!).toContain("old capture");

    // Any write path re-persists the whole queue; enqueue is the simplest.
    await enqueue({ mode: "idea", text: "new capture" });

    const dump = _store.get(QUEUE_KEY)!;
    expect(dump).not.toContain("old capture");
    expect(dump).not.toContain("new capture");
    expect(rows().every((r) => r.payload_json.startsWith("carnet-q1:"))).toBe(
      true,
    );
    // The legacy row survived the migration intact.
    const restored = await listQueueRows();
    expect(restored).toHaveLength(2);
    expect(
      restored.map((r) => JSON.parse(r.payload_json).text).sort(),
    ).toEqual(["new capture", "old capture"]);
  });

  it("drops a row that can no longer be decrypted (key rotated / reinstall)", async () => {
    await enqueue({ mode: "idea", text: PII });
    expect(rows()).toHaveLength(1);

    // Simulate losing the key: SecureStore cleared, cache dropped. The sealed
    // row is now unreadable and can never be processed.
    _secureStore.clear();
    const { __resetQueueKeyCache } = await import("./queueCrypto");
    __resetQueueKeyCache();

    // It surfaces as a corrupt row and drainQueue removes it, rather than
    // wedging the queue with a payload that will fail forever.
    const surfaced = await listQueueRows();
    expect(surfaced[0].payload_json.startsWith("carnet-q1:")).toBe(true);
    await drainQueue();
    expect(rows()).toHaveLength(0);
  });

  it("does not nest envelopes across repeated writes", async () => {
    // Each write decrypts then re-seals with a fresh IV, so the stored envelope
    // is not byte-stable — what must hold is that it stays exactly ONE envelope
    // deep, i.e. a single decrypt yields JSON rather than another envelope.
    await enqueue({ mode: "idea", text: "first" });
    await enqueue({ mode: "idea", text: "second" });
    await enqueue({ mode: "idea", text: "third" });

    for (const row of rows()) {
      expect(row.payload_json.startsWith("carnet-q1:")).toBe(true);
    }
    const restored = await listQueueRows();
    for (const row of restored) {
      expect(row.payload_json.startsWith("carnet-q1:")).toBe(false);
      expect(() => JSON.parse(row.payload_json)).not.toThrow();
    }
    expect(restored.map((r) => JSON.parse(r.payload_json).text).sort()).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
