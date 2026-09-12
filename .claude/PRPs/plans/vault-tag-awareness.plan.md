# Vault Tag Awareness (v0.4 S3) Implementation Plan

Status: in-progress

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-tagging from inventing near-duplicate tags (`dev` / `development` / `engineering`) by showing the model the vault's existing tag vocabulary as a soft prompt hint.

**Architecture:** A new `lib/vaultTagHint.ts` reads the *already-cached* tag index into a capped list of tag strings; `withTagHint` in `prompts.ts` turns that list into a hint appended to a system prompt (the two cannot share a module — see File Structure). The dispatcher resolves the tag list (in parallel with settings, so no added capture latency) and threads it into the five tag-emitting enrich entry points. The hint is applied to the **final** system string — after any user prompt override — so an override cannot silently disable it.

**Tech Stack:** TypeScript, React Native 0.81 / Expo SDK 54, vitest, AsyncStorage.

**Spec:** `.claude/PRPs/prds/v0.4-ai-deepening.prd.md` — "Slate 3 — Vault tag awareness (S3)".

## Global Constraints

- Frontmatter must stay byte-compatible with existing Obsidian vault files. **This plan does not touch serialization** — it changes *which* tags the model proposes, not how tags are written. `setFrontmatterTags` / `normalizeTag` are untouched.
- No SQLite. No `.env` files. All persistence via AsyncStorage / `expo-secure-store`.
- Lint in `apps/mobile` stays at exactly three rules — do not widen it.
- Gates per workspace: `tsc --noEmit` + vitest (+ lint in the mobile CI job).
- Conventional commits; branch from `main`; squash-merge.
- Fix the implementation, not the test, unless the test itself is wrong.

## Deltas from the PRD (verified against the code 2026-09-09)

The PRD's Slate 3 is four months old. These were checked, and the plan below follows the **code**, not the PRD text:

| PRD says | Reality | Consequence |
|---|---|---|
| `buildTagIndex()`/`getTagIndex()` at `lib/vault.ts:65`, cache key `carnet:tagindex:v1` | `getTagIndex()` at `vault.ts:359`; the tag index is *derived* from a single note-index blob keyed `carnet:noteindex:v1` | Read `loadCachedTagIndex()`, which derives from `loadCachedNoteIndex()` |
| "Thread the tag list into all five enrich entry points as an `availableTags` prompt variable" (implying edits to the five prompt builders) | `withSystemOverride` (`llmClient.ts:123`) **replaces the entire system string** when a user override exists; `PromptOverridesSection.tsx` exposes overrides for all five | Baking the hint into `prompts.ts` builders would silently lose it for any user with an override. Apply the hint to the **final** system string instead. No *builder* text changes and `prompts.test.ts`'s exact-string assertions do **not** break — though `prompts.ts` does gain the pure `withTagHint` helper, for the separate reason in File Structure. |
| **Risk:** "SAF directory walks are slow… 1000-note vault could take 5-10 seconds… mitigation: aggressive caching + background pre-warm on app launch" | Already retired. The cost is paid by TagBrowser/Search/Todos, and `HomeScreen.tsx:100-122` already implements exactly the pre-warm pattern (cached read, background rebuild on miss, never blocks) | **No new pre-warm task is needed.** Do not add one. |
| "S3 scan trigger: on every capture (with cache) vs only on app launch? Suggest both" | Satisfied by the above | — |

Three further facts worth not re-litigating (all verified 2026-09-09, don't re-check):

- **Five is the complete set of tag-emitting prompts.** `prompts.ts` exports eight builders, but `tags:` appears only at lines 55, 93, 131, 177 and 239 — the five capture builders. The other three were each read in full, not just grepped:
  - `buildPromoteIdeaPrompt` (:342) instructs "keep the frontmatter format identical, just change status and optionally expand the body" — it **preserves** the note's existing tags and never proposes new ones, so vocabulary discipline established at capture survives promotion. Not a sprawl path, and not a sixth call site.
  - `buildEnhanceProsePrompt` (:287) rewrites body prose only.
  - `buildRetrospectivePrompt` (:396) produces a synthesized answer, not frontmatter.
- **All five enrich entry points share the signature `(input, config, override?)`** (`llmClient.ts` :326, :346, :369, :400, :541). The trailing-parameter approach in Task 3 is uniform across all five, including `enrichSharedImage`.

- **Prompt injection via vault tag strings is structurally closed.** Tags in the index pass through `normalizeTag` (`frontmatter.ts:472`), which restricts to `[a-z0-9-]` — no newlines, angle brackets, or whitespace can survive into the hint. The residual surface is unbounded **length/count**, which Task 1 clamps.
- **`getTagIndex()` must not be used here.** It falls through to a full `refreshNoteIndex()` vault walk on a cache miss (`vault.ts:292-296`), which would put a multi-second SAF walk in front of a capture. Capture latency is this app's thesis. Use `loadCachedTagIndex()` and accept `[]` on a cold miss.

## Deferred (explicitly out of scope)

**No deterministic canonicalizer.** Post-hoc rewriting of model output (`development` → `dev` when the vault already has `dev`) is more reliable than a soft hint, especially for a small local model behind `dispatcher.ts`. It is deferred because it silently rewrites model output into the user's vault, and the fuzzy-match threshold is guesswork without real sprawl data. `getVaultTagStrings` is left as the seam a canonicalizer would slot into. Ship the hint, observe whether sprawl stops, then decide.

## File Structure

| File | Responsibility |
|---|---|
| `apps/mobile/src/lib/vaultTagHint.ts` (create) | Read the cached tag index → capped tag-string list. Nothing else. |
| `apps/mobile/src/lib/prompts.ts` (modify) | Home of `withTagHint` — the pure system-string builder. See the note below; it CANNOT live beside the vault read. Builder text is untouched. |
| `apps/mobile/src/lib/vaultTagHint.test.ts` (create) | Unit tests for both functions. |
| `apps/mobile/src/lib/settings.ts` (modify) | Add `useExistingTagsForAutoTag: boolean` to `Settings` + `DEFAULT_PERSISTED` (7 sites). |
| `apps/mobile/src/lib/settingsForm.ts` (modify) | The form-state mirror of `Settings` (3 sites). Missed by the first enumeration; `tsc` caught it. |
| `apps/mobile/src/lib/llmClient.ts` (modify) | Accept `availableTags` on the five enrich entry points; apply hint after override. |
| `apps/mobile/src/lib/dispatcher.ts` (modify) | Resolve the tag list in parallel with settings; gate on the setting; pass down. |
| `apps/mobile/src/components/LlmProviderSection.tsx` **or** `SettingsScreen.tsx` (modify) | Surface the toggle. Task 5 determines which by inspection. |

**`withTagHint` must live in `prompts.ts`, not `vaultTagHint.ts`.** `llmClient.ts`
states in its header that it "reads NO settings" and it imports no native
modules. Importing `vaultTagHint` there pulls in `./vault` →
`expo-modules-core`, which fails every one of the four llmClient suites at
load time with `ReferenceError: __DEV__ is not defined`. So the vault READ
lives in `vaultTagHint.ts` and the pure string BUILD lives with the other
prompt construction. What stays true is the original point: no *builder* text
changes, and `prompts.test.ts` passes unmodified.

---

### Task 1: `vaultTagHint.ts` — tag-string reader + hint builder

**Files:**
- Create: `apps/mobile/src/lib/vaultTagHint.ts`
- Test: `apps/mobile/src/lib/vaultTagHint.test.ts`

**Interfaces:**
- Consumes: `loadCachedTagIndex()` from `./vault` (returns `Promise<TagIndex | null>`; `TagIndex` is `{ builtAt: number; tags: { tag: string; count: number; files: string[] }[] }`, already count-sorted descending).
- Produces:
  - `getVaultTagStrings(limit?: number): Promise<string[]>` — in `vaultTagHint.ts`
  - `MAX_HINT_TAGS: number` (50), `MAX_TAG_LENGTH: number` (40) — in `vaultTagHint.ts`
  - `withTagHint(system: string, availableTags: string[]): string` — in **`prompts.ts`**, for the native-import reason in File Structure above. Import it from `./prompts`, never from `./vaultTagHint`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/lib/vaultTagHint.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./vault", () => ({ loadCachedTagIndex: vi.fn() }));

import { loadCachedTagIndex } from "./vault";
import {
  getVaultTagStrings,
  withTagHint,
  MAX_HINT_TAGS,
  MAX_TAG_LENGTH,
} from "./vaultTagHint";

const mockIndex = (tags: { tag: string; count: number }[]) => ({
  builtAt: 0,
  tags: tags.map((t) => ({ ...t, files: [] })),
});

describe("getVaultTagStrings", () => {
  beforeEach(() => vi.mocked(loadCachedTagIndex).mockReset());

  it("returns [] on a cold cache instead of triggering a vault walk", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(null);
    expect(await getVaultTagStrings()).toEqual([]);
  });

  it("returns [] when the cached read throws", async () => {
    vi.mocked(loadCachedTagIndex).mockRejectedValue(new Error("storage gone"));
    expect(await getVaultTagStrings()).toEqual([]);
  });

  it("preserves the index's count-sorted order", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([
        { tag: "journal", count: 9 },
        { tag: "idea", count: 4 },
        { tag: "dev", count: 1 },
      ]),
    );
    expect(await getVaultTagStrings()).toEqual(["journal", "idea", "dev"]);
  });

  it("caps at MAX_HINT_TAGS, keeping the most-used", async () => {
    const many = Array.from({ length: MAX_HINT_TAGS + 20 }, (_, i) => ({
      tag: `tag${i}`,
      count: 1000 - i,
    }));
    const result = await (vi.mocked(loadCachedTagIndex).mockResolvedValue(mockIndex(many)),
    getVaultTagStrings());
    expect(result).toHaveLength(MAX_HINT_TAGS);
    expect(result[0]).toBe("tag0");
  });

  it("drops over-long tags rather than truncating them", async () => {
    const long = "a".repeat(MAX_TAG_LENGTH + 1);
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([{ tag: long, count: 5 }, { tag: "ok", count: 1 }]),
    );
    expect(await getVaultTagStrings()).toEqual(["ok"]);
  });

  it("drops empty tags", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([{ tag: "", count: 5 }, { tag: "ok", count: 1 }]),
    );
    expect(await getVaultTagStrings()).toEqual(["ok"]);
  });

  it("honours an explicit smaller limit", async () => {
    vi.mocked(loadCachedTagIndex).mockResolvedValue(
      mockIndex([
        { tag: "a", count: 3 },
        { tag: "b", count: 2 },
        { tag: "c", count: 1 },
      ]),
    );
    expect(await getVaultTagStrings(2)).toEqual(["a", "b"]);
  });
});

describe("withTagHint", () => {
  it("returns the system prompt untouched when there are no tags", () => {
    expect(withTagHint("SYSTEM", [])).toBe("SYSTEM");
  });

  it("appends a hint naming the tags", () => {
    const result = withTagHint("SYSTEM", ["dev", "journal"]);
    expect(result.startsWith("SYSTEM")).toBe(true);
    expect(result).toContain("dev, journal");
  });

  it("tells the model it may still create new tags", () => {
    expect(withTagHint("SYSTEM", ["dev"]).toLowerCase()).toContain("new");
  });

  it("is applied on top of an arbitrary (overridden) system prompt", () => {
    const overridden = "Totally custom user instructions.";
    expect(withTagHint(overridden, ["dev"]).startsWith(overridden)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm -w @carnet/mobile test -- vaultTagHint`
Expected: FAIL — cannot resolve `./vaultTagHint`.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/src/lib/vaultTagHint.ts`:

```ts
/**
 * Vault tag awareness (v0.4 S3): show the model the tag vocabulary the vault
 * already uses, so auto-tagging reuses `dev` instead of minting `development`
 * and `engineering` alongside it.
 *
 * Two deliberate choices, both load-bearing:
 *
 * 1. Reads `loadCachedTagIndex()`, NEVER `getTagIndex()`. The latter falls
 *    through to a full `refreshNoteIndex()` SAF vault walk on a cache miss
 *    (vault.ts:292), which would put seconds of I/O in front of a capture.
 *    The hint is best-effort: a cold cache yields no hint, not a slow capture.
 *    HomeScreen already warms the index in the background on launch.
 *
 * 2. The hint is appended to the FINAL system string, after any user prompt
 *    override has been applied — `withSystemOverride` replaces the whole
 *    system message, so a hint baked into prompts.ts would vanish for anyone
 *    using PromptOverridesSection.
 *
 * Tag strings reach the prompt from vault files (i.e. from Syncthing, i.e.
 * from anywhere), but every tag in the index has passed `normalizeTag`
 * (frontmatter.ts:472) which restricts to [a-z0-9-] — no newlines, angle
 * brackets or whitespace can survive. What normalizeTag does NOT bound is
 * length or count, so both are clamped here.
 */

import { loadCachedTagIndex } from "./vault";

/** Most-used tags to name in the hint. Bounds prompt size on a large vault
 * (a 500-tag vault would otherwise inflate every capture's system message,
 * including for a small local model behind dispatcher.ts). */
export const MAX_HINT_TAGS = 50;

/** Longest tag admitted into the hint. normalizeTag bounds the alphabet but
 * not the length; a pathological 5000-char tag is dropped, not truncated —
 * a truncated tag is a DIFFERENT tag and would teach the model a name that
 * does not exist in the vault. */
export const MAX_TAG_LENGTH = 40;

/**
 * The vault's existing tag vocabulary, most-used first, or `[]` when no index
 * is cached yet. Never triggers a vault scan; never throws.
 */
export async function getVaultTagStrings(limit: number = MAX_HINT_TAGS): Promise<string[]> {
  let index;
  try {
    index = await loadCachedTagIndex();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[vaultTagHint] cached tag index read failed:", msg);
    return [];
  }
  if (!index) return [];
  const usable = index.tags
    .map((entry) => entry.tag)
    .filter((tag) => tag.length > 0 && tag.length <= MAX_TAG_LENGTH);
  return usable.slice(0, limit);
}

/**
 * Append the vault-vocabulary hint to a system prompt. Returns `system`
 * unchanged when there is nothing to suggest, so a cold cache, an empty
 * vault, and a disabled setting all collapse to today's exact behavior.
 */
export function withTagHint(system: string, availableTags: string[]): string {
  if (availableTags.length === 0) return system;
  return `${system}

This vault already uses these tags (most-used first):
${availableTags.join(", ")}
When one of them fits the content, reuse it EXACTLY rather than inventing a
near-duplicate (e.g. reuse "dev" instead of adding "development"). Create a
new tag only when nothing above fits. This list is a vocabulary, not a
restriction on how many tags to emit — follow the tag count asked for above.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm -w @carnet/mobile test -- vaultTagHint`
Expected: PASS (all 11 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/vaultTagHint.ts apps/mobile/src/lib/vaultTagHint.test.ts
git commit -m "feat(tags): add vault tag vocabulary hint module"
```

---

### Task 2: `Settings.useExistingTagsForAutoTag`

**Files:**
- Modify: `apps/mobile/src/lib/settings.ts` (the `Settings` interface at :78, `DEFAULT_PERSISTED` at :205)
- Test: `apps/mobile/src/lib/settings.test.ts`

**Interfaces:**
- Produces: `Settings.useExistingTagsForAutoTag: boolean`, default `true`.

- [ ] **Step 1: Enumerate every site the sibling boolean occupies**

A new settings field is **not** a two-line change here. `autoTranscribeOnSave` — the exact template to copy — occupies **12 sites across three files** (`settingsForm.ts` does not mention it by the same grep shape and was missed on the first pass; `tsc` caught it):

```bash
grep -rn 'autoTranscribeOnSave' apps/mobile/src/lib/settings.ts apps/mobile/src/lib/settingsTransfer.ts apps/mobile/src/lib/settingsForm.ts
```

As of 2026-09-09 that is `settings.ts` :143 (the `Settings` interface), :179 (the `PersistedSettings` type), :214 (`DEFAULT_PERSISTED`), :405, :430, :478, :516; `settingsTransfer.ts` :30 (the transfer shape), :57, :113, :196; and `settingsForm.ts` :22 (the FormState shape), :74, :98.

**A second trap at `settingsTransfer.ts:196`:** the transfer format gates on `version !== VERSION` with a hard throw, so adding the field as a *required* boolean there makes every settings file exported by v0.11.0 and earlier fail to import. Bumping `VERSION` is worse — it rejects them outright. Declare the field OPTIONAL in the transfer shape, accept `undefined` in the validator, and default it to `true` at the import site.

`settingsForm.test.ts`'s "maps every non-secret, non-LLM-identity Settings field onto FormState" is the test that catches a missed site — expect it to fail until every one is done.

**`settingsTransfer.ts:196` is the trap:** it is a validation guard of the form `typeof value.autoTranscribeOnSave === "boolean" &&`. Omitting the new field there means the setting silently fails to survive a settings export/import, and nothing else in the suite notices. Add the field at every one of the 11 sites.

- [ ] **Step 2: Write the failing test**

Add to `apps/mobile/src/lib/settings.test.ts` (match the file's existing setup — it already has AsyncStorage mocking; follow how `autoTranscribeOnSave` is tested):

```ts
it("defaults useExistingTagsForAutoTag to true", async () => {
  const settings = await getSettings();
  expect(settings.useExistingTagsForAutoTag).toBe(true);
});

it("round-trips useExistingTagsForAutoTag when disabled", async () => {
  await savePersistedOnly({ useExistingTagsForAutoTag: false });
  const settings = await getSettings();
  expect(settings.useExistingTagsForAutoTag).toBe(false);
});
```

And in `apps/mobile/src/lib/settingsTransfer.test.ts`, guarding the :196 trap — mirror however that file already exercises `autoTranscribeOnSave`:

```ts
it("carries useExistingTagsForAutoTag through an export/import round-trip", async () => {
  const exported = await buildSettingsTransfer({
    ...baseSettings,
    useExistingTagsForAutoTag: false,
  });
  expect(isValidTransfer(exported)).toBe(true);
  expect(exported.settings.useExistingTagsForAutoTag).toBe(false);
});
```

Use the real exported names from `settingsTransfer.ts` — read it first; the names above describe the roles, not necessarily the exact identifiers.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm -w @carnet/mobile test -- settings`
Expected: FAIL — `useExistingTagsForAutoTag` is `undefined`, and `tsc` flags it as not on `Settings`.

- [ ] **Step 4: Write the implementation**

In the `Settings` interface, next to `autoTranscribeOnSave`:

```ts
  /** When true, capture prompts are given the vault's existing tag vocabulary
   * so auto-tagging reuses curated tags instead of minting near-duplicates
   * (`dev` vs `development`). Default true — the hint is best-effort and
   * costs nothing when no index is cached. Turn off to get the pre-v0.12
   * behavior of tagging purely from content. */
  useExistingTagsForAutoTag: boolean;
```

In `DEFAULT_PERSISTED`:

```ts
  useExistingTagsForAutoTag: true,
```

Then work through the remaining sites from Step 1 — the `PersistedSettings` type, the migration/merge points, the transfer shape, and the `settingsTransfer.ts` validation guard.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm -w @carnet/mobile test -- settings && npm -w @carnet/mobile run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/settings.ts apps/mobile/src/lib/settings.test.ts
git commit -m "feat(tags): add useExistingTagsForAutoTag setting, default on"
```

---

### Task 3: Apply the hint in `llmClient.ts`

**Files:**
- Modify: `apps/mobile/src/lib/llmClient.ts` (`enrichIdea` :326, `enrichJournal` :~350, `enrichPerson` :~373, `enrichSharedImage` :~405, `enrichSharedLink` :~572)
- Test: `apps/mobile/src/lib/llmClient.test.ts`

**Interfaces:**
- Consumes: `withTagHint(system, availableTags)` from **`./prompts`** (Task 1) — importing it from `./vaultTagHint` drags `./vault` → `expo-modules-core` into llmClient and breaks all four of its suites.
- Produces: each of the five enrich functions gains a trailing optional parameter `availableTags: string[] = []`, e.g.
  `enrichIdea(text: string, config: ProviderConfig, override?: string, availableTags?: string[]): Promise<EnrichResult>`.
  The default `[]` keeps every existing call site and test compiling unchanged.

The hint must be applied **after** the override splice in all five. Four use `withSystemOverride` and produce a `PromptPair`; `enrichSharedImage` splices inline because its user content is multimodal.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/lib/llmClient.test.ts`, following the file's existing fetch-mocking pattern (inspect how a current `enrichIdea` test asserts on the request body, and mirror it):

```ts
it("appends the vault tag vocabulary to the system prompt", async () => {
  const body = await captureRequestBody(() =>
    enrichIdea("some idea", testConfig, undefined, ["dev", "journal"]),
  );
  const system = body.messages.find((m: { role: string }) => m.role === "system").content;
  expect(system).toContain("dev, journal");
});

it("leaves the system prompt untouched when no tags are supplied", async () => {
  const body = await captureRequestBody(() => enrichIdea("some idea", testConfig));
  const system = body.messages.find((m: { role: string }) => m.role === "system").content;
  expect(system).not.toContain("This vault already uses these tags");
});

it("keeps the tag hint when the user has overridden the system prompt", async () => {
  const body = await captureRequestBody(() =>
    enrichIdea("some idea", testConfig, "My own instructions.", ["dev"]),
  );
  const system = body.messages.find((m: { role: string }) => m.role === "system").content;
  expect(system).toContain("My own instructions.");
  expect(system).toContain("dev");
});

it("appends the tag hint to the multimodal shared-image system message", async () => {
  const body = await captureRequestBody(() =>
    enrichSharedImage(
      { base64: "AAAA", mimeType: "image/png", context: "" },
      testVisionConfig,
      undefined,
      ["dev"],
    ),
  );
  const system = body.messages.find((m: { role: string }) => m.role === "system").content;
  expect(system).toContain("dev");
});
```

If `captureRequestBody` does not already exist in that test file, write it as a local helper that installs a `vi.fn()` on `global.fetch`, runs the callback, and returns `JSON.parse(fetchMock.mock.calls[0][1].body)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm -w @carnet/mobile test -- llmClient`
Expected: FAIL — the system message has no hint text (and `tsc` rejects the 4th argument).

- [ ] **Step 3: Write the implementation**

Add the import at the top of `llmClient.ts`:

```ts
import { withTagHint } from "./prompts";
```

For each of the four `PromptPair` entry points, thread the parameter and wrap. `enrichIdea` becomes:

```ts
export async function enrichIdea(
  text: string,
  config: ProviderConfig,
  override?: string,
  availableTags: string[] = [],
): Promise<EnrichResult> {
  const model = assertModelConfigured(config.model, config.label);
  const base = withSystemOverride(buildIdeaPrompt(text), override);
  // Hint goes on the FINAL system string: withSystemOverride replaces the
  // whole message, so hinting before the override would lose it.
  const pair = { ...base, system: withTagHint(base.system, availableTags) };
  return chatCompletion(
    config.baseUrl,
    config.apiKey,
    model,
    pair,
    "idea",
    config.label,
    resolveEnrichmentTimeoutMs(config.baseUrl),
    config.allowInsecureTransport ?? false,
  );
}
```

Apply the identical `const pair = { ...base, system: withTagHint(base.system, availableTags) }` shape to `enrichJournal`, `enrichPerson`, and `enrichSharedLink`, renaming their existing `pair` binding to `base`.

For `enrichSharedImage`, which splices inline, change:

```ts
  const systemOverride = override?.trim() ?? "";
  const system = systemOverride || defaultSystem;
```

to:

```ts
  const systemOverride = override?.trim() ?? "";
  const system = withTagHint(systemOverride || defaultSystem, availableTags);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm -w @carnet/mobile test -- llmClient && npm -w @carnet/mobile run typecheck`
Expected: PASS. `prompts.test.ts` must be **unaffected** — if it fails, the hint was wrongly put in a builder; move it back to the entry point.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/llmClient.ts apps/mobile/src/lib/llmClient.test.ts
git commit -m "feat(tags): apply vault tag hint after prompt override in llmClient"
```

---

### Task 4: Resolve and thread the tag list in `dispatcher.ts`

**Files:**
- Modify: `apps/mobile/src/lib/dispatcher.ts` (`enrichIdea` :289, `enrichJournal` :297, `enrichPerson` :308, plus the shared-image and shared-link equivalents further down)
- Test: `apps/mobile/src/lib/dispatcher.test.ts`

**Interfaces:**
- Consumes: `getVaultTagStrings()` (Task 1), `Settings.useExistingTagsForAutoTag` (Task 2), the 4-arg enrich signatures (Task 3).

The list is fetched **inside the existing `Promise.all`** so it adds no serial latency, then gated at the point of use.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/lib/dispatcher.test.ts`, following its existing mocking of `./settings` and `./llmClient`:

```ts
it("passes the vault tag vocabulary to llmClient when the setting is on", async () => {
  vi.mocked(getSettings).mockResolvedValue({
    ...baseSettings,
    useExistingTagsForAutoTag: true,
  });
  vi.mocked(getVaultTagStrings).mockResolvedValue(["dev", "journal"]);
  await enrichIdea("text");
  expect(llmClient.enrichIdea).toHaveBeenCalledWith(
    "text",
    expect.anything(),
    undefined,
    ["dev", "journal"],
  );
});

it("passes an empty list when the setting is off", async () => {
  vi.mocked(getSettings).mockResolvedValue({
    ...baseSettings,
    useExistingTagsForAutoTag: false,
  });
  vi.mocked(getVaultTagStrings).mockResolvedValue(["dev", "journal"]);
  await enrichIdea("text");
  expect(llmClient.enrichIdea).toHaveBeenCalledWith(
    "text",
    expect.anything(),
    undefined,
    [],
  );
});
```

Add `vi.mock("./vaultTagHint", () => ({ getVaultTagStrings: vi.fn() }))` alongside the file's existing mocks.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm -w @carnet/mobile test -- dispatcher`
Expected: FAIL — `llmClient.enrichIdea` called with 3 arguments, not 4.

- [ ] **Step 3: Write the implementation**

Add the import:

```ts
import { getVaultTagStrings } from "./vaultTagHint";
```

Rewrite each of the five dispatcher enrich functions on this template (`enrichIdea` shown; apply the same shape to the other four, passing `availableTags` as the trailing argument to the corresponding `llmClient.*` call):

```ts
export async function enrichIdea(text: string): Promise<EnrichResult> {
  // vaultTags is fetched in parallel rather than after the settings read: it
  // is a cached AsyncStorage read that never scans the vault, so this costs
  // nothing, and gating it on the setting afterwards keeps capture latency flat.
  const [settings, overrides, vaultTags] = await Promise.all([
    getSettings(),
    getPromptOverrides(),
    getVaultTagStrings(),
  ]);
  const availableTags = settings.useExistingTagsForAutoTag ? vaultTags : [];
  const outcome = await withFallbackChain(settings, settings.activeProviderId, (config) =>
    llmClient.enrichIdea(text, config, overrides.idea, availableTags),
  );
  return withFallbackMarker(outcome);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm -w @carnet/mobile test -- dispatcher && npm -w @carnet/mobile run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/dispatcher.ts apps/mobile/src/lib/dispatcher.test.ts
git commit -m "feat(tags): thread vault tag vocabulary through the dispatcher"
```

---

### Task 5: Settings toggle UI

**Files:**
- Modify: whichever component owns the sibling `autoTranscribeOnSave` switch. Find it first:
  `grep -rn "autoTranscribeOnSave" apps/mobile/src --include=*.tsx`
- Test: the co-located `*.test.tsx` for that component, if one exists.

**Interfaces:**
- Consumes: `Settings.useExistingTagsForAutoTag` (Task 2).

- [ ] **Step 1: Locate the sibling switch**

Run: `grep -rn "autoTranscribeOnSave" apps/mobile/src --include=*.tsx`
Read the surrounding block. Copy its exact structure — `List.Item` + `Switch`, the save-on-toggle handler, and how it reads initial state. Do not invent a new pattern.

- [ ] **Step 2: Write the failing test**

In that component's test file, mirror an existing switch test:

```tsx
it("renders the vault-tag-reuse toggle", async () => {
  render(<TheComponent {...props} />);
  expect(await screen.findByText("Reuse existing vault tags")).toBeTruthy();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm -w @carnet/mobile test -- <that test file>`
Expected: FAIL — the label is not rendered.

- [ ] **Step 4: Add the toggle**

Add a row modelled exactly on the `autoTranscribeOnSave` row:

- Title: `Reuse existing vault tags`
- Description: `Show auto-tagging the tags your vault already uses, so it reuses "dev" instead of adding "development".`
- Bound to `useExistingTagsForAutoTag`, saved through the same persistence call the sibling row uses.

- [ ] **Step 5: Run the tests, typecheck and lint**

Run: `npm -w @carnet/mobile test && npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src
git commit -m "feat(tags): add Settings toggle for vault tag reuse"
```

---

### Task 6: Full gate, docs, PR

**Files:**
- Modify: `TODO.md`, `.claude/PRPs/plans/vault-tag-awareness.plan.md` (this file)

- [ ] **Step 1: Run the full gate**

```bash
npm run build:shared
npm -w @carnet/shared test && npm -w @carnet/shared run typecheck
npm -w @carnet/mobile test && npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint
npm -w @carnet/mobile run verify:capture-flow
```
Expected: all PASS.

- [ ] **Step 2: Record the outcome in `TODO.md`**

Add an entry recording that S3 landed, naming the PR, and stating the three things a future reader must not re-litigate: the canonicalizer is deliberately deferred, the PRD's SAF-scan risk was already retired, and only five prompts emit tags. Mark it explicitly as **awaiting on-device verification** — do not write it up as fully shipped yet. Follow the existing entries' style; they are detailed on purpose.

- [ ] **Step 3: Set this plan to `in-progress`**

Change `Status: draft` to `Status: in-progress` in this file. **Do not flip it to `shipped` and do not `git mv` it to `completed/` yet** — that happens in Step 6, after the device evidence exists.

> Why the order matters: this repo has been bitten repeatedly by paperwork that says "shipped" while device verification is still outstanding — it is the single most common drift pattern in its history, and the 2026-09-08 handoff calls it out directly. `Status: in-progress` is the honest state for code that is merged but unverified on hardware.

- [ ] **Step 4: Commit and open the PR**

```bash
git add -A
git commit -m "docs(tags): record vault tag awareness progress"
git push -u origin feat/vault-tag-awareness
gh pr create --base main --title "feat(tags): vault tag awareness (v0.4 S3)"
```

- [ ] **Step 5: On-device verification (cannot be done in tests)**

`docs/smoke-test.md` is the manual checklist. The specific things unit tests structurally cannot cover:
1. With a real Syncthing vault and a warm index, capture an idea whose content matches an existing tag — confirm the emitted frontmatter reuses the existing tag rather than a near-duplicate.
2. Toggle the setting off, repeat — confirm the hint is gone (the model tags purely from content).
3. Cold-start with cleared app storage and capture immediately — confirm the capture is **not** slowed waiting on a vault walk, and simply gets no hint.
4. Repeat (1) against a **local Relais** provider — the small-model case is where a soft hint is most likely to be ignored, and is the main signal for whether the deferred canonicalizer is needed.
5. Observe what `getVaultTagStrings()` actually returns on the real vault. `MAX_HINT_TAGS = 50` is untested against real data: under 50 tags and the cap never engages (an unexercised branch), well over 50 and it may be truncating tags worth reusing. Record the real tag count and revisit the constant if warranted.

Record the results in a `docs/session-handoffs/` entry.

#### Attempt 2 — 2026-09-12 — **check 1's plumbing RESOLVED: the hint IS sent**

Attempt 1 could not tell "Carnet never sends the vocabulary" from "the small model
ignored it". Settled by instrumentation rather than more sampling: a temporary
`console.warn` in `dispatcher.enrichIdea` (release builds strip no console — there is
no `transform-remove-console` in this project), logging the setting, what
`getVaultTagStrings()` returned, and what was actually passed down. Reverted
immediately after; it is in no commit.

```
[tagHintDiag] setting=true vaultTags=10 sending=10 sample=qa|final|local-model|mesh|networking|offline
```

Reproduced on a second cold launch. So on a real device: the setting is on, the
**cached** tag index yields 10 tags, and all 10 are handed to `llmClient`. The
wiring works end to end — `loadCachedTagIndex()` is warm at capture time, which was
the main device-specific risk and the one unit tests cannot cover.

**BENEFIT IS UNMEASURED. The experiment was invalid — corrected 2026-09-12.**

An earlier revision of this section claimed the hint had a weak effect and pointed at
the canonicalizer as the likely fix. That was wrong, in the expensive direction. Three
defects in the test, each enough on its own:

1. **The discriminator was never in the vocabulary.** `NOTE_SUBDIRS` is
   `["Ideas","Journal","Notes","People"]` — `Archive/` is **not indexed**. The chosen
   discriminator `wifi` exists only in `Archive/wifi-disabled-isolation-test-…md`, so
   the app could never offer it. The vocabulary actually sent contained **`wi-fi`**,
   and the model emitted `Wi-Fi`, which `normalizeTag` folds to `wi-fi` — **exact
   reuse**, scored as a failure. The full indexed set, matching `vaultTags=10`:
   `qa, testing, offline-model, offline, local-model, final, networking, mesh, wi-fi,
   troubleshooting`.
2. **The vocabulary was self-poisoned.** The v0.11.0 baseline capture is what created
   `mesh`/`networking`/`wi-fi`/`troubleshooting` in the index. From capture #2 onward
   the model was handed its own prior output as "the vault's vocabulary" and
   reproduced it verbatim — which cannot distinguish reuse from repetition.
3. **n was overstated.** Only `-2.md` enriched on the hint build. `-3.md` and `-4.md`
   stalled at `pending-enrich` (Relais frozen) and never completed. One sample, not
   three. The direct-API arm used a hand-written vocabulary that did not match what
   the app sends, so it measured a different system.

**Do not cite this attempt as evidence for or against the canonicalizer.** The honest
state is: plumbing verified, benefit not yet measured.

**Preconditions for attempt 3** (not tidiness — the test is invalid without them):
- **Delete the poisoning notes first:**
  `Ideas/my-home-mesh-access-points-hand-off-badly-…{,-2,-3,-4}.md`. While they exist
  the index still holds `mesh`/`wi-fi`/`troubleshooting` and the next run repeats this.
- Pick the discriminator **from what the app actually sends** — read `vaultTags` via
  the diagnostic, or enumerate tags under the four indexed subdirs. Never from a
  hand-written list, and never from `Archive/`.
- Choose capture text whose expected tags are **already in the index and were not
  created by this experiment**, e.g. something about QA of an offline local model
  (`qa`, `testing`, `offline-model`, `local-model` all predate this work).
- Enrich every sample to completion before scoring; a `pending-enrich` note is not a
  data point.

**Separate finding worth its own decision: `Archive/` tags are invisible to the hint.**
A user who archives notes loses that vocabulary, so auto-tagging can re-mint a tag the
vault already used before archiving. That follows from `NOTE_SUBDIRS` and is not a bug
in this feature, but it is a real limit on it and was not considered in the PRD.

Also worth noting for anyone re-running: Android **froze Relais** as a cached app
(`ActivityManager: freezing com.ventouxlabs.relais.izzy`), which is what actually
stopped it serving — read alongside the thermal shedding from attempt 1, not instead
of it.

**Still not run, and why:** the device is **physically folded shut and locked**
(`dumpsys device_state` → `mCommittedState = CLOSED`, `mDreamingLockscreen=true`).
`adb install` and `monkey` launches work in that state, but taps and swipes do not,
so anything needing the UI is blocked on physical access:
- check 2 (toggle off ⇒ `sending=0`) — needs the toggle tapped. The gate is a
  one-line ternary with unit coverage, and `setting=true ⇒ sending=10` is confirmed;
  only the `false` arm is unobserved on-device.
- check 3 (cold start not slowed) — needs the UI and is destructive.
- more model-compliance samples — need Relais restarted, which needs the UI.

Dead ends, recorded so they are not retried: `QuickIdeaTaskService` is not exported
(`Error: Requires permission not exported from uid`), so the headless capture path
cannot be driven from `adb`; `RemoteInput` results cannot be synthesised via
`am broadcast`; and the release build is not debuggable with no root, so `run-as`
and direct AsyncStorage reads are both unavailable. The console-log route was the
only one that worked, and it was enough.

#### Attempt 1 — 2026-09-11, Pixel 10 Pro Fold (rango), Android 17 — **INCOMPLETE**

Build: release-signed APK from `feat/vault-tag-awareness`, versionCode 9, installed
over the existing release install (no uninstall, no data loss). Provider: **Relais
(local)**, `http://127.0.0.1:8080`, model `litert-community/gemma-4-E2B-it-litert-lm`
on the Tensor G5 — i.e. the small on-device model, the hardest case for a soft hint.

| Check | Result |
|---|---|
| 1. Reuse against a warm index | **INCONCLUSIVE — see below** |
| 2. Toggle suppresses the hint | **NOT RUN** (blocked by 1) |
| 3. Cold start not slowed | **NOT RUN** (destructive; deferred) |
| 4. Local Relais small model | **PARTIAL** — everything ran on Relais/Gemma |
| 5. What `getVaultTagStrings()` returns | **DONE** |
| Task 5 toggle renders | **PASS** — on by default, correct copy/icon |

**Check 5 (done).** The device vault holds 7 notes, ~16 distinct tags after
normalization. **`MAX_HINT_TAGS = 50` never engages on this vault** — the cap is an
unexercised branch here, not a verified one. The vault does contain real sprawl
(`QA`/`testing`, `offline`/`offline-model`/`local-model`, `feature`/`feature
verification`, and `LLM`/`llm` — the last confirming `normalizeTag` case-folding
collapses to one index entry on real data).

**Check 1 (inconclusive) — the open question.** Baseline on v0.11.0 (no hint) and two
captures on the new build produced the **identical** tag set:
`[networking, mesh, Wi-Fi, troubleshooting]`. Note `Wi-Fi` normalizes to `wi-fi`
while the vault already carries `wifi` — a near-duplicate being minted, i.e. exactly
the sprawl this feature exists to stop.

But a direct A/B against the same model (bypassing the app, same system prompt, only
the hint block differing) showed the model **does** honor the hint:

- no hint  → `tags: [networking, mesh, Wi-Fi, troubleshooting]`
- with hint → `tags: [idea, networking, mesh, wifi, troubleshooting]`  ← `wifi` reused

So the model complies when the hint is present, yet the in-app capture behaved as if
it were absent. **Whether Carnet actually sends the hint on-device is UNRESOLVED.**
Do not read the green unit tests as settling this — they assert the wiring, not that
`getVaultTagStrings()` returns a non-empty list at capture time on a real device.

Ruled out so far:
- The setting was on (toggle verified on screen, default true).
- `CaptureScreen` uses `upsertNoteInIndex`, **not** `invalidateNoteIndex`, so the
  save-first write does not wipe the cache before enrichment (first hypothesis, wrong).
- The note index cache is warm — Home renders per-card tags from `loadCachedNoteIndex()`,
  the cached read, and it rendered them.
- Sample size is weak: 2 in-app runs, 1 direct sample per arm. Gemma is stochastic.

**What would settle it:** observe the actual request. The intended method — point the
provider Base URL at a host-side logging proxy via `adb reverse` — failed for two
environmental reasons, neither of them a product defect: host port 9090 was already
occupied, and editing the Relais preset's Base URL **would not persist** (it reverts
to `http://127.0.0.1:8080` after Save). That non-persistence is worth a look on its
own — it may be a real bug in provider-entry editing, or an artifact of how those
edits commit versus the screen's Save button. A simpler alternative next time: add a
temporary diagnostic that logs `getVaultTagStrings().length` to the crash-log ring
buffer, visible in Settings → Diagnostics without any network instrumentation.

**Why the run stopped:** the device began thermal-shedding (Relais showed
"thermal · shedding load", then returned HTTP 503). Two queued captures stalled at
`pending-enrich`. Further model-dependent checks need a cooled device.

**Test artifacts left in the vault** (safe to delete, all the same sentence):
`Ideas/my-home-mesh-access-points-hand-off-badly-…{,-2,-3,-4}.md`.

**Automation notes for the next run** (cost real time here):
- Dismiss the keyboard **before** any `input swipe`, or glide-typing injects junk into
  the focused field — a Base URL silently became
  `http://127.0.0.1:19099 by by by by …`, which then failed to save and looked like a
  persistence bug.
- `screencap` on this fold prepends a `[Warning] Multiple displays…` strip; strip
  bytes before the PNG magic or the image won't parse.
- Run `expo prebuild` from `apps/mobile`, never the repo root — from the root it
  writes a junk `android/`+`app.json` and injects expo deps into the root
  `package.json`. A stale prebuild also pins the old `versionCode`, which surfaces as
  `INSTALL_FAILED_VERSION_DOWNGRADE` (8 vs 9), not as anything mentioning prebuild.

- [ ] **Step 6: Only now, close the plan out**

Once Step 5's four checks have actually passed on hardware and the evidence is written up:

```bash
# flip Status: in-progress → Status: shipped in this file first
git mv .claude/PRPs/plans/vault-tag-awareness.plan.md .claude/PRPs/plans/completed/
git add -A
git commit -m "docs(tags): record vault tag awareness as shipped after device verification"
```

Update the `TODO.md` entry from Step 2 in the same commit, replacing "awaiting on-device verification" with the verified result and a pointer to the handoff.

If Step 5 fails any check, the plan stays `in-progress` and the failure becomes the next task — do not close it out.

---

## Self-Review

**Spec coverage** — PRD Slate 3's five scope bullets:
1. "Reuse `getTagIndex()`; add a thin `getVaultTagStrings()`" → Task 1 (using `loadCachedTagIndex`, per the documented delta).
2. "Caching already handled; no new TTL layer" → honoured; no cache code added.
3. "All five enrich entry points thread the tag list" → Tasks 3 + 4.
4. "Prompts updated: use these tags if relevant; else create new ones" → Task 1's `withTagHint` copy.
5. "`useExistingTagsForAutoTag: boolean`, default `true`" → Tasks 2 + 5.

PRD's "background pre-warm on app launch" mitigation → deliberately **not** implemented; `HomeScreen.tsx:100-122` already does it. Documented in Deltas.

**Placeholder scan** — Task 5 names a file by `grep` rather than by path, and Task 3's test helper is conditional on what already exists in `llmClient.test.ts`. Both are inspection steps with an explicit command and an explicit pattern to copy, not deferred decisions. Every code step carries real code.

**Settings-field completeness** — Task 2 Step 1 enumerates all 11 sites the sibling boolean occupies, including the `settingsTransfer.ts:196` validation guard whose omission would silently break export/import with no failing test. Covered by the added round-trip test.

**Status-flip ordering** — the plan reaches `shipped` only in Task 6 Step 6, after on-device verification in Step 5. Merged-but-unverified is `in-progress`. This is the repo's most-repeated drift pattern and the ordering is deliberate.

**Type consistency** — `getVaultTagStrings(limit?: number): Promise<string[]>`, `withTagHint(system: string, availableTags: string[]): string`, and the trailing `availableTags: string[] = []` parameter are used identically in Tasks 1, 3 and 4. Setting name is `useExistingTagsForAutoTag` throughout.
