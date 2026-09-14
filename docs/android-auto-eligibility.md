# Android Auto eligibility assessment

**Status:** approved pilot — self-messaging capture, re-scoped 2026-09-13.

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

## Pilot decision

Carnet must not claim the **media** category: that requires real audio playback,
a `MediaSession`, and a media-browser/library service. It also must not put its
ordinary vault browser or editor on a car display.

The approved pilot is instead a real **self-messaging** experience named *Drive
Inbox*:

1. Carnet exposes one conversation whose participant is the user themself.
2. A user dictates a short message through Android Auto's reply action.
3. Carnet receives the transcript through the notification reply receiver and
   enqueues a durable capture in the selected vault context.
4. Mark-as-read updates the local conversation state. Capture enrichment and
   note writing run asynchronously; neither is a car-screen operation.

This aligns the head-unit surface with Android Auto's messaging primitives:
`MessagingStyle`, reply and mark-as-read actions, and a conversation history.
It remains a **pilot**, not an assertion of broad Play-store eligibility. The
templated messaging route has limited distribution, and an eventual Play review
may decide that self-only messaging is outside its interpretation of user
communication.

## Pilot acceptance criteria

- No `MEDIA` category, `MediaSession`, media browser, navigation, or misleading
  app-category declaration.
- The car path is one self-conversation, with a reply action and a mark-as-read
  action; it cannot browse, edit, delete, or search vault content while driving.
- A reply is accepted exactly once, persists the raw text before enrichment,
  and pins the vault context selected when it was received.
- Notification permission/disabled notifications, empty transcription, duplicate
  delivery, and receiver/process restart are recoverable and tested.
- Android unit/instrumentation coverage and Desktop Head Unit validation precede
  a trusted-source, real-vehicle check. The user-facing distribution state stays
  beta/pilot until that evidence exists.

## Release gate

Before any broad distribution claim, verify current Play policy with a real
submission path and document the outcome. A policy rejection leaves the Android
Auto component disabled/experimental and does not affect ordinary phone capture.

## Sources

- [Android for Cars overview — supported app categories](https://developer.android.com/training/cars)
  (reviewed 2026-09-13).
- [Android for Cars App Library](https://developer.android.com/training/cars/apps/library)
  (reviewed 2026-09-13).
- [Android Auto overview](https://developer.android.com/training/cars/platforms/android-auto)
  (reviewed 2026-09-13).
