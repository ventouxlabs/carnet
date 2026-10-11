/**
 * Markdown body manipulation for the vault writer (no filesystem access).
 *
 * Section upsert/read plus the injectors that fold captured extras (image
 * embeds, attachment links, named places) into a note body. Every function
 * here is a pure string transform: the caller writes binaries to disk first
 * (so a `rel` link resolves) and persists the returned markdown, which is why
 * the online capture path and the offline drain can share them and produce
 * byte-identical bodies.
 *
 * Not native-free, though: injectPlaces imports formatCoords from ./location,
 * which imports expo-location. Keep this module filesystem-free regardless —
 * writer.ts re-exports the public surface, so filesystem access here would
 * leak into every pure consumer.
 */

// Pure formatting helper + its type; location.ts imports only expo-location, so
// this cannot form a cycle back into writer.ts.
import { formatCoords, type Coords } from "./location";
import { splitFrontmatter } from "./frontmatter";
import { attachmentDestination, pairedMarkdownLinks } from "./pairedMarkdownLinks";

/** Only headings outside fenced code can anchor generated content. */
function headingLines(lines: readonly string[]): Set<number> {
  const headings = new Set<number>();
  let fence: { char: string; length: number } | null = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      return;
    }
    if (/^#{1,2} /.test(line)) headings.add(i);
  });
  return headings;
}

function firstH1(body: string): RegExpMatchArray | null {
  const lines = body.split("\n");
  const headings = headingLines(lines);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (headings.has(i) && /^# /.test(lines[i])) {
      const match = /^(#\s+.+?)(\r?\n|$)/.exec(body.slice(offset));
      if (match) { match.index = offset; return match; }
    }
    offset += lines[i].length + 1;
  }
  return null;
}

/**
 * Idempotently insert-or-replace an H2 section in a markdown body.
 *
 *   - If `## {heading}` exists, replace everything from that line through
 *     the next `## ` / `# ` line (or end-of-file) with the new content.
 *   - If it doesn't exist, append a new section at the end with one blank
 *     line of separation from the prior content.
 *
 * Heading match is exact-line and case-sensitive (`## Transcript` matches;
 * `## Transcript ` with trailing space does not, neither does `##  Foo`
 * with double space). This is deliberate: Obsidian's heading parser is
 * strict, and exact-match means re-runs always find their own section
 * back without surprises from whitespace drift. CRLF terminators are accepted;
 * headings within fenced code do not count.
 *
 * Section boundary stops at H1 and H2 only. H3+ subheadings are treated as
 * part of the current section's body, so a transcript can include
 * `### Speakers` without being truncated.
 *
 * Pure function — no I/O. Caller wires `updateNote` to persist the result.
 */
export function upsertSection(
  markdown: string,
  heading: string,
  body: string,
): string {
  // Heading with a newline would break exact-line match (findIndex misses)
  // AND emit a malformed heading on append. Defensive — current caller
  // passes the literal "Transcript" but the helper is exported as general
  // utility.
  if (heading.includes("\n") || heading.includes("\r")) {
    throw new Error("upsertSection: heading cannot contain newlines");
  }

  const headingLine = `## ${heading}`;
  const lines = markdown.split("\n");
  const headings = headingLines(lines);
  const startIdx = lines.findIndex((l, i) => headings.has(i) && l.replace(/\r$/, "") === headingLine);

  if (startIdx === -1) {
    // Append. Normalize trailing newlines so output always ends with
    // exactly one newline after the appended body. Skip the leading "\n\n"
    // separator entirely when markdown is empty so the output doesn't start
    // with phantom blank lines.
    const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
    const trimmed = markdown.replace(/(?:\r?\n)+$/, "");
    const separator = trimmed.length === 0 ? "" : eol + eol;
    return `${trimmed}${separator}${headingLine}${eol}${eol}${body.replace(/\r?\n/g, eol)}${eol}`;
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (headings.has(i)) {
      endIdx = i;
      break;
    }
  }

  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  const replacement = [headingLine, "", body];
  // Preserve a blank line between the new section and whatever follows.
  // If `after` is empty (section was at EOF), no separator needed.
  if (after.length > 0 && after[0] !== "") replacement.push("");
  return [...before, ...replacement, ...after].join("\n");
}

/**
 * Inject a markdown image embed `![](relPath)` immediately under the body's
 * first H1. With no H1, the embed opens the body — after the frontmatter,
 * never above it (a raw save-first stub has frontmatter and usually no H1;
 * above `---` it stopped being frontmatter at all). A note with no
 * frontmatter gets it at the very top, as before.
 *
 * Idempotent: an embed the note already contains is not added again.
 * Finish enrichment and Re-enrich send the on-disk body, embeds included, to
 * the model and then re-inject the same embeds.
 *
 * The earlier inline `/^(#\s+.+\n)/m` regex silently no-op'd when the H1
 * had no trailing newline (e.g. last line of a model response), dropping
 * the embed. This helper handles `\n` and end-of-string equally.
 */
export function injectImageEmbed(markdown: string, relPath: string): string {
  const embed = `![](${attachmentDestination(relPath)})`;
  if (markdown.includes(embed) || pairedMarkdownLinks(markdown).some((link) =>
    link.image && link.label === "" && link.rel === relPath)) return markdown;
  const { header, body } = splitFrontmatter(markdown);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  // Match the body's H1 line and capture its trailing newline (if any).
  const match = firstH1(body);
  if (!match) {
    // A closing fence at end-of-file has no newline of its own to stand on.
    const fenceEnd = header && !header.endsWith("\n") ? eol : "";
    return `${header}${fenceEnd}${embed}${eol}${eol}${body}`;
  }
  const idx = match.index ?? 0;
  const before = body.slice(0, idx + match[1].length);
  const after = body.slice(idx + match[0].length);
  const anchorEol = match[2] || eol;
  return `${header}${before}${anchorEol}${anchorEol}${embed}${anchorEol}${after}`;
}

/** A binary attachment carried alongside a capture: the storage subdir, the
 * collision-bumped on-disk filename, and the `../{subdir}/{name}` relative link
 * used to embed it in the markdown body. Distinct from a freshly-picked
 * attachment (which still holds base64) — this is the post-write reference that
 * survives in the offline queue and the note body. */
export interface AttachmentRef {
  kind: "image" | "file";
  /** `../Photos/sketch.jpg` or `../Files/spec.pdf` */
  rel: string;
  /** Display label + collision-bumped final name on disk. */
  filename: string;
}

/**
 * Fold attachment references into an enriched markdown body. Images become
 * `![](rel)` embeds under the H1 (order preserved); non-image files are
 * collected into a single `## Files` section as a markdown link list, keeping
 * existing authored content and adding only references not already present.
 *
 * Pure function — the caller writes the binaries to disk first (so `rel`
 * resolves) and persists the returned markdown. Shared by the online capture
 * path (CaptureScreen.confirmSave) and the offline drain (queue.processRow) so
 * both produce byte-identical bodies.
 */
export function injectAttachments(
  markdown: string,
  attachments: readonly AttachmentRef[],
): string {
  let md = markdown;
  // Inject images in reverse: injectImageEmbed inserts each embed immediately
  // under the H1, so reversing keeps the first attachment visually first.
  const images = attachments.filter((a) => a.kind === "image");
  for (let i = images.length - 1; i >= 0; i--) {
    md = injectImageEmbed(md, images[i].rel);
  }
  const files = attachments.filter((a) => a.kind === "file");
  if (files.length > 0) {
    // Blank line between links so adjacent ones don't soft-break onto a single
    // line in raw markdown (Obsidian); each still strips cleanly for display.
    const links = files.map((f) => `[${f.filename}](${attachmentDestination(f.rel)})`);
    md = appendFileLinks(md, links);
  }
  return md;
}

/** Match a whole app-owned link, never inline prose or a custom label. */
function ownedLink(line: string, image: boolean): boolean {
  const text = line.replace(/\r$/, "");
  const links = pairedMarkdownLinks(text);
  return links.length === 1 && links[0].start === 0 && links[0].end === text.length &&
    links[0].image === image && (image
      ? links[0].subdir === "Photos" && links[0].label === ""
      : links[0].subdir !== "Photos" && links[0].label === links[0].filename);
}

/** Add missing file links without replacing user-authored section content. */
function appendFileLinks(markdown: string, links: readonly string[]): string {
  const { header, body } = splitFrontmatter(markdown);
  const lines = body.split("\n");
  const headings = headingLines(lines);
  const start = lines.findIndex((line, i) => headings.has(i) && line.replace(/\r$/, "") === "## Files");
  if (start === -1) return upsertSection(markdown, "Files", links.join("\n\n"));
  let end = start + 1;
  while (end < lines.length && !headings.has(end)) end++;
  const existing = lines.slice(start + 1, end).map(line => line.replace(/\r$/, ""));
  const existingPaths = new Set(existing.filter(line => ownedLink(line, false))
    .map(line => pairedMarkdownLinks(line)[0].rel));
  const missing = [...new Set(links)].filter(link =>
    !existing.includes(link) && !existingPaths.has(pairedMarkdownLinks(link)[0]?.rel));
  if (missing.length === 0) return markdown;
  const offset = lines.slice(0, end).reduce((sum, line) => sum + line.length + 1, 0);
  const at = Math.min(offset, body.length);
  const before = body.slice(0, at);
  const after = body.slice(at);
  const eol = lines[start].endsWith("\r") ? "\r\n" : "\n";
  const separator = before.endsWith(eol + eol) ? "" : before.endsWith(eol) ? eol : eol + eol;
  return header + before + separator + missing.join(eol + eol) + eol + (after ? eol : "") + after;
}

const isBlankLine = (line: string | undefined): boolean =>
  line !== undefined && line.trim().length === 0;

/** The embed run injectImageEmbed leaves: under the body's first H1 it is
 * `(blank, embed)` pairs; with no H1, `(embed, blank)` pairs at the top. */
function injectedEmbedRun(body: string, lines: readonly string[]): number[] {
  const h1 = firstH1(body);
  const run: number[] = [];
  if (h1) {
    let i = body.slice(0, h1.index).split("\n").length; // the line after the H1
    while (isBlankLine(lines[i]) && ownedLink(lines[i + 1] ?? "", true)) {
      run.push(i, i + 1);
      i += 2;
    }
    return run;
  }
  let i = 0;
  while (isBlankLine(lines[i])) i++; // a CRLF body keeps a leading "\r" line
  while (ownedLink(lines[i] ?? "", true) && isBlankLine(lines[i + 1])) {
    run.push(i, i + 1);
    i += 2;
  }
  return run;
}

/** A `## Files` section upsertSection appended: everything after the heading
 * to the end is file links — so it is the last section, since a heading that
 * followed would not be one. Its lines and the blank run before it, but not
 * the final "" that keeps the body's own closing line break. */
function injectedFilesSection(lines: readonly string[]): number[] {
  const headings = headingLines(lines);
  const start = lines.findIndex((line, i) => headings.has(i) && line.replace(/\r$/, "") === "## Files");
  if (start === -1) return [];
  const content = lines.slice(start + 1).filter((line) => !isBlankLine(line));
  if (content.length === 0 || !content.every((line) => ownedLink(line, false))) return [];
  let from = start;
  while (from > 0 && isBlankLine(lines[from - 1])) from--;
  const to = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return Array.from({ length: to - from }, (_, k) => from + k);
}

/**
 * The inverse of injectAttachments: remove what it wrote, where it wrote it —
 * the bare `![](../Photos/…)` embeds under the body's first H1 (or at the top
 * of a body without one), and a trailing `## Files` section of
 * `[name](../Files/name)` links.
 *
 * Finish enrichment and Re-enrich hand the on-disk body to a model and then
 * re-inject the note's attachments themselves. Leaving the lines in means the
 * model sees them too — and a reply that drops them trips the note line guard,
 * which then falls back and loses the capture's checkboxes. With them stripped,
 * the model sees what it saw at capture time.
 *
 * Anything else stays, exactly as on disk: an embed the user moved, one with
 * alt text, a link with the user's own label, a `## Files` section that holds
 * prose or is followed by another section, and every inline link — the model
 * may see those, because only these exact shapes are certain to come back.
 */
export function stripInjectedAttachments(body: string): string {
  const lines = body.split("\n");
  const drop = new Set([...injectedEmbedRun(body, lines), ...injectedFilesSection(lines)]);
  if (drop.size === 0) return body;
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

/** A named place attached to a capture: a display name plus the coordinates it
 * resolved to (from a Maps link or forward geocoding). Distinct from the
 * `location` frontmatter field, which is one day-file-scoped GPS scalar —
 * places are entry-scoped and there can be several per entry. */
export interface Place {
  name: string;
  coords: Coords;
}

/** Read back the body of a `## {heading}` section, or null when absent. Uses
 * the same exact-line match and H1/H2 boundary rule as {@link upsertSection},
 * so what this returns is exactly what an upsert would replace. */
function readSection(markdown: string, heading: string): string | null {
  const headingLine = `## ${heading}`;
  const lines = markdown.split("\n");
  const headings = headingLines(lines);
  const startIdx = lines.findIndex((l, i) => headings.has(i) && l.replace(/\r$/, "") === headingLine);
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (headings.has(i)) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx + 1, endIdx).join("\n").trim();
}

/** Make a place name safe to sit inside a markdown link label.
 *
 * Names reach here from two untrusted-ish sources: percent-decoded bytes out of
 * a pasted Maps URL, and whatever the user typed. A raw newline would break the
 * link AND — if the next line happened to start with `## ` — invent a section
 * boundary that upsertSection would later honor, silently restructuring the
 * note. Brackets would terminate the link label early. */
function sanitizePlaceName(name: string): string {
  return name
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fold named places into an entry's markdown body as a `## Places` section of
 * `[name](geo:lat,lon)` links.
 *
 * Body injection, NOT frontmatter, and deliberately so: a journal day file has
 * one frontmatter block shared by every same-day capture (see appendJournal),
 * so a frontmatter list would let the second entry of the day clobber the
 * first's places. Injected into the entry's own fragment before appendJournal
 * appends it, each entry keeps its own `## Places` — a sibling of that entry's
 * `## HH:MM` heading, exactly as `## Files` already is.
 *
 * Existing `## Places` content is APPENDED to, never replaced: the enriching
 * model writes the prose for these entries and may well emit its own Places
 * heading for a travel day, and silently deleting that is worse than a slightly
 * redundant section.
 *
 * Pure function, same contract as injectAttachments.
 */
export function injectPlaces(markdown: string, places: readonly Place[]): string {
  if (places.length === 0) return markdown;
  // Blank line between links so adjacent ones don't soft-break onto a single
  // line in raw markdown (Obsidian) — same rationale as the Files section.
  const links = places
    .map((p) => {
      const name = sanitizePlaceName(p.name);
      const coords = formatCoords(p.coords);
      return `[${name || coords}](geo:${coords})`;
    })
    .join("\n\n");
  const existing = readSection(markdown, "Places");
  const body = existing ? `${existing}\n\n${links}` : links;
  return upsertSection(markdown, "Places", body);
}
