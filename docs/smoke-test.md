# Carnet — Real-device smoke test

End-to-end verification you can run with an Android phone running carnet, a
workstation hosting the OmniRoute / navetted **LLM gateway** (reachable over
HTTPS), and Syncthing pairing the capture folder with your vault. Run this
before tagging a release or after any change touching capture handlers, the
writer/frontmatter layer, the offline queue, sync, or Karakeep export.

There is **no daemon, no QR pairing, no token handshake** — all configuration is
entered in-app on the **Settings** screen. Tick boxes inline as you go; most
steps take under a minute.

**Automated coverage:** most of the logic below (frontmatter shape, slug
collision, same-day journal append, tag/vault indexing, WYSIWYG frontmatter
preservation, and fixture-driven repro of the four historical bug classes) is
already exercised headlessly — no device needed:

```
npm -w @carnet/mobile run verify:capture-flow
```

This runs `writer.test.ts`, `frontmatter.test.ts`, `queue.test.ts`,
`vault.test.ts`, `vaultSearch.test.ts`, `journalTagIndex.test.ts`,
`markdownRoundTrip.test.ts`, and `test/fixtures/repro.test.ts`. Sections below
are annotated with `(automated coverage: ...)` where automated tests already
check the underlying logic; the manual steps remain necessary for anything
device-only (voice/OCR, real share-sheet, Syncthing, Karakeep network calls).

**Invariant (issue #91):** every section containing a `- [ ]` checklist states
either the command that covers its logic or `device-only`, so a reader never has
to guess whether a manual step is redundant. Some annotations name a suite
outside `verify:capture-flow` — that script is the fast capture-flow gate, not
the whole test suite. If you add a section, annotate it. (`When something
fails` is prose, not a checklist, and is exempt.)

---

## Prerequisites

_(device-only: these are the physical/toolchain preconditions for running the
rest of the checklist — an attached device, a working adb, a synced vault.)_

- [ ] Phone has carnet installed (Expo Go or a dev/release build)
- [ ] Workstation runs the OmniRoute / navetted LLM gateway, reachable from the
      phone over HTTPS (same Tailscale net or LAN)
- [ ] Syncthing pairs the device folder `/Documents/carnet/` with the workstation
      vault `~/Obsidian/Carnet/` — see [sync-setup.md](sync-setup.md)
- [ ] *(Optional)* A reachable Karakeep instance + API key, for the export tests

## Todos discovery and completion

_(device-only: keyboard, scrolling, checkbox interaction, profile/root switching,
and real Syncthing refresh. Automated filtering, preference isolation and screen
wiring coverage passed locally: `npm -w @carnet/mobile test -- todoView todoViewPreferences TodosScreen` (41 focused tests).
The [implementation handoff](session-handoffs/2026-10-11-todo-discovery.md) records the
initial no-device session; the later [physical follow-up](session-handoffs/2026-10-11-pixel-10-fold-verification.md)
records folded Pixel 10 Pro Fold checks in light and dark themes. Checked boxes below
apply to that fixture run, not general acceptance across devices.)_

- [x] Prepare notes with distinct dates, modes and tags; include open and
      completed tasks, duplicate task text, and two distinct files sharing a title.
      Open **Todos** and confirm default Open view, newest source note first.
- [x] Search for task text, then a source title. Clear the query; compare **Open**,
      **Completed**, and **All** against the source Markdown checkboxes (7/3/10).
      Verify keyboard input and scroll to the final task. Light and dark layouts passed.
- [x] Select multiple modes and tags: any selected mode and any selected source
      tag match; mode, tag and status requirements combine. Clear filters
      and confirm hidden tasks return.
- [x] Compare **Newest**, **Oldest**, and **Source**. Date order follows source
      note dates, not a newly invented task timestamp. Enable source grouping;
      distinct files with identical titles must remain distinct groups.
- [x] Complete and reopen a task whose text is unique within its source note;
      confirm only that original checkbox changes on disk. Open the source note
      and check the result. Identical text in a different note must remain unchanged:
      completion targets the selected source URI.
- [x] Try completing a task whose matching text and checkbox state appear more
      than once in the same source note. Confirm the ambiguity notice appears,
      the file remains unchanged, and the optimistic checkbox change rolls back.
      Sorting and grouping must retain row identity without allowing an ambiguous write.
- [x] Leave and reopen Todos, then restart Carnet; confirm view choices persist.
- [x] Switch profiles using the same owned root; confirm each profile retains its
      own view choices and returning restores them. A fresh profile showed default
      Open/newest/ungrouped; the first restored Completed/Source/grouped.
- [ ] Change the root within a profile; confirm choices and tasks belong to the
      active root and return when switching back. Use a disposable setup: Settings
      Save also migrates existing internal captures, so this run avoided it.
- [ ] Exercise query/filter combinations beyond the separate text/title searches
      and combined mode/tag/status checks above.
- [ ] Repeat layout, keyboard and scrolling checks unfolded.
- [ ] Edit task text/status on the workstation and allow Syncthing to finish.
      Refresh Todos; confirm the changed source appears without stale tasks.

## SAF shorter rewrite and historical-tail review

_(device-only: real provider truncation and review-dialog interaction. Automated
coverage: `npm -w @carnet/mobile test -- writerSaf vault safTailDetector HomeScreen`.
The [2026-10-11 physical follow-up](session-handoffs/2026-10-11-pixel-10-fold-verification.md)
used only disposable fixtures through Android's external-storage SAF provider.)_

- [x] Replace a longer fixture with shorter rich text through Carnet; pull the
      file and verify frontmatter is retained and the old tail is absent (143 → 69 bytes).
- [x] Scan a fixture vault with ten candidates; verify 13 checked, 0 skipped and
      10 candidates. Scroll the bounded list and confirm Close stays accessible.
- [x] Open a visible candidate; confirm navigation reaches its source note.
      Compare all fixture file bytes before/after the scan to verify read-only behavior.
- [ ] Exercise the modern file-system API and a provider rejecting `"wt"`.
- [ ] Exercise partial and unreadable scans on a safe disposable provider.
- [ ] Repeat candidate-dialog layout checks unfolded.

## First launch & configuration

_(automated coverage: `npm -w @carnet/mobile test -- settings` — the
secure-store/AsyncStorage split is pinned by `settings.test.ts` (keys go to
`expo-secure-store`, never the persisted blob) and `settingsPersistence.test.ts`.
First-launch boot order and the absence of a pairing screen are device-only.)_

- [ ] Fresh install (or wipe AsyncStorage): launch carnet. App boots straight to
      **Home** — there is no pairing/QR screen.
- [ ] **Settings** → set the **OmniRoute URL** + **API key**.
- [ ] *(Optional)* set the **Karakeep URL** + **API key**.
- [ ] Keys live in `expo-secure-store`, not AsyncStorage: on a dev build, inspect
      AsyncStorage — `carnet:settings:v1` holds the URLs + non-secret prefs but
      **no API-key/token field**.

## Cold-start budget

(Automated: `src/lib/startupTiming.test.ts` covers the classifier/latch;
this device check verifies the real number.)

_(automated coverage: `npm -w @carnet/mobile test -- startupTiming`; the real
cold-start number is device-only by nature.)_

- [ ] Force-stop the app, relaunch from the launcher, then
      `adb logcat -d | grep "\[startup\]"`. **No line containing `EXCEEDS`**
      may appear (release builds only log on a budget breach). A breach means
      a recent change regressed launch speed — capture latency is the
      product's moat; treat it like a failing test, not a note.

## Capture — Idea (golden path)

_(automated coverage: `npm -w @carnet/mobile run verify:capture-flow` — frontmatter shape via
`writer.test.ts`/`frontmatter.test.ts`)_

- [ ] Home → **Idea** → type a sentence ("test idea — verifying smoke flow").
- [ ] Tap **Send**. A loading state shows while the gateway enriches.
- [ ] After a few seconds a preview card renders with the markdown + filepath.
- [ ] Status chips are visible (e.g. `seedling` selected / `developing` / `mature`).
- [ ] Tap **Save** → returns Home; the capture appears at the top of **Recents**.
- [ ] On the workstation, `Ideas/<slug>.md` has valid Obsidian frontmatter
      (`created`, `status`, `tags`).

## Promote idea status

_(automated coverage: `npm -w @carnet/mobile run verify:capture-flow` — mtime conflict guard via
`writer.test.ts` and `test/fixtures/repro.test.ts`)_

- [ ] Repeat the idea capture; this time tap **developing** in the preview card
      before Save. The markdown re-renders.
- [ ] Reload the file: frontmatter now reads `status: developing`, and the body
      is byte-identical to the seedling version (only the status line changed).
- [ ] Tap **mature** → reload → frontmatter `status: mature`.

## Capture — Journal (voice + same-day append)

_(automated coverage: `npm -w @carnet/mobile run verify:capture-flow` — same-day append/merge
via `writer.test.ts`, `journalTagIndex.test.ts`, and
`test/fixtures/repro.test.ts`; voice dictation itself is still device-only)_

- [ ] Home → **Journal** → press and hold the voice button, dictate a sentence,
      release. The transcript field populates.
- [ ] *(Optional)* type extra notes in the bottom field.
- [ ] **Send** → preview → **Save**.
- [ ] `Journal/YYYY-MM-DD.md` exists with frontmatter and a `# <summary>` heading.
- [ ] Capture a **second** journal entry the same day → reload the file: it now
      holds **both** entries separated by a `## HH:MM` heading; the first is intact
      and its per-entry metadata (tags / location) merged into the day file.

## Capture — Person (with the LLM gateway)

_(automated coverage: `npm -w @carnet/mobile run verify:capture-flow` — Person frontmatter shape
and file placement via `writer.test.ts`/`frontmatter.test.ts`. Card OCR itself
is device-only: it needs a real camera and a reachable vision model.)_

- [ ] Settings → OmniRoute URL set and reachable.
- [ ] Home → **Contact** → **Scan card** → camera opens → **Capture** on a real
      business card. OCR runs; the OCR text field populates.
- [ ] Add a context note ("met at conference X") → **Send** → preview → **Save**.
- [ ] `People/<Firstname-Lastname>.md` exists with frontmatter (`name`, `company`,
      `email`, …).

## Capture — Person (without the gateway)

_(automated coverage: `cardScanOutcome.test.ts` pins the three-way
notConfigured / permanent / transient classification, `llmClient.test.ts` pins
the not-configured error shape. The banner copy and the manual-entry flow are
device-only. `omniroute.test.ts` no longer exists — that client merged into
`llmClient.ts` in #120.)_

- [ ] Settings → clear the provider URL (or the vision model) → Save.
- [ ] Home → **Contact** → **Scan card** → the camera still opens. The scanner no
      longer blocks up front: the original image is written *before* OCR is
      attempted, so a failed OCR never loses the card.
- [ ] After **Capture**, the banner names the real cause and does NOT tell you to
      scan again: *"… not configured — set it in Settings. Your card image was
      saved — scanning again won't help until this is set."*
- [ ] Turn the provider back on but point it at an unreachable host → the banner
      instead says *"OCR unavailable — … Scan again to retry"*. The two cases must
      not read the same; only one of them is worth retrying.
- [ ] Type the OCR text + context manually → **Send** → **Save** → the file still
      lands on disk.

## Capture package on a SAF vault (`content://` folder picker)

_(automated coverage: `writerSaf.test.ts` → "nested subdirs (SAF)" — but only
against a **mock**. Real SAF behaviour is device-only, and this is exactly where
a nested-directory bug already shipped once: the mock stored a flat map, so
`"attachments/originals"` looked like a legal single key and the whole suite
stayed green while capture silently failed on a real vault.)_

- [ ] Settings → capture folder → pick a folder with **Android's folder picker**
      (this yields a `content://` SAF URI, not a plain filesystem path).
- [ ] Home → **Contact** → **Scan card** → **Capture**.
- [ ] In the vault, both nested paths exist as **real nested folders**:
      `attachments/originals/att_*.jpg` and `processing/results/cap_*.ocr.txt`.
      A single folder literally named `attachments/originals` (slash in the name)
      means the segment walk regressed.
- [ ] `captures/cap_*.md` exists, and its frontmatter `path:` and
      `raw_text_path:` resolve to those two files.

## Offline queue (capture while unreachable)

_(automated coverage: `npm -w @carnet/mobile run verify:capture-flow` — queue persistence/drain
logic via `queue.test.ts`; the airplane-mode/force-quit device behavior
itself is still manual)_

- [ ] Put the phone in airplane mode (or stop the gateway). Capture an idea →
      **Send**. The capture is buffered on-device (AsyncStorage, `lib/queue.ts`),
      surfaced as queued — **not** a wedged UI or a lost note.
- [ ] Re-enable the network → the queue **drains automatically** and the note
      lands in the vault.
- [ ] Force-quit the app while a capture is queued → relaunch → the queue persists
      and drains on reconnect. No orphaned/partial file in the vault (atomic
      tmp+rename write).

## At-rest encryption upgrade (queue + drafts)

_(automated coverage: `npm -w @carnet/mobile test -- queueCrypto captureDraft` —
the envelope, key handling, and the legacy-plaintext migration are unit-tested.
The device check below exists because the unit tests stub `expo-crypto` and
`expo-secure-store`: they cannot prove `getRandomBytesAsync` works under Hermes,
nor that a real upgrade over real queued data survives.)_

- [ ] **Install a build from before the encryption change**, capture 2-3 items
      while offline (airplane mode) so they sit in the queue, then **upgrade
      in place** to a current release build (do NOT uninstall — that wipes the
      queue and defeats the test).
- [ ] Open the app. The pending-sync count still shows the same number of items.
- [ ] Restore connectivity → the queue drains and every captured note lands in
      the vault. **Nothing is silently dropped** — a decryption failure is
      reaped as a corrupt row, so a migration bug shows up as vanished captures.
- [ ] On a dev build, inspect AsyncStorage: `carnet:queue:v1` and
      `carnet:capture_draft:v1:*` values start with `carnet-q1:` and contain no
      readable capture text.
- [ ] Type into a capture form, background the app, force-stop it, relaunch →
      the draft is restored (proves encrypt+decrypt round-trips on-device).

## Rich edit (WYSIWYG / RecentDetail)

_(automated coverage: `npm -w @carnet/mobile run verify:capture-flow` — byte-intact frontmatter
across body-only edits via `markdownRoundTrip.test.ts`)_

- [ ] Open a note from Recents → **RecentDetail**. The TenTap WYSIWYG editor loads
      the body; tags chip, geo chip, and attachments render.
- [ ] Make an edit → **Save** → reload the file: the change persisted and the
      frontmatter header is byte-intact (no block collapse — the #1 WYSIWYG
      corruption mode).

## Karakeep export (optional)

_(automated coverage: `npm -w @carnet/mobile test -- karakeep` — bookmark body
composition, re-export/update vs duplicate, incremental asset sync, the
not-configured error, and the unsupported-file-type notice are covered by
`karakeepNoteExport.test.ts`, `karakeepAssetSync.test.ts`, `karakeepExport.test.ts`
and `karakeepExportUi.test.ts`. The network calls against a live instance are
device-only.)_

- [ ] Settings → Karakeep URL + API key set.
- [ ] Open a note → **Send to Karakeep** → snackbar *"Exported to Karakeep"*. On
      the Karakeep instance: a text bookmark with the note body + the note's tags,
      and any image/file attachments uploaded as assets.
- [ ] **Re-export** the same note → confirm dialog *"This note is already in
      Karakeep. Update the existing bookmark…"* → **Update** → snackbar *"Updated
      in Karakeep"*. The **same** bookmark updates — no duplicate is created.
- [ ] Add a new image/file attachment to the note → re-export → **only the new
      attachment** is pushed; previously-synced assets are not duplicated
      (incremental asset sync).
- [ ] With the Karakeep URL blank, **Send to Karakeep** surfaces a "not configured"
      error instead of failing silently.
- [ ] Sharing/attaching a non-image, non-PDF file (e.g. `.txt`) and exporting →
      snackbar notes *"…is a file type Karakeep doesn't accept — kept in the vault
      only"*; the bookmark exists without the attachment (server allowlist, expected).

## Karakeep pending-sync queue (host unreachable)

(Device-verified end-to-end 2026-07-16; automated coverage:
`src/lib/pendingSync.test.ts`, `pendingSyncRunner.test.ts`, `hostReachability.test.ts`.)

- [ ] With the Karakeep host unreachable (airplane mode, or Tailscale off for a
      tailnet host): **Send to Karakeep** → after the ~20s timeout, snackbar
      *"Karakeep is unreachable — export queued…"* (NOT the red error banner).
- [ ] Home shows *"N export(s) waiting for Karakeep — will send when the server is
      reachable"* with a **Retry** button; tapping Retry while still offline is a
      fast no-op (~4s) and the banner stays.
- [ ] Restore connectivity → background then re-foreground the app → the queue
      drains automatically (no Retry tap); the note gains a `karakeepId` and the
      banner clears on the next Home focus (count may lag one focus — known).

## Voice setup (STT onboarding)

_(device-only: recognizer availability, on-device model download, and the
readiness banner all depend on the device's speech services. Exercising the
model-missing path needs a device without the English model — see the
`pixel-stt-device-recognizer-health` note.)_

- [ ] **Settings → Voice input → Check voice setup** reports the recognizer/model
      state: "ready", or an offer to **Download voice model** when the on-device
      English model is missing (the code-12 dictation dead-end).
- [ ] On a device that lacks the English model, the Home screen also shows a
      one-shot readiness banner once. (Both attached Pixels currently have the
      model, so this path needs a model-less device to exercise.)

## Unicode + collision edge cases

_(automated coverage: `npm -w @carnet/mobile run verify:capture-flow` — slug collision and
non-Latin H1 handling via `writer.test.ts` and `test/fixtures/repro.test.ts`)_

- [ ] Capture an idea titled `Mémoire & flux` → file lands at
      `Ideas/memoire-flux.md` (transliterated, not "untitled").
- [ ] Capture another idea that resolves to the same slug → `Ideas/memoire-flux-2.md`
      (collision suffix). The original file is untouched.


## When something fails

1. Note the step, the observed vs. expected behavior, and the relevant vault file
   if one landed wrongly.
2. **Enrichment** failures → check the OmniRoute URL + key in Settings and that the
   gateway is reachable from the phone (Tailscale/LAN).
3. **Export** failures → check the Karakeep URL + key, that the URL is `https://`
   (loopback/`10.x` HTTP excepted), and that the instance is reachable.
4. File an issue with the step number, logs, and the offending vault file/frontmatter.
