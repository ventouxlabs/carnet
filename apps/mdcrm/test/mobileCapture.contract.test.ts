/**
 * Cross-app contract: the capture package the mobile app WRITES must be one
 * the mdcrm server can DISCOVER, VALIDATE and RESOLVE.
 *
 * The format lives as string literals on both sides (directory names, relative
 * attachment paths, frontmatter fields, ID shape) with no shared module, and
 * has already broken twice (mobile files mdcrm never found). This test drives
 * the real mobile `saveBusinessCardCapture` through a fake vault writer into a
 * temp dir, then feeds the result to mdcrm's real repository and schemas.
 *
 * The mobile module is loaded by a runtime-computed path so mdcrm's `tsc`
 * (rootDir ".") never type-checks Expo sources; only the Expo-facing leaves
 * (`expo-crypto`, the vault `writer`/`vaultRoot`) are stubbed.
 *
 * Needs the full workspace install (`npm ci`): apps/mobile/tsconfig.json
 * extends expo/tsconfig.base, so esbuild fails to parse it without expo.
 * The `writer` stub mirrors the real writer's contract; keep them in sync.
 */
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSystemRepository } from "../src/storage/repository.js";
import { SchemaRegistry } from "../src/schemas/registry.js";

const vault = vi.hoisted(() => ({ root: "" }));

vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
}));
vi.mock("../../mobile/src/lib/vaultRoot", () => ({ resolveRoot: async () => ({ uri: "fake", fs: {} }) }));
vi.mock("../../mobile/src/lib/writer", async () => {
  const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
  const { join: j } = await import("node:path");
  const put = async (dir: string, name: string, data: string | Buffer) => {
    await mk(j(vault.root, dir), { recursive: true });
    await wf(j(vault.root, dir, name), data);
    return { filepath: j(vault.root, dir, name), finalName: name };
  };
  return {
    extFromMime: (mime: string) => (mime === "image/jpeg" ? "jpg" : "bin"),
    writeBinary: (dir: string, name: string, base64: string) => put(dir, name, Buffer.from(base64, "base64")),
    writeTextFile: (dir: string, name: string, text: string) => put(dir, name, text),
    updateNote: async () => undefined,
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const mobileModule = resolve(here, "../../mobile/src/lib/mdcrmCapturePackage.ts");

interface MobileCapture {
  saveBusinessCardCapture(input: {
    imageBase64: string; mimeType: string; rawOcrText?: string; capturedAt?: Date;
  }): Promise<{ captureId: string; attachmentId: string; rawOcrPath: string }>;
}
const loadMobile = async (): Promise<MobileCapture> => (await import(/* @vite-ignore */ mobileModule)) as MobileCapture;

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

async function freshVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mdcrm-mobile-contract-"));
  roots.push(root);
  vault.root = root;
  return root;
}

async function writeCapture(): Promise<{ root: string; captureId: string; attachmentId: string }> {
  const root = await freshVault();
  const mobile = await loadMobile();
  const saved = await mobile.saveBusinessCardCapture({
    imageBase64: "YWJj", mimeType: "image/jpeg", rawOcrText: "JANE SMITH\n",
    capturedAt: new Date("2026-08-03T11:22:00.000Z"),
  });
  return { root, captureId: saved.captureId, attachmentId: saved.attachmentId };
}

describe("mobile -> mdcrm capture package contract", () => {
  it("is discovered, schema-valid, and its attachment resolves and hashes", async () => {
    const { root, captureId, attachmentId } = await writeCapture();
    const repository = new FileSystemRepository(root);

    const paths = await repository.listRecordPaths("capture");
    expect(paths).toEqual([join(root, "captures", `${captureId}.md`)]);

    const record = await repository.readPath(paths[0]!);
    expect(() => new SchemaRegistry().validate(record.frontmatter)).not.toThrow();
    expect(record.frontmatter.id).toBe(captureId);
    expect(record.frontmatter.type).toBe("capture");

    await expect(repository.verifyAttachments(record)).resolves.toBeUndefined();
    const original = record.frontmatter.type === "capture" ? record.frontmatter.attachments[0] : undefined;
    expect(original?.id).toBe(attachmentId);
    expect(repository.resolveRelativeToRecord(record, original!.path))
      .toBe(join(root, "attachments", "originals", `${attachmentId}.jpg`));

    const ocr = (record.frontmatter as { ocr?: { raw_text_path?: string } }).ocr;
    expect(ocr?.raw_text_path).toBeTruthy();
    const sidecar = repository.resolveRelativeToRecord(record, ocr!.raw_text_path!);
    expect(sidecar).toBe(join(root, "processing", "results", `${captureId}.ocr.txt`));
    await expect(access(sidecar)).resolves.toBeUndefined();
  });

  it("does not discover a capture saved with a .md.txt name", async () => {
    const root = await freshVault();
    await mkdir(join(root, "captures"), { recursive: true });
    await writeFile(join(root, "captures", "cap_X.md.txt"), "---\ntype: capture\n---\n");
    expect(await new FileSystemRepository(root).listRecordPaths("capture")).toEqual([]);
  });
});
