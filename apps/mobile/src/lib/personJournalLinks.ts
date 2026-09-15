import type { NoteIndexEntry } from "./vault";

export interface PersonJournalMatch {
  uri: string;
  /** Date-derived label for the card; the target carries the unambiguous path. */
  linkTitle: string;
  /** Vault-relative, unambiguous Obsidian target for the matched journal file. */
  linkTarget: string;
  excerpt: string;
}

interface Options {
  /** Bound foreground I/O; old journals remain discoverable through recency. */
  maxReads?: number;
  /** Stops between reads when the detail/profile that requested them changes. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_READS = 20;
const EXCERPT_MAX = 220;

/**
 * Find full-name references in active-vault journal bodies. Index excerpts are
 * intentionally not used for matching: they are capped and commonly omit the
 * entry in which a person was mentioned.
 */
export async function findPersonJournalMatches(
  personTitle: string,
  indexEntries: readonly NoteIndexEntry[],
  readBody: (uri: string) => Promise<string>,
  options: Options = {},
): Promise<PersonJournalMatch[]> {
  const nameTokens = words(personTitle);
  // A one-word name creates unacceptable false positives (e.g. "Ada").
  if (nameTokens.length < 2) return [];

  const maxReads = options.maxReads ?? DEFAULT_MAX_READS;
  if (options.signal?.aborted) return [];
  const candidates = indexEntries
    .filter((entry) => entry.mode === "journal")
    .map((entry) => ({ entry, date: journalDateFromUri(entry.uri) }))
    .filter((candidate): candidate is { entry: NoteIndexEntry; date: string } => candidate.date !== null)
    .sort((a, b) => b.entry.createdOrDate - a.entry.createdOrDate)
    .slice(0, Math.max(0, maxReads));

  const matches: PersonJournalMatch[] = [];
  for (const { entry, date } of candidates) {
    if (options.signal?.aborted) return [];
    let body: string;
    try {
      body = await readBody(entry.uri);
    } catch {
      // A Syncthing/SAF race must not make the entire card disappear.
      continue;
    }
    if (options.signal?.aborted) return [];
    if (!containsWholeName(body, nameTokens)) continue;
    matches.push({
      uri: entry.uri,
      linkTitle: date,
      linkTarget: journalLinkTarget(entry.uri, date),
      excerpt: excerpt(body),
    });
  }
  return matches;
}

/**
 * Turn the matched file URI into the vault-relative target Obsidian resolves.
 * The date alone is not sufficient: a vault can contain another journal
 * archive (or a manually filed journal) with the same filename. Both file://
 * and SAF content:// URIs retain the path below `Journal` after decoding.
 */
function journalLinkTarget(uri: string, date: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // The standard Journal/date fallback below still names the conventional
    // vault location when a malformed URI cannot be decoded.
  }
  const parts = decoded.split(/[?#]/, 1)[0].split("/").filter(Boolean);
  const journalAt = parts.lastIndexOf("Journal");
  if (journalAt === -1) return `Journal/${date}`;
  return [...parts.slice(journalAt, -1), date].join("/");
}

function journalDateFromUri(uri: string): string | null {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // The raw URI can still contain a normal filename.
  }
  const match = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md(?:$|[?#])/i.exec(decoded);
  if (!match) return null;
  const [year, month, day] = match[1].split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? match[1]
    : null;
}

function words(value: string): string[] {
  return value
    .normalize("NFC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function containsWholeName(body: string, nameTokens: readonly string[]): boolean {
  const bodyTokens = words(body);
  for (let start = 0; start <= bodyTokens.length - nameTokens.length; start += 1) {
    if (nameTokens.every((token, offset) => bodyTokens[start + offset] === token)) return true;
  }
  return false;
}

function excerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length <= EXCERPT_MAX ? collapsed : `${collapsed.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
}
