import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The release job holds the signing keystore secrets, so every third-party
// action it (transitively, via the local composite) runs must be pinned to an
// immutable commit SHA — a mutable tag like @v7 can be re-pointed at malicious
// code that then reads those secrets.
const repoRoot = path.resolve(__dirname, "../../../..");
const files = [
  ".github/workflows/release.yml",
  ".github/actions/android-toolchain/action.yml",
];

function usesRefs(file: string): string[] {
  const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
}

describe("release workflow action pinning", () => {
  for (const file of files) {
    it(`${file} pins third-party actions to a full commit SHA`, () => {
      const unpinned = usesRefs(file).filter(
        (ref) => !ref.startsWith("./") && !/@[0-9a-f]{40}$/.test(ref),
      );
      expect(unpinned).toEqual([]);
    });
  }

  it("release.yml scopes the token to the release job only", () => {
    const text = fs.readFileSync(path.join(repoRoot, files[0]), "utf8");
    // Workflow-level permissions must be read-only; contents: write belongs on the job.
    const top = text.split(/^jobs:/m)[0];
    expect(top).not.toMatch(/contents:\s*write/);
  });
});
