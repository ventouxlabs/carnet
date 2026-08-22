# Carnet Privacy Policy

**App:** Carnet (`com.ventouxlabs.carnet`) · **Publisher:** Ventoux Labs ·
**Last updated:** 2026-08-22

Carnet is a local-first note-capture app. There is no Carnet server and no
account: your notes are plain Markdown files written to a folder on your
device that you own and sync yourself (e.g. with Syncthing).

## What we collect

Nothing. Carnet has no analytics, no trackers, no advertising SDKs, and no
telemetry. Crash diagnostics, when enabled, are written to local files on your
device and never transmitted anywhere by the app.

## Where your data lives

- **Notes, photos, and voice-memo transcripts** are stored as files in the
  capture folder you choose (or the app's private sandbox if you don't).
  They leave your device only through whatever sync tool *you* configure.
- **Settings and the offline capture queue** are stored in the app's local
  storage on your device.
- **API keys** (for your LLM endpoint and optional Karakeep instance) are
  stored in the Android Keystore via `expo-secure-store`, never in plaintext.

## Network access

Carnet makes network requests only to endpoints you enter yourself in
Settings:

- **Your LLM endpoint** (self-hosted or on-device relay) — receives capture
  text and, for photo/card captures, the image, solely to produce the
  enrichment you requested. Nothing is preconfigured; if you configure no
  endpoint, captures still save locally without enrichment.
- **Your Karakeep instance** (optional) — receives a note and its attachments
  only when you explicitly tap "Send to Karakeep".

There are no other destinations. The app never phones home to Ventoux Labs.

## Device permissions

- **Microphone** — voice capture and dictation. Speech-to-text uses the
  speech-recognition service installed on your device (e.g. Google's); whether
  that service processes audio on-device or in the cloud is governed by that
  service's own settings and policy.
- **Camera** — business-card and photo capture. Images are saved locally and
  sent only to your configured LLM endpoint for OCR/vision enrichment.
- **Notifications** — the optional quick-capture notification.
- **Storage / folder access** — writing notes into the capture folder you
  select.

Each permission is requested only when the corresponding feature is first
used, and every feature degrades gracefully if you decline.

## Your data, your exit

Everything Carnet produces is plain Markdown and ordinary image files in a
folder you control. Uninstalling the app removes its private storage
(settings, queue, keys); files in an external capture folder are untouched.

## Changes and contact

This policy changes only via a public commit to this file in the app's
source repository: <https://github.com/Entrevoix/carnet>. Questions or
concerns: open an issue there.
