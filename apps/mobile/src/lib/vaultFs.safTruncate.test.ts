// Copyright (C) 2025 Ventoux Advisory, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards patches/expo-file-system+*.patch.
 *
 * safFs.writeString/writeBinaryBytes reach expo-file-system's native
 * `getOutputStream`, which opened SAF documents with ContentResolver's default
 * "w" mode. ExternalStorageProvider does not truncate on "w", so every rewrite
 * that made a vault file SHORTER left the old file's tail behind as stray text —
 * observed on-device 2026-10-03: a 196-byte enriched Note landed in a 204-byte
 * file ending in the raw stub's last 8 bytes. The patch opens with "wt".
 *
 * The bug lives in Kotlin, so no JS test can exercise it; this pins the
 * installed source and the build-from-source opt-in instead. It fails if the
 * patch stops applying (a dependency bump) or is dropped, or if the module goes
 * back to its prebuilt AAR — each exactly when the corruption would come back.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("expo-file-system/package.json"));
const legacyModule = readFileSync(
  join(pkgDir, "android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt"),
  "utf8",
);

describe("SAF writes truncate (patches/expo-file-system)", () => {
  it("opens SAF documents for writing with \"wt\"", () => {
    expect(legacyModule).toContain('uri.isSAFUri -> context.contentResolver.openOutputStream(uri, "wt")!!');
  });

  it("leaves no untruncated SAF output stream in the legacy module", () => {
    expect(legacyModule).not.toMatch(/openOutputStream\(uri\)/);
  });

  // SDK 54 links most expo modules as prebuilt AARs, which a source patch never
  // reaches: without this the patched Kotlin is simply not in the APK.
  it("builds expo-file-system from source so the patch is compiled in", () => {
    const appPkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    const patterns: string[] = appPkg.expo?.autolinking?.android?.buildFromSource ?? [];
    expect(patterns.some((p) => new RegExp(`^(?:${p})$`).test("expo-file-system"))).toBe(true);
  });
});
