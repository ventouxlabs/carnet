import { describe, expect, it } from "vitest";

import { extFromMime, mimeFromFilename } from "./mimeTypes";

// ── extFromMime ───────────────────────────────────────────────────────────────

describe("extFromMime", () => {
  it("maps the common image types", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/jpg")).toBe("jpg");
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/webp")).toBe("webp");
    expect(extFromMime("image/heic")).toBe("heic");
  });

  it("is case-insensitive", () => {
    expect(extFromMime("IMAGE/JPEG")).toBe("jpg");
  });

  it("maps audio + pdf", () => {
    expect(extFromMime("audio/mpeg")).toBe("mp3");
    expect(extFromMime("audio/m4a")).toBe("m4a");
    expect(extFromMime("application/pdf")).toBe("pdf");
  });

  it("maps common shared document types to their canonical extensions (not the raw subtype)", () => {
    expect(
      extFromMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("docx");
    expect(
      extFromMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe("xlsx");
    expect(
      extFromMime("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ).toBe("pptx");
    expect(extFromMime("application/msword")).toBe("doc");
    expect(extFromMime("application/vnd.ms-excel")).toBe("xls");
    expect(extFromMime("text/plain")).toBe("txt");
    expect(extFromMime("text/markdown")).toBe("md");
    expect(extFromMime("text/csv")).toBe("csv");
    expect(extFromMime("application/zip")).toBe("zip");
    expect(extFromMime("application/json")).toBe("json");
  });

  it("round-trips the document extensions through mimeFromFilename", () => {
    for (const [file, mime] of [
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["a.txt", "text/plain"],
      ["a.md", "text/markdown"],
      ["a.zip", "application/zip"],
    ] as const) {
      expect(mimeFromFilename(file)).toBe(mime);
      expect(extFromMime(mime)).toBe(file.slice(2));
    }
  });

  it("falls back to bin when the subtype is not a safe [a-z0-9] token", () => {
    expect(extFromMime("image/../../etc/passwd")).toBe("bin");
    expect(extFromMime("x/a b")).toBe("bin");
    expect(extFromMime("x/a.b\\c")).toBe("bin");
    expect(extFromMime("x/svg+xml")).toBe("bin");
    expect(extFromMime("x/")).toBe("bin");
  });

  it("falls back to the type/subtype slash split for unknowns", () => {
    expect(extFromMime("video/mp4")).toBe("mp4");
    expect(extFromMime("application/zip")).toBe("zip");
  });

  it("uses the slash-suffix for audio mimes not in the explicit map", () => {
    // Recording apps, browsers, and Android sources hand carnet a wide
    // range of audio mimes — lock in that the suffix fallback covers the
    // common ones cleanly (so the saved file lands as `.aac`, not `.bin`).
    expect(extFromMime("audio/aac")).toBe("aac");
    expect(extFromMime("audio/ogg")).toBe("ogg");
    expect(extFromMime("audio/flac")).toBe("flac");
    expect(extFromMime("audio/webm")).toBe("webm");
  });

  it("returns bin for empty / null / no slash", () => {
    expect(extFromMime(undefined)).toBe("bin");
    expect(extFromMime("")).toBe("bin");
    expect(extFromMime("garbage")).toBe("bin");
  });
});

// ── mimeFromFilename ─────────────────────────────────────────────────────────

describe("mimeFromFilename", () => {
  it("maps common image extensions", () => {
    expect(mimeFromFilename("a.jpg")).toBe("image/jpeg");
    expect(mimeFromFilename("a.jpeg")).toBe("image/jpeg");
    expect(mimeFromFilename("a.png")).toBe("image/png");
    expect(mimeFromFilename("a.webp")).toBe("image/webp");
    expect(mimeFromFilename("a.gif")).toBe("image/gif");
    expect(mimeFromFilename("a.heic")).toBe("image/heic");
    expect(mimeFromFilename("a.heif")).toBe("image/heif");
  });

  it("maps audio extensions", () => {
    expect(mimeFromFilename("a.mp3")).toBe("audio/mpeg");
    expect(mimeFromFilename("a.wav")).toBe("audio/wav");
    expect(mimeFromFilename("a.m4a")).toBe("audio/mp4");
  });

  it("maps pdf", () => {
    expect(mimeFromFilename("a.pdf")).toBe("application/pdf");
  });

  it("falls back to octet-stream for an unknown extension", () => {
    expect(mimeFromFilename("a.xyz")).toBe("application/octet-stream");
  });

  it("falls back to octet-stream for a name with no extension", () => {
    expect(mimeFromFilename("noext")).toBe("application/octet-stream");
  });

  it("is case-insensitive on the extension", () => {
    expect(mimeFromFilename("IMG.JPG")).toBe("image/jpeg");
    expect(mimeFromFilename("song.MP3")).toBe("audio/mpeg");
  });
});
