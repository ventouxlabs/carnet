# F-Droid v0.11.0 recipe refresh and validation

Status: shipped

Approved: 2026-10-18 by the user (refresh and validate the v0.11 recipe).

## Scope

- Correct the stale Izzy status, preserving the historical submission body.
- Extend the main F-Droid recipe for existing tag v0.11.0 / versionCode 9.
- Verify update discovery against Expo's source configuration and review source-build requirements.
- Run metadata parsing/lint and the recipe build in an isolated workspace.
- Inspect the resulting APK for package/version and absence of a signing certificate.
- Record reproducible commands, results, and any validation limits; obtain independent review.

## Constraints

Preserve the historically validated build blocks. Keep F-Droid signing with its own
key; do not change application identity, dependencies, release tags, or app behavior.
Do not push or submit externally without authorization. Existing local user changes
remain untouched. Main F-Droid acceptance is outside local validation.

## Acceptance evidence

Metadata passes fdroid readmeta/lint. A real build from the published tag produces
an unsigned APK with the identity and version read from apps/mobile/app.json.
Update discovery reads the same source version. Any environment-only workarounds
and scanner/reproducibility limitations are explicit in the report.

## Findings

Preparation completed locally on 2026-10-18; no external submission or release.
Metadata parsing, lint and tag/version discovery passed. The diagnostic source build
succeeded and APK identity/unsigned checks passed. The locked camera and location modules
include ML Kit/GMS libraries; the broad inherited scanner exclusions
hide those findings. The final draft disables the app and automatic updates; parsing,
lint and refusal of an ordinary build verified those guards. Inclusion readiness is
blocked and is not an outcome of the successful diagnostic build. Independent review
and evidence are recorded in docs/fdroid/validation-v0.11.0.md.
