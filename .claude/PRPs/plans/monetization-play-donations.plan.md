# Monetization: paid Google Play listing + donation links

Status: in-progress

## Context / decision (2026-08-22)

A feature-gated "pro unlock" was considered and rejected: AGPL-3.0 makes gates
trivially strippable, F-Droid/IzzyOnDroid builds would ship from source with
gates flipped, and the app's "no server, no account" constraint (CLAUDE.md)
leaves nowhere to validate entitlements. Chosen instead:

1. **Paid convenience listing on Google Play** — the same app, priced ~$3–5,
   free forever on GitHub Releases and IzzyOnDroid. Honest framing: pay for
   Play auto-updates and to support development.
2. **Donation links** — GitHub Sponsors (and optionally Liberapay) surfaced in
   the README, `.github/FUNDING.yml`, and a "Support development" row in the
   Settings screen.

Nothing here gates features; the FOSS distribution channels are unaffected.

## Track 1 — Google Play paid listing

### Human actions (blocking; cannot be automated)

- [x] Play Console developer account: **already exists — Ventoux Labs
      organization account** (confirmed by JD 2026-08-22). Org accounts are
      not subject to the personal-account 12-testers/14-days closed-test
      requirement, so nothing gates production publishing except the
      remaining checkboxes below.
- [ ] Set up the payments/merchant profile (required to sell a paid app).
- [ ] Accept Play App Signing. **Consequence:** Google holds the app signing
      key, so the Play build's certificate differs from the pinned self-signed
      release fingerprint used on GitHub/Izzy. Users cannot cross-upgrade
      between channels — document this; it is expected, not a bug.
- [ ] Complete the Data safety form (should be trivially clean: no data
      collected/shared; declare user-configured endpoints) and content rating
      questionnaire.

### Repo work (agent-executable)

- [x] **Privacy policy**: `PRIVACY.md` written (2026-08-22) — raw GitHub URL
      serves as Play's hosted privacy-policy link.
- [x] **AAB build path**: `build-release-apk.sh --aab` runs `bundleRelease`
      with the same injected signing (keystore becomes the Play *upload* key)
      and skips the adb-install step. First upload stays manual; do NOT wire
      Play upload into `release.yml` until the listing is live — and
      `release.yml`'s cert-fingerprint verification must never run against
      the AAB (Play App Signing re-signs downloads).
- [x] **Feature graphic**: generated 1024×500 at
      `fastlane/metadata/android/en-US/images/featureGraphic.png` via
      `scripts/generate-feature-graphic.sh` (reproducible; Stamped Paper
      tokens + bundled Space Grotesk/Inter).
- [x] **Store listing copy**: existing fastlane copy fits Play limits —
      title 6/30, short description ~75/80, full description 2166/4000.
- [x] targetSdk verified from the prebuild chain: resolves to **36**
      (Expo SDK 54 default via ExpoModulesCorePlugin) — above Play's 35 floor.
- [x] **Docs**: README "Get Carnet" section added — three channels, pricing,
      cross-upgrade caveat, PRIVACY.md link.

## Track 2 — Donations

### Human actions (blocking)

- [ ] Enroll in GitHub Sponsors (verified 2026-08-22: neither `bearyjd` nor
      `Entrevoix` has a listing today) and/or create a Liberapay account.
      Requires identity + payout (Stripe) setup.

### Repo work (agent-executable, after handle exists)

- [ ] `.github/FUNDING.yml` with the real handle(s). Do not commit
      placeholder handles — a bad handle renders a broken Sponsor button.
- [ ] README support section (one paragraph + badge).
- [ ] Settings screen: a "Support development" link row opening the sponsor
      URL via `Linking.openURL`. Extract nothing new — this is a wiring
      change; add a smoke assertion to `SettingsScreen.test.tsx` per the
      existing screen-test pattern.

## Ordering

With the Ventoux Labs org Play account already in place, Track 1 has no
calendar gate — repo work (privacy policy, AAB path, feature graphic, README)
proceeds immediately; the remaining human steps are merchant profile, Play App
Signing acceptance, and the Data safety / content rating forms. Track 2 still
waits on Sponsors/Liberapay enrollment.

## Non-goals

- No license keys, feature flags, or entitlement checks anywhere.
- No Play-exclusive features; the Play APK/AAB is functionally identical.
- No hosted paid service.
