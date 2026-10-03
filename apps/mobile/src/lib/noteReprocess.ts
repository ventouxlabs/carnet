// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Re-run enrichment / transcription against a note's paired binary, lifted out
 * of RecentDetailScreen. Both flows share one shape — locate the paired binary
 * link, read its bytes, call the LLM/Whisper, splice the result back into the
 * body, and rewrite the note in place — so they live together here as async
 * orchestrators (mirroring lib/ideaSaveFirst.ts). The screen keeps only its
 * in-flight-ref guards + setState wiring.
 */

import {
  injectImageEmbed,
  readPairedBinaryFromNote,
  updateNote,
  upsertSection,
} from "./writer";
import { enrichSharedImage } from "./dispatcher";
import { transcribeAudio } from "./dispatcher";
import { getFrontmatterTags, preserveFrontmatterFields } from "./frontmatter";
import { mergeUserTags } from "./tags";
import type { VaultContext } from "./vaultContext";
import type { Root } from "./vaultRoot";

/**
 * Locate the first paired-binary filename of a given subdir in a note body.
 * The link convention is `../{subdir}/{filename}`; the filename class rejects
 * `/` and whitespace so a crafted traversal link can't match out of the subdir.
 * Returns the filename (e.g. `photo.jpg`) or null when there is no such link.
 */
export function findPairedLink(body: string, subdir: string): string | null {
  const match = body.match(new RegExp(`\\.\\./${subdir}/([^/\\s)]+)`));
  return match ? match[1] : null;
}

/** Fields the old note carries that must not outlive a fresh vision reply.
 *
 * `tags` belongs to mergeUserTags: preserving it first would overwrite the
 * model's fresh tags before the merge sees them. `fallback`
 * (dispatcher.ts FALLBACK_PROVIDER_FIELD) names the provider that wrote the
 * OLD reply — re-enrich is how a user clears the "via relais" chip — and
 * `enhanced` (enhanceProse.ts ENHANCED_FIELD) vouches for a body this reply
 * replaced. Literals, not imports: dispatcher is mocked in the tests, and an
 * undefined entry would silently exclude nothing. */
const REPROCESS_OWNED_FIELDS = ["tags", "fallback", "enhanced"] as const;

/**
 * Outcome of a re-enrich / transcribe attempt:
 *   - updated: the note was rewritten in place; `nextBody` is the new content.
 *   - failed:  the flow threw (no paired binary, read error, or LLM error);
 *              `reason` is the user-facing message and nothing was written.
 */
export type ReprocessOutcome =
  | { kind: "updated"; nextBody: string }
  | { kind: "failed"; reason: string };

/**
 * Re-run vision enrichment on a note's paired image and overwrite the note with
 * the fresh result (the original image embed is re-injected). Re-enrich uses an
 * empty context — the original context-at-capture isn't recoverable from the
 * saved markdown without a brittle parse.
 *
 * The model sees only the image, so the note's own frontmatter (`location`,
 * `karakeepId`, hand-added fields, the user's tags) is carried onto its reply —
 * the same preserve → attachments → tags order as personInPlace.ts. Dropping
 * `karakeepId` would turn the next Karakeep export into a duplicate bookmark.
 */
export async function reEnrichNote(input: {
  body: string;
  filepath: string;
  vaultContext?: VaultContext;
  rootOverride?: Root;
}): Promise<ReprocessOutcome> {
  try {
    // The match also gives us the relative path to re-inject after the LLM
    // rewrites the body.
    const imageFilename = findPairedLink(input.body, "Photos");
    if (!imageFilename) {
      throw new Error(
        "No paired image found in this note — re-enrich needs the original image on disk.",
      );
    }
    const { base64, mime } = input.rootOverride
      ? await readPairedBinaryFromNote(input.body, input.rootOverride)
      : await readPairedBinaryFromNote(input.body);
    const result = await enrichSharedImage(
      { base64, mimeType: mime, context: "" },
      { vaultContext: input.vaultContext },
    );
    const preserved = preserveFrontmatterFields(
      result.markdown,
      input.body,
      REPROCESS_OWNED_FIELDS,
    );
    const withImage = injectImageEmbed(preserved, `../Photos/${imageFilename}`);
    const next = mergeUserTags(withImage, getFrontmatterTags(input.body));
    await updateNote(input.filepath, next);
    return { kind: "updated", nextBody: next };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[RecentDetail] re-enrich failed:", reason);
    return { kind: "failed", reason };
  }
}

/**
 * Transcribe a note's paired audio and upsert the text under a `## Transcript`
 * section, rewriting the note in place. The paired filename is needed for the
 * multipart `file` field on Whisper, and its match doubles as a pre-flight check
 * before bytes are read off disk.
 */
export async function transcribeNote(input: {
  body: string;
  filepath: string;
  rootOverride?: Root;
}): Promise<ReprocessOutcome> {
  try {
    const filename = findPairedLink(input.body, "Audio");
    if (!filename) {
      throw new Error(
        "No paired audio found in this note — transcription needs the original audio on disk.",
      );
    }
    const { base64, mime } = input.rootOverride
      ? await readPairedBinaryFromNote(input.body, input.rootOverride)
      : await readPairedBinaryFromNote(input.body);
    const { text } = await transcribeAudio({ base64, mimeType: mime, filename });
    const next = upsertSection(input.body, "Transcript", text);
    await updateNote(input.filepath, next);
    return { kind: "updated", nextBody: next };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[RecentDetail] transcribe failed:", reason);
    return { kind: "failed", reason };
  }
}
