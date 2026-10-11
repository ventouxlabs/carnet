# Pixel 10 Pro Fold physical verification — 2026-10-11

Status: independently approved for the exercised folded-device scope; restoration
and cleanup passed. This follows the initial [no-device Todos handoff](2026-10-11-todo-discovery.md).

## Tested artifact and scope

The release-signed CI APK from [run 38146192105](https://github.com/ventouxlabs/carnet/actions/runs/38146192105)
was installed in place with `adb install -r`, preserving app data. Tested commit
`7615af70d3ff7b4e642a97c9dab2a954cab0a7e5` and main baseline `7d623a62` have identical
source trees (`abf962fc913efed490fb3ec54bf14a9cf0ebcc3e`); this does not describe later main commits.
APK SHA-256: `0ae957d0649b5759296ce420a704518bf926aec6723ca4a34bc8d2a810007b3d`.
An independent read-only pull verified the updated installed APK is byte-identical.
Independent `apksigner` verification also matched the public release certificate.

Device: Pixel 10 Pro Fold, folded 1080 × 2364, density 390; app version 0.11.0,
versionCode 9. An owned QA profile used a disposable Android external-storage SAF
folder. Fixtures contained three notes with ten tasks (seven open, three completed),
distinct dates/modes/tags, duplicate source titles, same-source ambiguous tasks and
cross-source duplicate text. Ten additional owned files supplied scan candidates.

## Physical results

- Light and dark Todos layouts, keyboard input/caret and dismissal passed. All ten
  tasks were reachable by scrolling. The view-options card scrolls to Group/Reset.
- Open/Completed/All counts were 7/3/10. Task-text/source-title search, mode/tag OR
  selections combined across categories, reset, date/title sorts and URI-distinct
  groups for equal source titles passed.
- Completing a unique task changed only its source fixture; reopening restored it.
  Same-source ambiguity showed the notice and left every fixture byte unchanged.
  Cross-source duplicate completion changed only the selected URI's checkbox; source
  navigation rendered it. Comparisons covered all 13 owned files.
- Leaving/reopening and force-stop/restart preserved Completed, Source sorting and
  grouping. Restored fixture bytes were reread after restart.
- A second owned profile using the same fixture root showed default Open (seven),
  newest and ungrouped; returning restored the first profile’s Completed, Source
  title sort and three URI groups. This physically verifies view-preference isolation.
- Real rich-text saving through the legacy SAF path shortened a fixture from 143 to
  69 bytes, retained its frontmatter and removed the old tail. The fixture was restored.
- Home scan showed 13 checked, 0 skipped and 10 candidates. Bounded list scrolling,
  fixed Close and a visible candidate's Open navigation passed. All 13 owned files
  were byte-identical after scanning.

Both owned QA profiles were removed. The two original profiles remained, with the
original active profile/SAF root restored and Appearance set to System. Final owned
fixture snapshots matched all 13 baseline files before exact fixture removal; the
owned folder and empty directories were removed, and its absence checked. Carnet
was left on Settings with the updated APK installed. No product failure was observed
in the exercised scope. Independent provenance, byte comparisons, visuals, profile
isolation, restoration and cleanup review approved the exercised physical scope.
The verdict does not cover the untested paths below.

## Remaining coverage and handling limits

Unfolded/wide or narrower layouts, fold transitions, root changes within a profile,
real Syncthing transport,
modern SAF API, providers rejecting `"wt"`, unreadable/partial scans and #228 LLM
re-enrichment were not exercised. Query/filter permutations beyond separate text/title
searches and combined mode/tag/status checks also remain untested. Settings Save
also migrates existing internal
captures; within-profile root changes were avoided to protect that state. Profile
switching here does not establish slow-capture, attachment or queue-drain routing.

No writes were directed to the original vault, and there was no uninstall or
clear-data. Original notes were not byte-audited. No LLM or external model-provider request was made.
Device screenshots and private app state remain outside the repository.

Local evidence: `/tmp/carnet-device-qa-20261011.md`,
`/tmp/carnet-device-apk-evidence.md`, `/tmp/carnet-device-independent-verification.md`;
fixture-byte comparisons and screenshots are referenced there. These temporary paths
are session evidence, not durable repository artifacts. Maintained follow-ups are in
[TODO.md](../../TODO.md) and [the smoke checklist](../smoke-test.md).
