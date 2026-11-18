#!/usr/bin/env bash
# check-lockfile-integrity.sh — hardens package-lock.json against supply-chain tampering
# (carnet/audit-security-2026-11-16#3). Every non-exempt entry must have:
#   1. `resolved` on https://registry.npmjs.org/ (no http:, other hosts, git URLs or
#      file: paths; there is deliberately no allowlist — add one here, with a reason,
#      if a private registry or git dependency is ever needed),
#   2. `integrity` that is well-formed sha512-<base64> (86 chars + "=="). sha1/sha256
#      are rejected: the real lockfile is 100% sha512, so weaker hashes only appear if
#      something was tampered with or hand-edited. Multiple space-separated hashes are
#      allowed only if every one is a well-formed sha512,
#   3. a tarball name in `resolved` matching the package name (the `name` field for npm
#      aliases, else the node_modules path) and `version` of the entry.
#
# Exempt: the root entry (""), workspace packages and symlinks (`link: true`), and
# bundled deps (`inBundle`), which npm never records a registry URL/hash for.
#
# Usage: check-lockfile-integrity.sh [--self-test] [lockfile]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

check() {
  node -e '
    const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const pkgs = lock.packages || {};
    const MARK = "node_modules/";
    const REGISTRY = "https://registry.npmjs.org/";
    const SHA512 = /^sha512-[A-Za-z0-9+\/]{86}==$/;
    const problems = [];
    for (const [k, v] of Object.entries(pkgs)) {
      if (k === "" || v.link || v.inBundle || !k.includes(MARK)) continue;
      const bad = (msg) => problems.push(k + ": " + msg);
      const name = v.name || k.slice(k.lastIndexOf(MARK) + MARK.length);
      if (!v.resolved || !v.integrity) { bad("missing resolved/integrity"); continue; }
      if (!String(v.resolved).startsWith(REGISTRY)) bad("resolved not on " + REGISTRY + ": " + v.resolved);
      else {
        // https://registry.npmjs.org/<name>/-/<unscoped-name>-<version>.tgz
        const base = name.split("/").pop();
        const want = REGISTRY + name + "/-/" + base + "-" + v.version + ".tgz";
        if (v.resolved !== want) bad("resolved " + v.resolved + " does not match " + name + "@" + v.version);
      }
      const hashes = String(v.integrity).split(/\s+/).filter(Boolean);
      if (!hashes.length || !hashes.every((h) => SHA512.test(h))) bad("integrity is not well-formed sha512: " + v.integrity);
    }
    for (const p of problems) console.error(p);
    if (problems.length) { console.error(problems.length + " lockfile problem(s)"); process.exit(1); }
  ' "$1"
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"; trap 'rm -r "$tmp"' EXIT
  H="sha512-$(printf 'A%.0s' $(seq 86))=="
  R="https://registry.npmjs.org"
  # entry <key> <extra-json-fields>  -> one-package lockfile
  mk() { echo "{\"packages\":{\"\":{},$2,\"packages/w\":{},\"node_modules/l\":{\"link\":true,\"resolved\":\"packages/w\"}}}" > "$tmp/$1.json"; }
  GOOD="\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/a/-/a-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk good "$GOOD"
  mk good-scoped "\"node_modules/@s/a\":{\"version\":\"1.0.0-rc.1\",\"resolved\":\"$R/@s/a/-/a-1.0.0-rc.1.tgz\",\"integrity\":\"$H\"}"
  mk good-nested "\"node_modules/x/node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/a/-/a-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk good-alias "\"node_modules/al\":{\"name\":\"a\",\"version\":\"1.0.0\",\"resolved\":\"$R/a/-/a-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk good-bundled "\"node_modules/b\":{\"version\":\"1.0.0\",\"inBundle\":true}"
  mk bad-missing-resolved "\"node_modules/a\":{\"version\":\"1.0.0\",\"integrity\":\"$H\"}"
  mk bad-missing-integrity "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/a/-/a-1.0.0.tgz\"}"
  mk bad-http "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"http://registry.npmjs.org/a/-/a-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk bad-host "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"https://evil.example.com/a/-/a-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk bad-lookalike-host "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"https://registry.npmjs.org.evil.com/a/-/a-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk bad-git "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"git+ssh://git@github.com/o/a.git#abc\",\"integrity\":\"$H\"}"
  mk bad-file "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"file:../a-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk bad-version "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/a/-/a-1.0.1.tgz\",\"integrity\":\"$H\"}"
  mk bad-name "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/b/-/b-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk bad-scope "\"node_modules/@s/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/@t/a/-/a-1.0.0.tgz\",\"integrity\":\"$H\"}"
  mk bad-sha1 "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/a/-/a-1.0.0.tgz\",\"integrity\":\"sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=\"}"
  mk bad-integrity-short "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/a/-/a-1.0.0.tgz\",\"integrity\":\"sha512-x\"}"
  mk bad-integrity-garbage "\"node_modules/a\":{\"version\":\"1.0.0\",\"resolved\":\"$R/a/-/a-1.0.0.tgz\",\"integrity\":\"not-a-hash\"}"
  for f in good good-scoped good-nested good-alias good-bundled; do
    check "$tmp/$f.json" 2>/dev/null || { echo "self-test FAIL: $f fixture rejected"; exit 1; }
  done
  for f in "$tmp"/bad-*.json; do
    if check "$f" 2>/dev/null; then echo "self-test FAIL: $(basename "$f") accepted"; exit 1; fi
  done
  echo "self-test ok"; exit 0
fi

check "${1:-$REPO_ROOT/package-lock.json}"
echo "lockfile integrity ok"
