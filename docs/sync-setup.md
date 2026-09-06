# Syncthing Setup for carnet v0.2

carnet uses [Syncthing](https://syncthing.net) to sync captured notes from your
Android phone to your workstation Obsidian vault — no cloud, no daemon required.

## Prerequisites

- carnet v0.2 installed on Android
- OmniRoute URL + API key configured in carnet Settings
- Syncthing installed on both devices (see below)

---

## 1. Install Syncthing

### Workstation (Linux / macOS / Windows)

Download from [syncthing.net/downloads](https://syncthing.net/downloads/) or
install via your package manager:

```bash
# macOS (Homebrew)
brew install syncthing
brew services start syncthing

# Linux (systemd)
sudo apt install syncthing
systemctl --user enable --now syncthing

# Windows
winget install SyncthingProject.Syncthing
```

Syncthing's web UI is at <http://localhost:8384> after start.

### Android

Install **Syncthing** from:
- [Google Play Store](https://play.google.com/store/apps/details?id=com.nutomic.syncthingandroid)
- [F-Droid](https://f-droid.org/packages/com.nutomic.syncthingandroid/)

> **Battery optimization**: Go to Android Settings → Apps → Syncthing →
> Battery → select "Unrestricted". Without this, Android may kill Syncthing
> in the background, delaying sync.

---

## 2. Pair the Devices

1. Open Syncthing on your workstation (web UI at <http://localhost:8384>)
2. Open Syncthing on Android
3. On Android: tap ☰ → **Show device ID** (QR code)
4. On workstation web UI: click **Add Remote Device** → scan or paste the Android device ID
5. Confirm the pairing on Android when prompted

---

## 3. Share the carnet Folder

### On Android (sender)

1. First, give carnet a folder on shared storage: in carnet → Settings →
   Storage, tap **Pick folder** and choose (or create) a folder such as
   `/storage/emulated/0/carnet`, then **Save**. The system picker is what
   grants carnet access to that folder — on current Android, *typing* a
   shared-storage path into the field does not work (the app holds no
   storage permission, so it can't read a path it wasn't granted). Existing
   sandbox captures are moved into the folder on that first save.
2. In Syncthing Android, tap **+** to add a folder
3. Set **Folder Path** to the same folder you picked in step 1
4. Set **Folder ID** to `carnet` (must match workstation)
5. Under **Sharing**, enable sharing with your workstation device
6. Save

> Don't try to sync the default app-sandbox location
> (`/data/user/0/com.ventouxlabs.carnet/files/carnet`) — it's private to
> carnet, so Syncthing can't read it. A shared-storage folder chosen via
> **Pick folder** is the supported route.

### On Workstation (receiver)

1. Syncthing will show a pending folder share from your Android device
2. Click **Add** on the notification
3. Set the local path to your Obsidian vault subfolder:
   ```
   ~/Obsidian/Carnet/
   ```
4. Set folder type to **Receive Only** (workstation doesn't send edits back)
5. Save and wait for initial sync

---

## 4. Configure carnet

In carnet → Settings:
- **Capture folder** should already point at the folder you picked in
  step 3 (shown as a label like `primary:carnet`). If not, use **Pick
  folder** — not the text field — then **Save**. Leave it empty only if you
  don't want to sync (default app sandbox).
- Enable **OmniRoute (experimental)** toggle
- Configure **OmniRoute URL** and **API key**

---

## 5. Verify End-to-End

1. Open carnet on your phone
2. Capture an idea (tap Idée → type → Envoyer → Enregistrer)
3. Within ~30 seconds, the file should appear in `~/Obsidian/Carnet/Ideas/`
4. Open Obsidian and confirm the note renders correctly

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Files not syncing | Check Syncthing is running on both devices; verify folder ID matches |
| Syncthing killed on Android | Disable battery optimization for Syncthing (see step 1) |
| Permission denied on folder / captures not appearing | In carnet → Settings → Storage, choose the folder with **Pick folder** (not by typing the path) and tap **Save** — the picker is what grants carnet access on current Android |
| Obsidian doesn't see new files | Obsidian vault → ⋮ → Reload vault |

---

## Offline Captures

If OmniRoute is unreachable (airplane mode, no WiFi), carnet queues your
captures locally. When you reconnect:
- carnet drains the queue automatically on next app open
- Files appear in the Syncthing folder and sync to Obsidian normally

Queue depth is shown in the capture screen ("N captures en attente de sync").
