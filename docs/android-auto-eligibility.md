# Android Auto eligibility assessment

**Status:** blocked by platform eligibility — assessed 2026-09-13.

Carnet is a personal note-capture application. It is not a media, messaging,
calling, navigation, point-of-interest, IoT, weather, game, browser, or video
application. It must not declare one of those categories merely to place a
capture button on a car head unit.

## Finding

Android's current supported-app-category list does not include generic personal
note capture. The Android for Cars App Library documents navigation, POI, IoT,
and weather as its application categories, and requires an app to belong to a
supported category and meet its design requirements. Android Auto's overview
also limits parked apps to supported parked-app categories.

Consequently, adding `com.google.android.gms.car.application`, a template,
`CarAppService`, or `CAR_LAUNCHER` metadata would not make Carnet an eligible
Android Auto app. It would create an unsupported claim and no useful testable
product behavior.

## Decision

Do not implement Android Auto integration under the current product definition.
The roadmap item is complete as an eligibility decision, not as a head-unit
binary. A later proposal may explore a phone-side, driver-safe voice capture
flow; it must be named and scoped as phone capture rather than Android Auto.

## Re-open criteria

Re-open only if all hold:

1. Carnet gains a legitimate supported use case/category, confirmed against
   current Android-for-Cars policy.
2. The design meets distraction requirements and has a product owner for its
   road-safety behavior.
3. The implementation is source-owned (Expo config plugin/native source), uses
   `expo prebuild`, and has Desktop Head Unit plus real-vehicle/trusted-store
   verification as applicable.

## Sources

- [Android for Cars overview — supported app categories](https://developer.android.com/training/cars)
  (reviewed 2026-09-13).
- [Android for Cars App Library](https://developer.android.com/training/cars/apps/library)
  (reviewed 2026-09-13).
- [Android Auto overview](https://developer.android.com/training/cars/platforms/android-auto)
  (reviewed 2026-09-13).
