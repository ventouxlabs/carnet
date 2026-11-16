/**
 * MIME type <-> file extension mapping shared by the paired-binary writers and
 * readers. Pure — no filesystem access.
 */

/** Map a MIME type to a sensible file extension for binary writes. Covers
 * the image types we accept on share intent + a few common audio/document
 * types we'll grow into. Falls back to `bin` rather than guessing wrong. */
export function extFromMime(mime?: string): string {
  if (!mime) return "bin";
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  if (m === "image/heic") return "heic";
  if (m === "image/heif") return "heif";
  if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
  if (m === "audio/wav" || m === "audio/x-wav") return "wav";
  if (m === "audio/mp4" || m === "audio/m4a") return "m4a";
  if (m === "application/pdf") return "pdf";
  // Common document/archive types shared into carnet. Without these the
  // generic subtype fallback below produces monsters like
  // `report.vnd.openxmlformats-officedocument.wordprocessingml.document` —
  // and SAF's createFileAsync then RENAMES the file by appending the
  // mime-canonical extension (`.docx`), which used to desync the on-disk
  // name from the note's ../Files/ link (broken pairing: attachments
  // silently skipped Karakeep export and were orphaned on archive).
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (m === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (m === "application/msword") return "doc";
  if (m === "application/vnd.ms-excel") return "xls";
  if (m === "text/plain") return "txt";
  if (m === "text/markdown") return "md";
  if (m === "text/csv") return "csv";
  if (m === "application/zip") return "zip";
  if (m === "application/json") return "json";
  // The mime string can be attacker-controlled (share intent), and the result
  // ends up in a filename — only accept a plain [a-z0-9] subtype (hyphen-separated
  // segments allowed, e.g. audio/x-m4a).
  const slash = m.indexOf("/");
  const subtype = slash >= 0 ? m.slice(slash + 1) : "";
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(subtype) ? subtype : "bin";
}

/** Best-effort inverse of `extFromMime` for the file extensions we actually
 * write into the vault. Returns "application/octet-stream" for unknowns so
 * downstream code (e.g. `enrichSharedImage`) gets to surface its own error
 * about an unsupported type, rather than us guessing wrong. */
export function mimeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    doc: "application/msword",
    xls: "application/vnd.ms-excel",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    zip: "application/zip",
    json: "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}
