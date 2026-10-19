# IzzyOnDroid request status (#182)

Checked 2026-10-18. Carnet is not available through IzzyOnDroid. IzzySoft
[closed request #37 on 2026-08-23](https://gitlab.com/IzzyOnDroid/applists/-/work_items/37#note_3722364952):
the request used the wrong tracker (`applists` handles store links for
android.izzysoft.de, where GitHub-only distribution does not qualify), and
the APK exceeded the repository's usual 30 MB size limit.

Separately, the [current inclusion policy](https://izzyondroid.org/docs/general/AppInclusionPolicy/)
rejects apps with AI-generated code and integrations with the LLM services
covered by its AI policy. These are additional eligibility blockers for Carnet,
not the reasons recorded in the closure above. Reducing APK size alone would
not establish eligibility.

The latest [GitHub release](https://github.com/ventouxlabs/carnet/releases/tag/v0.11.0)
is v0.11.0 (versionCode 9), with a 109,942,442-byte APK (about 110 MB).
GitHub Releases remains the available APK channel. Main F-Droid is a separate,
unsubmitted route. The [v0.11.0 validation report](validation-v0.11.0.md)
records camera/location dependency blockers; acceptance has not been established.

## Historical submitted body

The body below was already submitted as `Add: Carnet (com.ventouxlabs.carnet)`.
It is preserved as a historical record, including v0.9.0/versionCode 7 and
the size and endpoint descriptions at submission time. It is not a current
submission template.

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
