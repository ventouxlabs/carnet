/**
 * Confirm-save markdown composition + on-disk write (extracted from
 * CaptureScreen.confirmSave).
 *
 * Each mode's confirm-save step does the same three things in the same
 * order — inject staged attachments, merge user tags, inject the selected
 * location — before handing the result to the mode's writer. Centralizing
 * that composition here means the three call sites in CaptureScreen no
 * longer have to repeat it (or the `withLocation` closure), and the
 * ordering is unit-testable without a renderer.
 *
 * The returned `title` is always derived from the PRE-merge markdown (the
 * enriched note as OmniRoute/local-LLM returned it) — matching the
 * screen's prior behavior of deriving the recordCapture title before tags/
 * location/attachments were folded in.
 */

import { deriveTitle } from "@carnet/shared";
import { mergeUserTags } from "./tags";
import { upsertFrontmatterField } from "./frontmatter";
import {
  injectAttachments,
  injectPlaces,
  writeIdea,
  appendJournal,
  writePerson,
  type AttachmentRef,
  type Place,
} from "./writer";
import type { Root } from "./vaultRoot";

/** Inject the selected location into a note's frontmatter (no-op when unset). */
function applyLocation(markdown: string, location: string | null): string {
  return location ? upsertFrontmatterField(markdown, "location", location) : markdown;
}

function composeMarkdown(
  markdown: string,
  refs: readonly AttachmentRef[],
  tags: string[],
  location: string | null,
): string {
  return applyLocation(mergeUserTags(injectAttachments(markdown, refs), tags), location);
}

/** Result of a confirm-save write: the filepath, the markdown actually
 * persisted (post attachments/tags/location merge — what the note/tag
 * index should be built from), and the pre-merge title for recordCapture. */
export interface ConfirmSaveResult {
  filepath: string;
  markdown: string;
  title: string;
}

export interface ConfirmSaveIdeaInput {
  slug: string;
  markdown: string;
  refs: AttachmentRef[];
  tags: string[];
  location: string | null;
  root?: Root;
}

/** Compose the final Idea markdown and write it to `Ideas/{slug}.md`. */
export async function confirmSaveIdea(input: ConfirmSaveIdeaInput): Promise<ConfirmSaveResult> {
  const markdown = composeMarkdown(input.markdown, input.refs, input.tags, input.location);
  const { filepath } = input.root
    ? await writeIdea(input.slug, markdown, input.root)
    : await writeIdea(input.slug, markdown);
  return { filepath, markdown, title: deriveTitle(input.markdown) };
}

export interface ConfirmSaveJournalInput {
  date: string;
  markdown: string;
  refs: AttachmentRef[];
  tags: string[];
  location: string | null;
  /** Named places for THIS entry (Journal only). Injected into the entry's own
   * body, so a second same-day capture keeps its own list rather than
   * overwriting this one — see injectPlaces. */
  places?: Place[];
  root?: Root;
}

/** Compose the final Journal entry and append it to today's day file.
 * `markdown` in the result is the day file's full accumulated markdown
 * (per appendJournal) — index off that, not the just-written fragment. */
export async function confirmSaveJournal(
  input: ConfirmSaveJournalInput,
): Promise<ConfirmSaveResult> {
  // Places are injected LAST, into this entry's own fragment, before
  // appendJournal appends that fragment (## Places included) after its
  // `## HH:MM` heading. The section is a SIBLING of that heading, as ## Files
  // already is; what keeps same-day entries from sharing one Places section is
  // that each fragment is injected separately, never the accumulated day file.
  const markdown = injectPlaces(
    composeMarkdown(input.markdown, input.refs, input.tags, input.location),
    input.places ?? [],
  );
  const { filepath, markdown: dayFileMarkdown } = input.root
    ? await appendJournal(input.date, markdown, input.root)
    : await appendJournal(input.date, markdown);
  return { filepath, markdown: dayFileMarkdown, title: deriveTitle(input.markdown) };
}

export interface ConfirmSavePersonInput {
  firstName: string;
  lastName: string;
  markdown: string;
  tags: string[];
  location: string | null;
  root?: Root;
}

/** Compose the final Person markdown and write it to `People/`. Person
 * notes carry no attachments, so this skips injectAttachments. */
export async function confirmSavePerson(
  input: ConfirmSavePersonInput,
): Promise<ConfirmSaveResult> {
  const markdown = applyLocation(mergeUserTags(input.markdown, input.tags), input.location);
  const { filepath } = input.root
    ? await writePerson(input.firstName, input.lastName, markdown, input.root)
    : await writePerson(input.firstName, input.lastName, markdown);
  return { filepath, markdown, title: deriveTitle(input.markdown) };
}
