# Same-profile root-folder retest — 2026-10-11

Status: independently approved for the observed fixed-APK A → B → A case;
owned-user cleanup and installed APK identity confirmed.
This follows the [extended device handoff](2026-10-11-extended-device-verification.md),
which preserves the earlier APK’s observed cache-isolation failure.

## Fixed artifact

The release-signed APK comes from [CI run 38157080927](https://github.com/ventouxlabs/carnet/actions/runs/38157080927),
head `ffef5505df2a7978c0b1a7d1be70af60eca5c794`. Its source tree and main
`84114d0672da0f136d471d076982110f12b3abbe` both equal
`6008d8deb451b1c327876c967b96dd1bbd95223c`, containing the cache fix merged in #232.
APK SHA-256: `0f592edb2b3ad8675094246c31310d164bb7bcd340b9ebbb533b2edf8271a158`.
Artifact digest and ZIP integrity passed. Package `com.ventouxlabs.carnet`,
version 0.11.0/code 9 and release certificate match the previous installation.
Certificate SHA-256: `e5f5ed37e098e0da7b09a59734845b21c986a18d1994bbdb670d01e3c7a3eaf7`.
The APK was updated in place with `adb install -r`. An independent pull of the
installed APK matched the fixed CI APK’s exact hash and release certificate.

## Observed physical result

A fresh owned Android user 12 isolated Settings Save, which can migrate global
private internal captures. “Nothing captured yet” was confirmed before its first
Save. The version-3 disposable DocumentsProvider supplied the fixture roots;
its APK SHA-256 was `9f185e54b2a9462dbe9fbf9dcb698f8999e467c112a60ac8c24fde2a11824471`.

The sole Default app profile used genuinely picked root A (provider root), then
root B (its `Notes` child tree), then A again. No profile switch or manual Refresh
was used. Root A showed 14 fixture tasks with All, Source title sorting and Group
selected. On B’s first observed Todos screen, approximately four seconds after
Settings Save, the checklist was empty with default Open selected and no A tasks.
A native provider query also confirmed the canonical B capture directory was empty.

Returning to A restored all 14 tasks, All and Group. Source title sorting was
visibly selected in the independently reviewed screenshot. The returned native XML
reported selected=false for every sort button, so sort retention is supported by
the visual selection rather than an XML selected=true claim.

Independent review approved these observed screens, root selection evidence,
installed APK identity and cleanup. The A-last-refresh → B-Save interval was not
measured: this is not a physical test of the 30-second refresh throttle. The
coordinator’s same-profile replacement timing and delayed-scan cases remain covered
by the separately reviewed 90 focused automated tests. Screens do not establish
what every transient frame displayed.

## Cleanup, scope and evidence

Owned user 12 was stopped and removed, including its private provider/fixture data.
Independent final read-only checks confirmed current user 0 and only original
users 0 and 10 remained. No owner Settings Save, profile/root/theme change,
capture or note-editing action occurred. Original profile/root names were historical
baseline information and were not freshly verified. The owner ended on the standard
lock screen; no lock bypass was attempted. All device commands stopped and the
phone was released.

No checkbox toggles or note edits were performed in this retest. Fixture and
original-note byte hashes were not collected, so no independent unchanged-byte
result is claimed. The in-place APK update and isolated-user execution protected
existing user data; no original-user uninstall or clear-data occurred.

This retest addresses the observed same-profile root content and view-preference
isolation case. It does not establish real Syncthing transport, fold transitions/
narrower layouts, unrestricted query/filter combinations, new SAF fault results or
#228 LLM re-enrichment acceptance. Earlier layout/provider/modern-method results
remain bounded to the earlier APK.

Private app state, credentials, screenshots and fixture contents remain outside the
repository. Local session evidence: `/tmp/carnet-root-fix-apk-evidence.md`,
`/tmp/carnet-root-fix-device-qa.md` and `/tmp/carnet-root-fix-device-independent.md`.
These temporary files are not durable repository artifacts.
