# Extended Android physical verification — 2026-10-11

Status: physical execution and cleanup complete; same-profile root cache defect
reproduced. Independent review confirms the bounded layout/provider/modern
checks and cleanup; immediate root content isolation failed on the tested APK.
The code fix passed independent review and all automated gates; physical retest pending.
This extends [the folded-device handoff](2026-10-11-pixel-10-fold-verification.md),
which remains the historical record of that earlier scope.

## Artifact and isolation

The installed release-signed APK remains the artifact from
[CI run 38146192105](https://github.com/ventouxlabs/carnet/actions/runs/38146192105),
commit `7615af70d3ff7b4e642a97c9dab2a954cab0a7e5`.
APK SHA-256: `0ae957d0649b5759296ce420a704518bf926aec6723ca4a34bc8d2a810007b3d`.
The installed APK was pulled and SHA-verified again after `install-existing`
in the new Android user. Results apply to that artifact, not later main commits.

Unfolded checks use a Pixel 10 Pro Fold at 2076 × 2152 with an owned app profile
and 13 disposable external-storage SAF fixtures. Appearance changes use their
immediate controls. Within-profile folder replacement requires a fresh, owned
Android user: Settings Save can migrate global private internal captures, so an
app profile alone does not isolate that operation. Newly created Android user 11
received the existing exact Carnet APK via `install-existing`, completed onboarding
without accounts, and showed no captures. The test provider was installed only
for user 11; package metadata confirmed it was not installed for users 0 or 10.
Both roots were genuinely selected, nonempty SAF tree URIs in the same Default
profile. User 11 was removed after testing; final users were 0 (running) and 10.

## Observed results

Light/dark unfolded Todos screenshots show accessible task rows and a bounded
options panel that scrolls to Group and Reset. Keyboard input leaves grouped
rows visible above the keyboard. Independent visual review approved that bounded
scope. QA evidence also records combined Note/`#alpha` filtering (five tasks), All/grouped
scrolling to later source tasks and a scan with 13 checked, 0 skipped and 10 candidates.
The bounded candidate list reached its final entry with Close accessible; Open
navigated to its source. All 13 fixture hashes matched their baseline afterward.
The owned app profile and exact fixture files/empty directories were removed; the
original profile/root and System appearance were restored before switching users.

## Provider harness scope

The separate disposable DocumentsProvider package has independently reviewed
source, manifest, signatures and APK provenance. Its private fixture files and
shell-controlled faults are confined to Android user 11. Fixture version 3 APK
SHA-256: `9f185e54b2a9462dbe9fbf9dcb698f8999e467c112a60ac8c24fde2a11824471`.
Its unique authority is `com.android.externalstorage.carnetqa.documents`, distinct
from the system provider. The earlier version-2 authority was rejected by the
native legacy SAF prefix guard before provider reads; those attempts establish
no injected-fault result. A fresh system-picker grant made version 3 reachable.

With readable fixtures, Carnet Todos showed 14 tasks. A checkbox write under
`REJECT_WT` showed “Couldn’t update”; provider logs recorded `r` followed by
`wt` rejection before any write descriptor opened. All three seed-file hashes
remained unchanged. Clearing the fault let the same checkbox succeed: only
`readable.md` changed, matching the intended task completion.

Read-one failure produced 2 checked / 1 skipped; all-read failure produced
0 checked / 3 skipped with “Scan incomplete”. Clearing faults recovered
3 checked / 0 skipped. Every read-fault scan preserved the three file hashes
relative to the successful-checkbox state.

The version-3 harness embeds the exact SHA-pinned CI Carnet APK and loads its
actual compiled `expo.modules.filesystem.unifiedfile.SAFDocumentFile` class. It
invokes `outputStream()` for normal shorter `"wt"` writes,
`FileNotFoundException`/null `"wt"` fallback to `"w"`, and `SecurityException`
propagation without fallback. Actual execution returned result 0 with all four
cases passing: normal `"wt"` shorter rewrite had exact bytes and no tail;
`FileNotFoundException` and null each retried `"w"`; `SecurityException`
propagated with unchanged empty bytes and no `"w"` retry. Runtime phase/mode
logs establish these branches independently of the earlier source/APK approval.
Carnet's UI uses the legacy API; these are separate compiled-class harness results
from the tested CI APK. The TypeScript cache fix does not change that native method.
The controlled provider's `"w"` is nontruncating. Successful fallback from an
empty probe cannot certify shorter rewrites on nonempty `"w"`-only providers.

## Same-profile root replacement: cache isolation failed

Settings Save changed the sole Default profile from root A (provider root) to
root B (its genuinely picked `Notes` child tree) and back. Root B used newly
created empty capture subdirectories. Its view preferences started at defaults,
but Todos initially displayed cached tasks from A. A manual pull-to-refresh
cleared them and showed no checklist. No stale task was toggled.

Returning to A restored Completed and Group preferences and its completed task.
Source-title sorting was not confirmed on return, so full preference retention is
not claimed. Immediate task isolation failed despite the preference separation:
the tested APK caches the note index by profile without including the root.
The offline fix scopes note caches, mutation journals and refresh coordination to
profile plus root. Independent code review passed 90 focused tests, including
A → empty B, delayed old-root scans/upserts, root-specific throttling and return
to A. Shared build/typecheck/12 tests, mobile typecheck/lint/2,823 tests, capture-flow 763 tests, stale-plan and diff checks passed. All 407 source/test/native/dependency file hashes remained unchanged during verification. No new fixed build has been tested physically;
keep same-profile physical acceptance open until a fresh A → B → A run confirms
B has no stale A tasks before manual refresh.

## Handling and remaining limits

Unfolded-run restoration and owned profile/fixture cleanup are recorded above.
After the isolated phase, Android user 0 was confirmed current and owned user 11
was stopped and removed, including its private provider/root/probe data. Final
users were the original 0 and 10; only owned QA remote evidence files were removed.
The original profile/root and System appearance had been verified before user 11
was created; no further UI writes were made after returning.
Original notes were not independently byte-audited. In original Android user 0,
no vault writes, Settings Save, captures, provider/key changes, uninstall or Carnet
replacement occurred. Settings Save did run for the same-profile tests in isolated
user 11, whose private internal source was empty. Private app state,
credentials and device screenshots stay outside the repository. Independent final
read-only checks confirmed current user 0, only original users 0/10 and no remaining
fixture user-installation entries.

Real Syncthing transport, narrower layouts/fold transitions, unrestricted
query/filter permutations and #228 LLM re-enrichment remain outside this scope.
Controlled provider faults cannot establish every external-storage provider's
behavior. No LLM acceptance result is implied.

Local evidence: `/tmp/carnet-device-extended-qa.md`,
`/tmp/carnet-device-extended-independent.md`,
`/tmp/carnet-device-remaining-plan.md`,
`/tmp/carnet-saf-error-provider-build.md`,
`/tmp/carnet-extended-provider-runtime.log` and
`/tmp/carnet-extended-provider-final-snapshot.txt`. Temporary logs, hash comparisons and
screenshots referenced there are session evidence, not durable repository
artifacts. Maintained acceptance items remain in [TODO.md](../../TODO.md) and
[the smoke checklist](../smoke-test.md).
