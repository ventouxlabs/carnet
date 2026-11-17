#!/usr/bin/env bash
# check-lockfile-integrity.sh — every registry entry in package-lock.json must carry
# both `resolved` and `integrity`. Entries missing them skip hash verification on
# `npm ci` (supply-chain finding carnet/audit-security-2026-11-16#3).
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
    const isWorkspace = (k) => !k.includes("node_modules/");
    const bad = Object.entries(pkgs).filter(([k, v]) =>
      k !== "" && !v.link && !v.inBundle && !isWorkspace(k) && (!v.resolved || !v.integrity));
    for (const [k] of bad) console.error("missing resolved/integrity: " + k);
    if (bad.length) { console.error(bad.length + " lockfile entries lack resolved/integrity"); process.exit(1); }
  ' "$1"
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"; trap 'rm -r "$tmp"' EXIT
  echo '{"packages":{"":{},"node_modules/a":{"resolved":"u","integrity":"sha512-x"},"packages/w":{}}}' > "$tmp/good.json"
  echo '{"packages":{"":{},"node_modules/a":{"version":"1.0.0"}}}' > "$tmp/bad.json"
  check "$tmp/good.json" || { echo "self-test FAIL: good fixture rejected"; exit 1; }
  if check "$tmp/bad.json" 2>/dev/null; then echo "self-test FAIL: bad fixture accepted"; exit 1; fi
  echo "self-test ok"; exit 0
fi

check "${1:-$REPO_ROOT/package-lock.json}"
echo "lockfile integrity ok"
