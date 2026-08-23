// Copyright (C) 2025 Ventoux Labs
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enhance a saved note's prose in place — rewrite the body with a (typically
 * stronger) model, leaving everything structural alone.
 *
 * Mirrors lib/noteReprocess.ts — same outcome union, same "call, splice,
 * updateNote" spine — but deliberately lives beside it rather than inside it:
 * that module scopes itself to re-running against a note's PAIRED BINARY, and
 * both its functions begin by locating one. Enhance has no binary, which is
 * exactly why it works on a text-only journal entry.
 *
 * Frontmatter and the leading `# Title` are split off BEFORE the call and
 * re-attached after, so the model never sees or rewrites them. That is what
 * keeps the byte-compatible-frontmatter constraint intact.
 */

import { enhanceProse as dispatchEnhance, FALLBACK_PROVIDER_FIELD } from "./dispatcher";
import { splitFrontmatter, upsertFrontmatterField } from "./frontmatter";
import {
  getModificationTime,
  readNote,
  updateNoteIfUnchanged,
} from "./writer";

/** Frontmatter field stamped on a note whose prose has been enhanced. Its
 * presence is the only on-disk signal that a body is machine-polished — the
 * original wording is not recoverable from the note itself. */
export const ENHANCED_FIELD = "enhanced";

/**
 * Below this many characters of prose there is nothing worth spending a model
 * call on, and an near-empty body is the case most likely to make a model
 * invent content to fill the space — the one failure this prompt must never
 * have. Rejected before the call, not after.
 */
const MIN_PROSE_CHARS = 40;

/**
 * Outcome of an enhance attempt:
 *   - updated: the note was rewritten in place; `nextBody` is the new content.
 *   - failed:  nothing was written; `reason` is the user-facing message.
 */
export type EnhanceProseOutcome =
  | { kind: "updated"; nextBody: string; providerLabel: string }
  | { kind: "failed"; reason: string };

/** Local-date YYYY-MM-DD. toISOString() would return UTC and shift a
 * late-evening enhance (e.g. 11pm in UTC-8) onto the next day — the same trap
 * prompts.ts documents for capture dates. */
function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Split a body into its leading `# Title` line (with the blank lines that
 * follow it) and the prose beneath. `title` is "" when the body has no
 * leading H1, in which case the whole body is prose.
 *
 * Only a top-level `# ` heading counts: `##` and deeper are section headings
 * that belong to the prose and must be handed to the model with it. Hence the
 * mandatory space/tab after the hash — it is what makes `##` fall through.
 *
 * Leading blank lines are tolerated and captured INTO `title`, so they survive
 * reassembly byte-for-byte. That matters more than it looks: splitFrontmatter
 * ends its header at the newline closing `---`, so a note written as
 * `---\n…\n---\n\n# Title` (the layout Obsidian produces) hands this function a
 * body starting with a blank line. An anchored `^#` missed it, the title went
 * to the model as prose, and the prompt's "do NOT add a title or heading" rule
 * meant the model dutifully deleted it — silent title loss on every such note.
 * Found by an independent review pass, 2026-08-05.
 */
export function splitLeadingTitle(body: string): { title: string; prose: string } {
  // (blank lines)* then up to 3 spaces of indent (CommonMark's ATX allowance),
  // then `# ` — the space is what keeps `##` and deeper out.
  // Every newline is `\r?\n`, including the trailing run — a bare `\n+` there
  // keeps only half of a CRLF blank line, splitting `\r\n\r\n` into title
  // `…\r\n` + prose `\r\nbody`. CRLF reaches the vault via Syncthing from a
  // Windows workstation, so this is not hypothetical.
  const match = body.match(
    /^((?:[ \t]*\r?\n)*[ \t]{0,3}#[ \t][^\r\n]*(?:\r?\n)+)([\s\S]*)$/,
  );
  return match ? { title: match[1], prose: match[2] } : { title: "", prose: body };
}

/** A line that is solely a `../{Photos|Audio|Files}/…` embed or link. Mirrors
 * the matcher in writer.ts's stripPairedBinaryLinks — keep the two in step. */
const PAIRED_LINK_LINE = /^!?\[[^\]]*\]\(\.\.\/(?:Photos|Audio|Files)\/[^)]+\)$/;

/**
 * Pull paired-binary link lines out of the prose so they are never handed to
 * the model.
 *
 * Without this, an image embed sitting in the body ("![](../Photos/x.jpg)")
 * reaches a model instructed to return *only* enhanced prose — which drops it.
 * The .jpg then survives on disk as an orphan while the note silently loses its
 * only reference to it. That is data loss, and it is not hypothetical: it is
 * the shape of every photo-bearing journal entry in the vault.
 * `noteReprocess.reEnrichNote` guards the same hazard by re-injecting the embed
 * after its LLM call (see writer.ts's injectImageEmbed); this is that guard for
 * a body that may hold several attachments of any kind.
 *
 * Returns the extracted lines in their original order plus the remaining prose,
 * with the blank runs left behind by the removal collapsed.
 */
export function extractAttachmentLines(prose: string): {
  attachments: string[];
  rest: string;
} {
  const attachments: string[] = [];
  const kept = prose.split("\n").filter((line) => {
    if (!PAIRED_LINK_LINE.test(line.trim())) return true;
    attachments.push(line.trim());
    return false;
  });
  const rest = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  return { attachments, rest };
}

/** URL run, stopping before markdown/sentence punctuation that commonly
 * trails a link rather than belonging to it. */
const URL_RE = /https?:\/\/[^\s)<>\]]+/g;

/** Trailing characters that are punctuation around a link, not part of it. */
const TRAILING_PUNCT = /[.,;:!?]+$/;

function urlsIn(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(TRAILING_PUNCT, ""));
}

/**
 * URLs present in the source prose but missing from the model's output.
 *
 * Prompt rule 5 tells the model to preserve links verbatim, but a prompt is a
 * request, not a guarantee: on 2026-08-05 a live run dropped all three links
 * from a real vault note (a Google Maps short-link and an org homepage) while
 * happily obeying every formatting rule. A maps short-link like
 * `.../QbZYrjdUBukFu9Uu7` cannot be reconstructed once lost, so this is a
 * deterministic backstop rather than a nicety — the same reasoning that makes
 * extractAttachmentLines hold embeds back instead of asking for them.
 */
export function droppedUrls(source: string, enhanced: string): string[] {
  const after = new Set(urlsIn(enhanced));
  const seen = new Set<string>();
  return urlsIn(source).filter((u) => {
    if (after.has(u) || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/**
 * Strip dangling inline citation markers (`[1]`, `[3]`) from model output.
 *
 * Perplexity-family models (sonar-reasoning-pro and friends) cite sources with
 * inline numeric markers and return the matching URLs in a separate
 * `annotations` field. Verified against the gateway on 2026-08-08: those
 * annotations ARE present on a streaming response but are dropped when the
 * non-streaming OpenAI shape is assembled, which is the shape this client uses.
 * So the markers arrive pointing at nothing — `[8]` with no `[8]` to follow.
 * Dangling references in a permanent note are worse than no references.
 *
 * Deliberately narrow. Only a bracketed 1-3 digit number NOT followed by `(`,
 * which leaves markdown links (`[label](url)`), numeric-labelled links
 * (`[1](https://…)`) and task boxes (`- [ ]`, `- [x]`) untouched.
 *
 * REMOVE THIS once the gateway passes annotations through: at that point the
 * markers become resolvable and should be kept and linked, not deleted.
 */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(/\[\d{1,3}\](?!\()/g, "")
    // Markers usually sit before punctuation ("...Pennsylvania[1].") or in runs
    // ("[1][3]"), so removing them leaves stray gaps. Tidy only that damage.
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

/**
 * Stamp provenance onto a note that already carries frontmatter.
 *
 * Only stamps when a frontmatter block is present: upsertFrontmatterField
 * CREATES one when absent, and silently growing a `---` block onto a note that
 * never had one would be a structural change to a file this feature promises
 * only to reword.
 */
function stampProvenance(
  markdown: string,
  outcome: { usedFallback: boolean; fallbackProviderId: string | null },
): string {
  const { header } = splitFrontmatter(markdown);
  if (!header) return markdown;
  const stamped = upsertFrontmatterField(markdown, ENHANCED_FIELD, todayLocal());
  if (!outcome.usedFallback || !outcome.fallbackProviderId) return stamped;
  return upsertFrontmatterField(stamped, FALLBACK_PROVIDER_FIELD, outcome.fallbackProviderId);
}

/**
 * Rewrite `input.body`'s prose and persist it to `input.filepath`.
 *
 * Never throws — every failure path (too short, empty model response, network
 * error, write error) returns a `failed` outcome and leaves the note on disk
 * exactly as it was.
 */
export async function enhanceNoteProse(input: {
  body: string;
  filepath: string;
}): Promise<EnhanceProseOutcome> {
  try {
    // Baseline BEFORE the model call, then transform the file's CURRENT
    // content rather than the caller's snapshot — the same shape
    // promoteIdeaOnDisk uses, and for the same reason. Two distinct races,
    // both real:
    //   - the caller's `input.body` is whatever the screen loaded, which may
    //     already be stale if the note was edited in Obsidian or synced since;
    //     re-reading means we enhance what is actually on disk.
    //   - the model call can take up to ENHANCE_TIMEOUT_MS (120s), a wide
    //     window for an edit to land mid-flight; the mtime guard turns that
    //     into a reported conflict instead of a silent clobber.
    // Observed live 2026-08-05: a note was edited on-device while an Enhance
    // was in flight. The unguarded write would have discarded those edits.
    const baseline = await getModificationTime(input.filepath);
    let source = input.body;
    // Only a disk read is a valid content baseline for the SAF guard (there is
    // no mtime there); the caller's copy may already be stale.
    let expectedContent: string | null = null;
    try {
      source = await readNote(input.filepath);
      expectedContent = source;
    } catch {
      // Unreadable (SAF quirk, moved file) — fall back to the caller's copy,
      // exactly as promoteIdeaOnDisk falls back to its passed markdown. The
      // mtime guard below still protects the write.
    }

    const { header, body } = splitFrontmatter(source);
    const { title, prose } = splitLeadingTitle(body);
    // Attachments are held back from the model and re-attached below — see
    // extractAttachmentLines for why losing them would be data loss. The
    // length guard then runs on `rest`, so an image-only note (no real prose)
    // is correctly refused rather than sent off to be "enhanced" into text.
    const { attachments, rest } = extractAttachmentLines(prose);
    if (rest.trim().length < MIN_PROSE_CHARS) {
      throw new Error("This note is too short to enhance — add some prose first.");
    }

    const outcome = await dispatchEnhance(rest);
    // Already fence-stripped AND security-sanitized upstream: executeChat runs
    // stripCodeFences, then sanitizeAndNormalize(...) ?? sanitizeMarkdown(...),
    // and prose-only output falls through to the latter because
    // normalizeFrontmatter bails on a missing header. Re-sanitizing here would
    // be redundant, and reaching for sanitizeMarkdown to strip fences would be
    // wrong — it preserves fence bodies verbatim by design.
    const cleaned = stripCitationMarkers(outcome.result.markdown.trim()).trim();
    if (!cleaned) {
      throw new Error("The model returned nothing — the note was left unchanged.");
    }

    // Attachments go back directly under the title, matching where
    // writer.ts's injectImageEmbed puts one. For a note with several inline
    // images this collects them above the prose rather than restoring their
    // exact interleaving — a deliberate trade: a moved embed is cosmetic, a
    // dropped one is data loss.
    const attachBlock = attachments.length > 0 ? `${attachments.join("\n")}\n\n` : "";
    // Backstop only: this section appears solely when the model ignored prompt
    // rule 5 and dropped a link. Appending is the only recovery a deterministic
    // check can offer — it cannot know where in the new prose the link belonged
    // — but a relocated link beats an unrecoverable one.
    const lost = droppedUrls(rest, cleaned);
    const linkBlock =
      lost.length > 0 ? `\n\n## Links\n${lost.map((u) => `- <${u}>`).join("\n")}` : "";
    // header already carries its own trailing newline (see splitFrontmatter),
    // as does title, so neither needs a separator added here.
    const next = stampProvenance(
      `${header}${title}${attachBlock}${cleaned}${linkBlock}\n`,
      outcome,
    );
    const written = await updateNoteIfUnchanged(
      input.filepath,
      next,
      baseline,
      expectedContent,
    );
    if (!written.ok) {
      // The note moved under us. Keep the user's version — an enhancement is
      // regenerable, their edit is not.
      throw new Error(
        "This note changed while Enhance was running, so your version was kept. Try again.",
      );
    }
    return { kind: "updated", nextBody: next, providerLabel: outcome.providerLabel };
  } catch (err: unknown) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : "Enhance failed.",
    };
  }
}
