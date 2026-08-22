# Session handoff — 2026-08-22 (transport matrix closed, v0.8.0 + v0.9.0, F-Droid submit-ready)

Follows `2026-08-18-part2-stage2-closed-v0.7.0-fdroid-prep.md`. Covers 2026-08-19
(the #176 Carnet-side work) and 2026-08-22 (releases, user-CA trust, F-Droid
finalization).

## State at handoff

`main` at **`cd8729e`** (#193), CI green. Mobile suite **2062/2062** (was 2004 at
the last handoff). Releases **v0.8.0** and **v0.9.0** both published today
(signed APKs, workflow-verified). **Issue #176 CLOSED.** Only open issue:
**#182** (F-Droid), whose remaining steps are user-performed submissions.
No open PRs, tree clean.

## Issue #176 — closed with the full transport matrix

Product decision (user): Relais = localhost; remote = valid-TLS (llm.grepon.cc);
plus an escape hatch for everything else. Shipped across four PRs:

| Endpoint | Status |
|---|---|
| http://127.0.0.1 (Relais on-device) | ✅ always (+ 120s local-inference timeout, #180) |
| https:// with a public-CA cert | ✅ always |
| http:// on RFC1918 LAN | ✅ always |
| http:// on tailnet/VPN | ✅ per-provider consent toggle (#188) |
| https:// self-signed | ✅ after installing the cert into Android's user CA store (#190) |

- **#186**: `untrusted-tls` HealthResult — Test Connection distinguishes a
  cert-trust failure from unreachable (conservative Conscrypt string matching).
- **#188** (security-reviewed twice, no exploitable path found): predicate split
  (`isAllowedPlaintextHost` gate unchanged and pinned-narrow by test;
  `isLocalNetworkUrl` UX-only predicate gained Tailscale 100.64/10 with exact
  bounds), credential-transmission narrowing (keyless probes may proceed;
  content-bearing calls keep the full gate), `allowInsecureTransport` consent
  flag (http-only visibility, names both key+note-text exposure, resets on URL
  change, stripped on settings import, threaded through enrichment AND probes,
  fallback no-bleed pinned by a negative-controlled test). The blanket
  100.64/10 gate widening was REJECTED by security review (tunnel-down cellular
  CGNAT key-leak; tailnet hosts are MagicDNS/IPv6 anyway).
- **#190**: `withCleartextLocalProviders` → `withNetworkSecurityConfig` plugin,
  emitting a network security config with system+user trust-anchors AND
  `cleartextTrafficPermitted="true"` in base-config — **the landmine**: a
  networkSecurityConfig makes Android ignore `usesCleartextTraffic`, so
  omitting that attribute would silently regress cleartext-local (#153/#154).
  Guarded by CI-running plugin tests (negative-controlled) + the extended
  (manual-only) `verify-cleartext-prebuild.sh`. Security review required and
  got honest docs: this is BROADER than Android's API-24+ app default
  (system-only) — browser-model trust, app-wide blast radius incl. cloud API
  keys, spelled out in `docs/self-signed-certs.md`. Cleartext consent is now
  marked superseded-in-preference by the cert path.

## Releases

- **v0.8.0** (versionCode 6): consent toggle, TLS classification, local
  timeout, F-Droid metadata. Published 2026-08-22 12:48 UTC.
- **v0.9.0** (versionCode 7): adds #190 user-CA trust; cut specifically so the
  first IzzyOnDroid-pulled release has the complete matrix. Published
  2026-08-22 14:26 UTC. Fastlane changelogs 6.txt/7.txt in-repo.

## F-Droid (#182) — repo side 100% done, submissions are the user's

- **IzzyOnDroid (Phase 1, ready now)**: `docs/fdroid/izzyondroid-submission.md`
  is a verbatim, template-matched paste body (updated to v0.9.0). Venue
  confirmed: new issue at gitlab.com/IzzyOnDroid/applists, title
  "Add: Carnet (com.ventouxlabs.carnet)".
- **fdroiddata recipe (Phase 2)**: `docs/fdroid/fdroiddata-recipe-draft.yml` is
  VALIDATED — `fdroid build` ran end-to-end locally on fdroidserver 2.4.5
  (13 iterations total). **Signing DECIDED**: prebuild seds out the debug
  signingConfig → genuinely unsigned `app-release-unsigned.apk`
  (apksigner-verified signature-free; re-validated after the change). Recipe
  comments carry every gotcha (prebuild lines join with ';' in one shell so
  cwd leaks; the scanner deletes the gradle wrapper — use `gradle`, not
  `./gradlew`; node_modules scanignore; local-toolchain shims the buildserver
  provides natively: the gradlew-fdroid script and the 8.14.3 gradle hash).

## Standing items (unchanged)

- Pixel 9 pending-badge anomaly on the old QA note — 2-minute look when it's
  next plugged in (see 08-18 part 2 handoff).
- June-era `stash@{0}` — user to inspect or drop.
- STT model-download prompt unreproducible on available hardware (both Pixels
  have the en model).

## Next session

1. If the user submitted to Izzy: check for reviewer questions on the applists
   issue (size justification and no-trackers evidence are pre-written).
2. Phase 2 when wanted: copy the validated recipe into a fdroiddata fork
   (strip header comments), `fdroid lint`, open the MR.
3. Any new-feature work restarts from TODO.md / user direction — the epic
   backlog (#75/#78/#85) closed on 2026-08-18.
