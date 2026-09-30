# B3 Sanitizer Hardening — Implementation Plan

Status: in-progress

**Approved:** 2026-09-30

**Goal:** Close the pre-existing B3 bypasses (`lib/enrichSanitize.ts`) and two
adjacent weaknesses (prompt overrides that drop `INJECTION_GUARD`, and `file://`
create-only writes that race). All six were surfaced by the security review of
the Note-capture branch (#222). They affect every capture mode, not Note mode,
so they ship as their own PR from `main`.

**Evidence:** an architect mapped every item against `main` @ `12ab026` and
confirmed each repro by running the real module. The item numbers below follow
that mapping.

## Decisions (the human's, 2026-09-30)

1. **Strict frontmatter allowlist.** Model output keeps only
   `CANONICAL_ORDER[noteType]` keys, on BOTH branches of `llmHttp.ts`'s
   `sanitizeAndNormalize(...) ?? sanitizeMarkdown(...)`. Today the fallback
   branch ships an unfiltered `dg-publish: true` when the reply omits a
   required key.
   - Custom keys requested through a prompt override are dropped; the override
     help text says so.
   - Shared notes get no `url`/`source`; the link is already in the body.
   - App-owned keys are untouched, because they are all added after
     normalization: `location`, `rev`, `status: pending-enrich`, the tag merge,
     `fallback`, `enhanced`, `karakeepId`, preserved user fields.
   - `promoteIdea` preserves its `fallback` marker explicitly.
2. **Inline Dataview spans are made inert, not deleted.** The span's text stays
   visible, but changed so Dataview's `innerText.trim().startsWith(prefix)` no
   longer matches, e.g. `` `= this.file.name` `` becomes
   `` `inert: = this.file.name` ``. This extends B3's "neutralize, don't delete"
   policy. Tests pinning `[inline dataview removed]` are updated to the new form.
3. **Include the four extra bypasses** found in the same functions:
   - fences with CRLF line endings
   - fences inside callouts or after a list marker
   - indented or invalid fake fence openers that hide the real fences after them
   - `src="x"onerror=`, with no whitespace before `on`
4. **Custom Dataview prefixes (`.obsidian/plugins/dataview/data.json`) are
   deferred.** Only the defaults `=` and `$=` are covered. Logged in `TODO.md`.

## Design: one coherent sanitizer pass (items 1, 3, 4 + extras)

1. Normalize `\r\n?` to `\n`, then strip Templater everywhere (as now).
2. Split the frontmatter with the same rule as `frontmatter.ts`
   `splitFrontmatter`. Neutralize header lines individually, drop any header
   line matching `^---` or a fence opener, and re-emit the header with exact
   `---` delimiters (the shape of #222's `noteLineGuard.sanitizeHeader`).
3. Rename `` ``` ``/`~~~` `dataview`/`dataviewjs` fences on any line, after any
   `>`, list-marker or whitespace prefix.
4. Scan the body for fences from a clean state. Skip neutralization only inside
   *certain* fences: an opener indented ≤3 spaces, with no backtick in a
   backtick fence's info string.
5. Inline code: a left-to-right tokenizer pairs backtick runs of equal length
   (CommonMark), and makes a span inert when its content, after `trimStart`,
   starts with `=` or `$=`. A regex can't pair spans.
6. Iterate steps 2–5 to a fixed point, capped at 8 passes. At the cap, fail
   closed: escape `<` and break up backtick runs. Never return the last
   iteration.
7. The `on*=` attribute rule also fires after a quote (`"x"onerror=`).

Canonical notes stay byte-identical. No vault or omniroute fixture changes
bytes; that's verified in the differential below.

## Commits (test-first; each ends with the mobile gate green)

1. `test(sanitize)`: RED cases in a new `enrichSanitize.security.test.ts`,
   added to `verify:capture-flow`. Covers every repro in the mapping (items
   1–4 and the extras), plus a property test `s(s(x)) === s(x)` over the
   existing sanitizer corpus.
2. `fix(sanitize)`: LF normalization, the frontmatter split, and the fence
   rules (design steps 1–4, 7).
3. `fix(sanitize)`: fixed-point iteration with a fail-closed cap (step 6).
4. `fix(sanitize)`: inline-span tokenizer; spans made inert (step 5,
   decision 2).
5. `fix(sanitize)`: strict key allowlist on both `llmHttp.ts` branches via
   `filterFrontmatterKeys(md, noteType)`, plus `promoteIdea` preserving
   `fallback` (decision 1).
6. `fix(llm)`: `withInjectionGuard(system)` exported from `prompts.ts`, used in
   `withSystemOverride` and in the shared-image inline override splice.
   - The guard is appended unless the text already contains it.
   - Users with no override are byte-identical.
   - Update the help text in `PromptOverridesSection.tsx`.
7. `fix(writer)`: `writeUniqueFile`, which holds `serialize("dir:"+parent)`
   across choosing the name, creating and writing.
   - Every site that chooses a name and then writes goes through it: the
     `writer.ts` writers, the archive, and `vaultMigration.ts`.
   - `findCollisionFreeName`'s signature changes, so any old call pair fails
     `tsc`.
   - The key namespace is separate from `appendJournal`'s per-file key, because
     nesting the same key deadlocks.
   - Test: two concurrent same-slug writes produce two files.

## Gates

- Mobile: typecheck, lint, test, and `verify:capture-flow`.
- Shared: build and tests.
- `check-stale-plans`.
- **Byte-compat differential:** old vs new `sanitizeMarkdown` /
  `sanitizeAndNormalize` over every vault and omniroute fixture, plus the
  existing test corpus. Canonical inputs must be identical. Every difference
  must be one of the intended changes.
- Independent code review and security review before the PR.

## Merge conflicts with #222 (whichever lands second resolves them)

- `enrichSanitize.ts` type tables: #222 adds `note`. It inherits the
  allowlist, and `note`'s canonical keys come from #222.
- `noteLineGuard.withUserLines` bypasses normalization, so it needs
  `filterFrontmatterKeys(…, "note")`. Its `sanitizeHeader` may then defer to
  the new frontmatter-aware `sanitizeMarkdown`.
- `writer.ts` `writeNote` becomes a compile error until it uses
  `writeUniqueFile`. That's intended, so it can't silently stay racy.
- Textual: `apps/mobile/package.json` (`verify:capture-flow`), `prompts.ts`,
  `PromptOverridesSection.tsx`.

## Out of scope

- OCR raw text (`llmClient.ts` ~:537) only feeds `enrichPerson`, whose output
  is sanitized.
- Karakeep export sends vault content out, not into the vault.
- Custom Dataview prefixes (decision 4).

## Deviations

- RED cases were committed as `it.fails` and flipped to `it` by the commit that fixes them, so every commit's gate stays green.
- "Certain" fence is stricter than design step 4: a line skips neutralization only when three parses agree (CommonMark top level; list-item parse where a dedented line ends an indented fence; block-context parse where ``` inside an HTML block or `%%`/`$$` block is not an opener). The indent/info rules alone left list-dedent and HTML-block bypasses.
- Header lines are dropped when they start with `---` after `trimStart` (not only at column 0), matching `frontmatterInnerLines`' `trim() === "---"` closer.
- Fail-closed does more than escape `<` and break backtick runs: every backtick becomes U+02CB, the `=` after an `on*` name becomes `&#61;`, executable `~~~` fences are renamed and link rules re-run, so the fail-closed output is itself a fixed point.
- The inline tokenizer (step 5) runs per paragraph, per heuristic block and per line/table cell, each with and without backslash escapes, and a span live under any of them is made inert. A single tokenization missed spans after a heading, a blank line or a table pipe, and after an escaped backtick.
- Commit 4 also escapes raw HTML `<code` (`&lt;code`): Dataview evaluates every rendered `<code>`, so this is item 1's threat in HTML syntax.
- `promoteIdea` re-applies all of the current note's non-canonical fields (`preserveFrontmatterFields(…, CANONICAL_ORDER.idea)`, as in the mapping), not only `fallback`.
- `findCollisionFreeName`'s signature change is a branded `DirLock` first parameter, and it is no longer exported; the unused `writeBinaryBytes` helper was removed.
- Enhance and Ask now pass NoteType `null` (body-only, no frontmatter contract), in a follow-up `fix(llm)` commit. Commit 5's allowlist, applied to them as "journal", deleted the prose between two leading `---` rules in their replies. Their output lands below an app-owned header, so that block is prose, not properties.
- New finding, logged in `TODO.md` and not fixed: Dataview's default `inlineQueriesInCodeblocks: true` also evaluates a whole fenced or indented code block whose text starts with `=`/`$=`.
