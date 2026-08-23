# IzzyOnDroid submission (Phase 1 of #182)

Submit as a new issue at <https://gitlab.com/IzzyOnDroid/applists/-/issues>
(requires a GitLab account), titled:

    Add: Carnet (com.ventouxlabs.carnet)

The body below matches their issue template's fields (package name / other
store link / category and group / additional links) with the full app details
appended after the divider. Copy-paste it verbatim:

```
### Package name:
com.ventouxlabs.carnet

### Link to app in another app store:
None — distributed via GitHub Releases only: https://github.com/ventouxlabs/carnet/releases

### Category and group:
* Writing
* Note taking

### Useful additional links:
* Source code: https://github.com/ventouxlabs/carnet
* Releases (APK attached to each, tag pattern v*.*.*, asset name carnet-vX.Y.Z.apk): https://github.com/ventouxlabs/carnet/releases
* Fastlane metadata (descriptions, per-version changelogs, screenshots) maintained in-repo: https://github.com/ventouxlabs/carnet/tree/main/fastlane/metadata/android/en-US

---

**App name:** Carnet
**Application ID:** com.ventouxlabs.carnet
**License:** AGPL-3.0-only
**Latest release:** v0.9.0 (versionCode 7)

**Description:** Mobile-first Markdown capture for an Obsidian vault. Notes are
plain .md files written into a folder the user syncs themselves (e.g. with
Syncthing) — no server, no database, no account. Optional LLM enrichment talks
only to endpoints the user configures (self-hosted or on-device); nothing is
preconfigured to a remote service.

**Signing:** Upstream self-signed. The release workflow independently verifies
the APK certificate against a pinned SHA-256 before publishing
(.github/workflows/release.yml); current fingerprint:
e5f5ed37e098e0da7b09a59734845b21c986a18d1994bbdb670d01e3c7a3eaf7

**Size note:** current APK is ~117 MB. This is the unstripped Expo SDK 54 /
React Native 0.81 baseline (Hermes + per-ABI native libs); no bundled ML
models. Happy to discuss per-ABI splits if size is a concern for the repo.

**Privacy:** no trackers, no analytics, no crash reporting that leaves the
device; API keys stored via Android Keystore (expo-secure-store). Network
access only to user-entered endpoints plus optional self-hosted Karakeep.
```

After acceptance, Izzy's updater pulls each new tagged GitHub Release
automatically — no changes needed to the release workflow. The in-repo
fastlane metadata feeds the store page (descriptions, changelogs,
screenshots).

Note: the "Latest release" line reflects submission time (v0.9.0); no need to
keep this file updated afterward — Izzy tracks releases directly.
