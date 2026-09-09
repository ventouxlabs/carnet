# Runbook — Carnet

Carnet has **no server or hosted backend**. "Operations" means building and installing
the Android app and configuring each device; notes sync peer-to-peer via Syncthing.
For architecture see [CODEMAPS/architecture.md](CODEMAPS/architecture.md).

## Build & install the Android app
Release APK (the script auto-installs to the attached device):
```bash
cd apps/mobile && ANDROID_HOME="$HOME/Android/Sdk" npm run android:release
```
- Pin a device when several are attached: `ANDROID_SERIAL=<serial> npm run android:release`.
- Dev (Metro) run: `npm run mobile`, then `npm -w @carnet/mobile run android`.
- After adding a **new native module**, run `npx expo prebuild -p android --no-install` first to autolink.

## First-run device configuration
1. **Choose an LLM provider** — in **Settings → LLM provider**, pick a preset
   (Relais (local) · OmniRoute · OpenAI · Groq · OpenRouter) or add a custom
   OpenAI-compatible entry, then set its base URL, API key and model. No `.env`; each
   provider's key lives on the device in SecureStore. A blank URL or model surfaces a
   "not configured" error (the vision model has no fallback by design — B1).
   **A local provider keeps note text on the handset** — Relais running on the phone
   serves `http://127.0.0.1:8080`, and the whole app (including the retrospective query)
   works in airplane mode. "Test connection" probes `GET /v1/models` with the key, so it
   validates the key as well as the host.
2. **Vault folder** — Settings → Storage → **"Pick folder"**. Use the picker, not the text
   field: a typed path becomes `file:///…`, which the app cannot read under Android's
   scoped storage, and the scan then silently finds nothing. A picked folder shows as a
   friendly label like `primary:carnet`. Saving a folder for the first time also migrates
   any notes captured before setup into it (non-destructive).
3. **Syncthing** — pair the device folder `/Documents/carnet/` with the workstation vault
   `~/Obsidian/Carnet/`. Full steps: [sync-setup.md](sync-setup.md).
4. **Karakeep** *(optional)* — to use per-note "Send to Karakeep" export, enter the instance URL
   + API key (Karakeep UI → User Settings → API Keys) in **Settings**. URL must be `https://`
   (loopback/`10.x` HTTP allowed for dev). Left blank, the export action surfaces "not configured".
5. **Smoke test** the capture modes once configured: [smoke-test.md](smoke-test.md).

## Health & monitoring
N/A — there is no service to monitor. "Healthy" = captures land in the vault and Syncthing
reports the folder in sync. Offline captures buffer in the on-device queue (AsyncStorage,
`lib/queue.ts`) and drain automatically on reconnect. Karakeep exports attempted while the
host is unreachable buffer separately (`lib/pendingSync.ts`) and auto-send on app
foreground once a reachability probe answers.

## Common issues
| Symptom | Cause / fix |
|---|---|
| Release build: `Cannot find module 'metro-runtime/package.json'` | npm pruned the hoisted copy. `metro-runtime` is pinned at the workspace root to keep it; re-pin to match `metro` after an Expo/metro bump. |
| Release build fails fetching gradle deps (`dl.google.com`) | This build env can't fetch **uncached** Google-Maven deps; a new native module needs its transitive deps pre-cached. |
| "Speech Services … Microphone permission is turned off" (STT) | The RECOGNIZER app's own mic permission was revoked (Android auto-revokes unused apps). Follow the in-app sheet: Open App info → enable Microphone → tap dictate again (a fresh tap re-tests, no restart needed). Via adb: `pm grant com.google.android.tts android.permission.RECORD_AUDIO`. |
| "No working speech service" (STT) | Failover exhausted: check a Google RecognitionService is installed (`voice/recognizerSelect.ts` pins Google) and the on-device speech model is downloaded — **Settings → Voice input → Check voice setup** (`voice/sttReadiness.ts`), or the sheet's Retry Detection. Error-decision logic: `voice/sttErrorPolicy.ts`. |
| Dictation stops by itself after ~20s of silence | By design: two consecutive quiet windows auto-stop and commit (`SILENCE_AUTO_STOP_AFTER` in `voice/sttErrorPolicy.ts`); 3-min hard cap regardless. |
| "Not configured" on capture | The ACTIVE provider's base URL or model is blank in Settings — re-enter on the device (each provider entry holds its own URL/model/key). NB: an app reinstall or `pm clear` wipes ALL settings incl. SecureStore keys and the vault-folder path; captures then land in app-private `files/carnet/` until the folder is re-set. |
| Karakeep export fails / "not configured" | Karakeep URL or key blank, or URL not `https://` (loopback/`10.x` HTTP excepted). Set both in Settings. Attachments sync incrementally per bookmark; a lost on-device record can re-upload a duplicate asset (harmless). |
| Karakeep export shows "unreachable — export queued" | Expected when the host doesn't answer (VPN/Tailscale down): the export waits in the pending-sync queue (`lib/pendingSync.ts`) and auto-sends on app foreground once the host is reachable. Home shows an "N exports waiting for Karakeep — Retry" banner; the banner count can lag a background drain until the screen refocuses. |
| "…is a file type Karakeep doesn't accept — kept in the vault only" | Not an error: the bookmark was created, but the server's asset allowlist (~images + PDF; `.txt`/`.docx` confirmed refused 2026-07-14/16) rejected the attachment. The file stays paired in the vault. Changing this means changing the server's allowlist, not the app. |

## Rollback
- **App:** install the previous release APK — every CI run's advisory `apk` job keeps a
  release-signed artifact for 14 days, and tagged releases attach `carnet-vX.Y.Z.apk`.
  Debug-signed installs can't upgrade release-signed ones (uninstall once to cross over;
  uninstalling wipes on-device settings, not the vault).
- **Data:** the vault is plain Markdown under Syncthing — restore from any synced peer or
  from Obsidian's file history. No migrations to reverse.
