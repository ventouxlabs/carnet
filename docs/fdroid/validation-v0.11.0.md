# Main F-Droid v0.11.0 validation

Date: 2026-10-18

Status: **Blocked for main F-Droid inclusion** by the camera/location dependencies described
below. The local source build and APK identity/signature checks passed.

Scope approved by the maintainer: refresh and locally validate the recipe for the
existing v0.11.0 release (versionCode 9). This does not submit an application or
establish acceptance by main F-Droid.

## Recipe requirements

The latest build must use the published tag, regenerate the editor bundle from
source, produce an unsigned APK, and discover future versions from Expo's
`apps/mobile/app.json`. The historically validated v0.7.0 and v0.9.0 blocks
remain as records of their build procedures.

The [F-Droid metadata reference](https://f-droid.org/docs/Build_Metadata_Reference/)
defines the build phases and update checks. The
[inclusion policy](https://f-droid.org/docs/Inclusion_Policy/) governs source and
dependency review. Passing a local scanner or build does not establish that all
dependencies meet that policy.

## Validation results

The isolated build checks out tag `v0.11.0`, resolving to
`ab1762060327ed77cacb52fbc7d212d6d347bd77`. Its Expo configuration declares
version `0.11.0` and versionCode `9`.

Local evidence remains under `/tmp/carnet-fdroid-validation-20261018` (a symlink
to the persistent workspace described below):

- `env.sh` records the isolated tool/cache setup.
- `diagnostic-metadata/` preserves the enabled recipe used for the build.
- `logs/` contains metadata, update discovery, scanner and build output.
- `tmp/com.ventouxlabs.carnet_9.apk` is the diagnostic unsigned APK.

The actual build command, with the enabled diagnostic metadata installed in that
workspace, was:

```bash
cd /tmp/carnet-fdroid-validation-20261018
source env.sh
export PYTHONPATH="$PWD/python-tools"
fdroid build --verbose --stop --test com.ventouxlabs.carnet:9
```

This records the diagnostic run. The final recipe is deliberately disabled;
ordinary builds must remain blocked until the dependency issues are resolved.

With fdroidserver 2.4.5, `fdroid readmeta`, `fdroid lint`, and
`fdroid checkupdates --verbose` passed. Tag discovery read `0.11.0` / `9`
from `apps/mobile/app.json`.

The local toolchain was Node 26.8.1, npm 12.2.0, JBR 21.0.5, Gradle 8.14.3,
Android build-tools 36.0.0 and NDK 27.1.12297006. This is a local toolchain
result, not a test of the current F-Droid buildserver image or the recipe's
Debian package-install step.

`fdroid build --verbose --stop --test` succeeded for versionCode 9 using the
enabled diagnostic metadata. This rebuilt shared JavaScript and the editor
bundle from source, then completed the Android release build in 4m23s (690
tasks).

| Artifact check | Result |
| --- | --- |
| Package | `com.ventouxlabs.carnet` |
| Version | `0.11.0`, versionCode `9` |
| Compile / target SDK | `36` / `36` |
| ABIs | All four upstream ABIs |
| Size | 109,926,062 bytes |
| SHA-256 | `f2b8438d9b91fd89e0604616419e392279bf1100d5159b85a934a5c341e73f59` |
| Signing | Unsigned: `apksigner verify` exited 1 with missing `META-INF/MANIFEST.MF` |

`aapt2` read the package/version/SDK fields successfully. The expected
`apksigner` failure demonstrates that this diagnostic output has no APK signing
certificate; it is not an installable signed release.

The first diagnostic build passed dependency installation, Expo preparation,
shared compilation and editor regeneration, then failed during Gradle cache
writes with `Disk quota exceeded`. The `/tmp` user quota was reached even
though `df` reported free space. No APK was produced by that attempt. The retry
uses an isolated validation workspace and caches on the persistent project volume,
under ignored `.omc/fdroid-validation-cache-20261018/`. The original
`/tmp/carnet-fdroid-validation-20261018` path is retained as a symlink. An early
cache-only retry was deliberately stopped before relocating the whole workspace
to provide room for native build outputs as well.

## Inclusion blocker found during validation

The locked `expo-camera` 17.0.10 declares Google ML Kit barcode scanning,
Google Play Services code scanning, and CameraX's ML Kit integration in
`node_modules/expo-camera/android/build.gradle`. These are unconditional
dependencies in this version. The inherited broad `node_modules` scanner
exceptions hide the finding: a diagnostic scan without those exceptions
reported 87 fatal findings, including `com.google.mlkit` in that Gradle file.
Not every diagnostic finding has been classified, so 87 does not mean 87
separate proprietary dependencies.

The locked `expo-location` 19.0.8 also declares
`com.google.android.gms:play-services-location:21.0.1` in
`node_modules/expo-location/android/build.gradle`. Removing the camera libraries
alone would therefore not resolve the inclusion blocker.

A refreshed scan of the actual APK exited 1 and reported 3,389 class matches,
including ML Kit code-scanner/barcode packages and Google Play Services
`LocationSettingsRequest`. That count represents scanner matches, not distinct
dependencies. The source declarations and binary findings agree that the Google
libraries reach the packaged APK.

This blocks claiming the draft is ready for main F-Droid inclusion. The locked
camera plugin does not support the newer `barcodeScannerEnabled` option, and
deleting dependency declarations alone would break native compilation: multiple
Kotlin camera modules reference the APIs. A camera dependency change or maintained
native patch needs separate implementation and validation, along with a compatible
location implementation.

Relevant evidence files are `logs/scanner-without-exceptions.log`,
`logs/apk-scanner-verbose.log`, `logs/apk-badging.log` and `logs/apksigner.log`.
The successful build is `logs/build-v9-persistent.log` with its `.exit` file;
`logs/final-*` record parsing, lint and disabled-build checks.

The local scanner initially encountered an incompatible system `magic` binding.
It was rerun with isolated `python-magic` 0.4.27, whose PNG detection was checked.
That corrected run still passed only with the broad exceptions; it does not
resolve the dependency blocker.

## Submission boundary

F-Droid signs the unsigned output with its own key, following the existing
distribution decision. That installation cannot update an upstream-signed
GitHub installation in place. No reproducible match to the upstream APK is
claimed. F-Droid's buildserver and maintainers must still review the submission.

The final draft disables the app and automatic build updates until the dependency
blocker is resolved. The enabled recipe used for diagnostic validation is retained
separately in the validation workspace; it must not be submitted as an eligible
build. Version discovery configuration remains available for future validation.

Final `fdroid readmeta` and `fdroid lint` passed with those guards enabled. An
ordinary build attempt without `--force` exited 1 with `No apps to process`,
before compilation. The top-level `Disabled` reason covers historical build
blocks as well as versionCode 9, while `AutoUpdateMode: None` prevents creating
new automatic build entries from a blocked recipe.

## Independent verification

A separate verifier approved this recipe refresh and local-validation report.
It independently recomputed the APK hash and size, checked package/version and
signature evidence, inspected native dependency declarations and binary scanner
matches, and verified the final metadata/lint and disabled-build results. That
approval covers local validation and accurate blocker reporting, not F-Droid
inclusion or an external submission.

See the [submission guide](https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/)
and [fdroiddata contributing instructions](https://gitlab.com/fdroid/fdroiddata/-/raw/master/CONTRIBUTING.md)
for the external workflow. The [Izzy request status](izzyondroid-submission.md)
is separate from this main F-Droid preparation.
