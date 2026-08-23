<!-- glowup:hero start -->
<div align="center">
<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner.svg">
    <img src="docs/assets/banner-light.svg" alt="Carnet — mobile-first knowledge capture for Obsidian" width="880">
  </picture>
</h1>

[![Build](https://img.shields.io/github/actions/workflow/status/ventouxlabs/carnet/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=build)](https://github.com/ventouxlabs/carnet/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-7C5CE0?style=for-the-badge)](https://www.gnu.org/licenses/agpl-3.0)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Expo](https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white)
![React Native](https://img.shields.io/badge/React_Native-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Tauri](https://img.shields.io/badge/Tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=black)
![Obsidian](https://img.shields.io/badge/Obsidian-7C3AED?style=for-the-badge&logo=obsidian&logoColor=white)

</div>
<!-- glowup:hero end -->

## Get Carnet

| Channel | Price | Notes |
|---------|-------|-------|
| [GitHub Releases](https://github.com/ventouxlabs/carnet/releases) | Free | APK attached to every `vX.Y.Z` tag |
| [IzzyOnDroid](https://android.izzysoft.de/) | Free | F-Droid-compatible repo (listing pending review) |
| Google Play | Paid | Same app, convenience pricing — auto-updates and supports development (listing in preparation) |

All channels ship the identical app; nothing is feature-gated. The Play build
is signed by Play App Signing, so a Play install and a GitHub/Izzy install
can't upgrade each other — pick one channel per device. Privacy policy:
[PRIVACY.md](PRIVACY.md).

## Architecture

```
ANDROID MOBILE (Expo + RN)                  WORKSTATION
┌───────────────────────────────┐          ┌──────────────────────────┐
│ Capture screens               │          │                          │
│  ├ Idea (text)                │          │  ~/Obsidian/Carnet/      │
│  ├ Journal (voice→text)       │  HTTPS   │     Ideas/{slug}.md      │
│  ├ Person (camera→OCR)        │ ───────► │     Journal/YYYY-MM-DD.md│
│  └ Photo (camera→vision)      │          │     People/F-L.md        │
│         │                     │          │     Photos/{slug}.jpg    │
│         ▼                     │          │            ▲             │
│  lib/omniroute.ts (LLM)       │          │            │             │
│  lib/prompts.ts               │          │     Syncthing daemon     │
│  lib/writer.ts (md to disk)   │          │            ▲             │
│  lib/queue.ts (offline)       │          │            │             │
│         │                     │          │            │             │
│         ▼                     │          │            │             │
│  Local folder ────────────────┼──────────┼─► carnet/ folder         │
│  /Documents/carnet/           │ Syncthing p2p                       │
│         │                     │                                     │
│         ▼                     │                                     │
│  Syncthing Android app        │                                     │
└───────────────────────────────┘          └──────────────────────────┘

   NO DAEMON. NO CUSTOM RUST. NO HMAC HANDSHAKE.
```

Five capture modes:

| Mode | Input | Output |
|------|-------|--------|
| `idea`    | text / dictation            | `Ideas/{slug}.md` (save-first: file lands instantly, enrichment patches after) |
| `journal` | voice transcript (+ text)   | `Journal/{YYYY-MM-DD}.md` (appends to existing) |
| `person`  | business card scan (vision OCR) + dictated context | `People/{Firstname-Lastname}.md` |
| `photo`   | in-app camera (+ voice/text context) | `Photos/{slug}.jpg` + paired `Ideas/{slug}.md` (via OmniRoute vision) |
| `audio`   | voice memo                  | recording + on-device transcription → journal |

All modes go through OmniRoute for LLM enrichment, then write directly to the local capture folder. Offline captures are queued on-device (AsyncStorage) and drained on reconnect. Photo capture shares the same vision pipeline used by the Android share-target (Share → carnet on an image). Quick captures also work from the persistent notification's inline reply, and the vault is browsable/searchable in-app (tags + full text).

Any note can optionally be pushed to a self-hosted **Karakeep** instance from its detail screen ("Send to Karakeep" → text bookmark + tags + image/file attachments). Export is opt-in and configured per device.

## Layout

```
carnet/
  apps/
    mobile/          Expo 54 + React Native + TypeScript
    mdcrm/           Optional Markdown contact/event processor + CLI
  packages/
    shared/          @carnet/shared — note types + markdown helpers
  docs/
    sync-setup.md    Syncthing setup guide (Android + workstation)
```

## Prerequisites

- Node 20+
- npm 10+
- For mobile: Expo CLI and a physical Android device or emulator
- An **OmniRoute API key** (set in the app's Settings screen)
- **Syncthing** installed on both your Android device and workstation — see [docs/sync-setup.md](docs/sync-setup.md)

No daemon, no navetted, no Rust toolchain required for mobile development.

## Build

```bash
# Install once at root (postinstall applies patches/ via patch-package)
npm ci

# Build the shared package (types + markdown helpers)
npm run build:shared

# Run mobile in Expo
npm run mobile

# Type-check
npm -w @carnet/mobile run typecheck
npm -w @carnet/shared run typecheck

# Build/test the optional server-side Markdown processor
npm run mdcrm:build
npm run mdcrm:test
```

## Configuration

Open the **Settings** screen in the app and set:

| Setting | Description |
|---------|-------------|
| OmniRoute URL | Base URL of your OmniRoute instance (e.g. `https://llm.grepon.cc`) |
| OmniRoute API key | Your API key — stored in the OS secure keystore via `expo-secure-store` |
| Capture folder | Path to your Syncthing-watched folder on Android (e.g. `/storage/emulated/0/carnet`). Leave blank to use the app sandbox. |
| Karakeep URL | *(Optional)* Base URL of a self-hosted Karakeep, for per-note export (e.g. `https://keep.example.com`) |
| Karakeep API key | *(Optional)* Karakeep API key (Karakeep UI → User Settings → API Keys) — stored via `expo-secure-store` |

### Syncthing sync

See [docs/sync-setup.md](docs/sync-setup.md) for step-by-step instructions to pair the Android capture folder with `~/Obsidian/Carnet/` on your workstation.

## License

AGPL-3.0-only
