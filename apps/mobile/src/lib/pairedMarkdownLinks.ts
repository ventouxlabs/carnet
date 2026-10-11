/** Paired destinations in Markdown links. Kept pure for writer/re-enrichment. */
export interface PairedMarkdownLink {
  subdir: "Photos" | "Audio" | "Files";
  filename: string;
  rel: string;
  label: string;
  image: boolean;
  start: number;
  end: number;
}

/** Angle destinations make spaces and parentheses valid without URL-encoding
 * filenames (the storage lookup needs the original name). Simple names keep
 * the established byte representation. */
export function attachmentDestination(rel: string): string {
  return /[\s()]/.test(rel) ? `<${rel}>` : rel;
}

/** Code examples are not attachment references. Recognize only Markdown's
 * fenced blocks and paired backtick runs, without parsing prose or HTML. */
function codeRanges(body: string): [number, number][] {
  const ranges: [number, number][] = [];
  let fence: { char: string; length: number; start: number } | null = null;
  let offset = 0;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        ranges.push([fence.start, offset + raw.length]);
        fence = null;
      }
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = { char: open[1][0], length: open[1].length, start: offset };
      }
    }
    offset += raw.length + 1;
  }
  if (fence) ranges.push([fence.start, body.length]);
  let fenceIndex = 0;
  const ticks = [...body.matchAll(/`+/g)].filter(match => {
    while (fenceIndex < ranges.length && match.index >= ranges[fenceIndex][1]) fenceIndex++;
    return fenceIndex >= ranges.length || match.index < ranges[fenceIndex][0];
  });
  const nextSameLength: number[] = [];
  const nextByLength = new Map<number, number>();
  for (let i = ticks.length - 1; i >= 0; i--) {
    nextSameLength[i] = nextByLength.get(ticks[i][0].length) ?? -1;
    nextByLength.set(ticks[i][0].length, i);
  }
  for (let i = 0; i < ticks.length; i++) {
    const end = nextSameLength[i];
    if (end !== -1) {
      ranges.push([ticks[i].index, ticks[end].index + ticks[end][0].length]);
      i = end;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

function safeFilename(filename: string): boolean {
  // Storage receives original bytes, but reject separators/dot paths even if
  // a future URI resolver percent-decodes a destination before using it.
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f])/i.test(filename)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(filename); } catch { decoded = filename; }
  return !/[\/\\\r\n\u0000-\u001f]/.test(decoded) && decoded !== "." && decoded !== "..";
}

/** Read both generated angle destinations and legacy bare destinations with
 * balanced parentheses. Never return a partial path or a traversal segment. */
export function pairedMarkdownLinks(body: string): PairedMarkdownLink[] {
  const links: PairedMarkdownLink[] = [];
  const ignored = codeRanges(body);
  const opening = /(!?)\[([^\[\]\r\n]*)\]\(/g;
  let ignoredIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(body)) !== null) {
    while (ignoredIndex < ignored.length && match.index >= ignored[ignoredIndex][1]) ignoredIndex++;
    if (ignoredIndex < ignored.length && match.index >= ignored[ignoredIndex][0]) {
      opening.lastIndex = ignored[ignoredIndex][1];
      continue;
    }
    let escapeCount = 0;
    for (let i = match.index - 1; i >= 0 && body[i] === "\\"; i--) escapeCount++;
    if (escapeCount % 2 === 1) continue;
    const from = match.index + match[0].length;
    let end = from;
    let rel: string;
    if (body[from] === "<") {
      end = from + 1;
      while (end < body.length && body[end] !== ">" && !/[\r\n]/.test(body[end])) end++;
      opening.lastIndex = end + 1;
      if (body[end] !== ">" || body[end + 1] !== ")") continue;
      rel = body.slice(from + 1, end);
      end += 2;
    } else {
      let depth = 1;
      while (end < body.length && depth > 0 && !/[\r\n]/.test(body[end])) {
        if (body[end] === "(") depth++;
        if (body[end] === ")") depth--;
        end++;
      }
      opening.lastIndex = end;
      if (depth !== 0) continue;
      rel = body.slice(from, end - 1);
    }
    opening.lastIndex = end;
    const paired = /^\.\.\/(Photos|Audio|Files)\/([^/\\<>\r\n]+)$/.exec(rel);
    if (!paired || !safeFilename(paired[2]) || paired[2].trim() !== paired[2]) continue;
    links.push({ subdir: paired[1] as PairedMarkdownLink["subdir"], filename: paired[2], rel,
      label: match[2], image: match[1] === "!", start: match.index, end });
  }
  return links;
}
