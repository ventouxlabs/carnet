import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { firstHeading } from "../markdown/parser.js";
import type { MarkdownRecord } from "../models/records.js";
import { atomicWriteFile } from "../storage/atomic.js";
import type { FileSystemRepository } from "../storage/repository.js";

export interface FullTextIndex {
  version: 1;
  generated_at: string;
  documents: Record<string, { type: string; path: string; title: string }>;
  terms: Record<string, string[]>;
}

export async function rebuildFullTextIndex(repository: FileSystemRepository): Promise<FullTextIndex> {
  // A derived index must not block the processing queue because a sync copied
  // one Markdown file halfway. `doctor` remains the strict command that
  // reports such files; the next rebuild will include them once readable.
  const records: MarkdownRecord[] = [];
  for (const path of await repository.listRecordPaths()) {
    const record = await repository.readPath(path).catch(() => null);
    if (record) records.push(record);
  }
  const index: FullTextIndex = { version: 1, generated_at: new Date().toISOString(), documents: Object.create(null), terms: Object.create(null) };
  for (const record of records) {
    const id = record.frontmatter.id;
    index.documents[id] = { type: record.frontmatter.type, path: record.sourcePath ?? "", title: firstHeading(record.body) ?? id };
    for (const term of tokenize(`${JSON.stringify(record.frontmatter)}\n${record.body}`)) {
      const ids = index.terms[term] ?? (index.terms[term] = []);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  for (const ids of Object.values(index.terms)) ids.sort();
  await atomicWriteFile(join(repository.root, "indexes", "full-text-v1.json"), JSON.stringify(index, null, 2), { overwrite: true });
  return index;
}

export async function searchFullText(repository: FileSystemRepository, query: string): Promise<Array<FullTextIndex["documents"][string] & { id: string; score: number }>> {
  const path = join(repository.root, "indexes", "full-text-v1.json");
  const index = JSON.parse(await readFile(path, "utf8")) as FullTextIndex;
  // Own-property lookups only: terms like "constructor" must not hit Object.prototype.
  const termIds = (term: string): string[] => (Object.hasOwn(index.terms, term) ? index.terms[term]! : []);
  const scores = new Map<string, number>();
  for (const term of tokenize(query)) for (const id of termIds(term)) scores.set(id, (scores.get(id) ?? 0) + 1);
  return [...scores.entries()].map(([id, score]) => ({ id, score, ...index.documents[id]! })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function tokenize(value: string): string[] {
  return [...new Set(value.normalize("NFKD").toLocaleLowerCase("en").replace(/[\u0300-\u036f]/g, "").match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
}
