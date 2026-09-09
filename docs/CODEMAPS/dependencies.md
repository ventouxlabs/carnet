# Dependencies & integrations
<!-- Generated: 2026-09-08 | Files scanned: 308 (171 src + 137 tests) | Token estimate: ~760 -->

## External services

**The LLM backend is a user-chosen provider, not a fixed service.** `lib/dispatcher.ts`
is the only seam app code calls; it resolves one of N configured entries and applies a
fallback chain. **`lib/omniroute.ts` and `lib/localLlm.ts` no longer exist** — both were
consolidated into the single `lib/llmClient.ts` (701 ln), which speaks OpenAI-compatible
HTTP to whichever provider the dispatcher resolved. Older docs and archived plans still
name them; that is history, not drift.

| service | role | code |
|---|---|---|
| Configured LLM provider | ALL AI calls: chat + vision enrichment, card OCR, transcription routing, `listModels`, and `askVault` (retrospective query) — OpenAI-compatible, always `stream:false` | `lib/dispatcher.ts` → `lib/llmClient.ts`; presets in `lib/llmProviders.ts` (Relais (local) · OmniRoute · OpenAI · Groq · OpenRouter) plus custom entries; per-provider URL/model in Settings, per-provider key in SecureStore |
| Relais (on-device, optional) | a local OpenAI-compatible server running **on the handset** — when it is the active provider, note text never leaves the device, and the whole app works in airplane mode | no app code; reached over loopback like any other provider |
| Karakeep (self-hosted) | opt-in per-note export → bookmark + tags + asset attachments (HTTPS REST `/api/v1`) | `lib/karakeep.ts`, `lib/karakeepExport.ts`, `lib/karakeepAssetSync.ts`; URL + key in Settings (key in SecureStore) |
| Syncthing | p2p folder sync (device local folder ↔ workstation vault) | no app code — runs alongside |

`lib/netAllowlist.ts` decides which hosts may be reached and which may use plain `http://`
(loopback + private ranges + the 100.64/10 CGNAT range, i.e. Tailscale). That predicate
answers "is this transport trusted enough for plaintext" — it is reused as a UX-locality
signal (e.g. whether to show the retrospective query's send-notes disclosure), not as a
credential gate. See PR #176.

## Native / Expo (`apps/mobile`)
- `expo` ~54, `react-native` 0.81 (New Architecture)
- `expo-location` ~19 — device coords → `lib/location.ts`
- audio recording → `AudioCaptureScreen`, `lib/audioDecoder.ts`, `lib/audioTranscribeOnDevice.ts`
- camera + OCR/vision → `PhotoCaptureScreen`, `CardScannerModal` → `ocrCardViaVision()` via `lib/dispatcher.ts` (impl in `lib/llmClient.ts`)
- STT — `expo-speech-recognition` (patched: `patches/expo-speech-recognition+3.1.3.patch`
  fixes a native double-settle crash) → `voice/`; no cloud STT fallback (Whisper removed 5090f33)
- Share intake — `expo-share-intent` 5.1.1 (patched: `patches/expo-share-intent+5.1.1.patch`,
  Kotlin + JS hunks — crash-proof `getFileInfo`, stream-backed text/plain routing, and
  `contentUri` threaded through the JS parser; re-verify BOTH hunk sets on any bump) →
  `App.tsx` ShareIntentRouter, `ShareReceiveScreen`, `lib/shareHelpers.ts`
- `expo-intent-launcher` ~13 — App-info deep link on the mic-revoked recovery sheet;
  accessed ONLY via `requireOptionalNativeModule` (static import crashes pre-rebuild clients)
- `@10play/tentap-editor` 1.0.1 — WYSIWYG (editor-web bundle + `MarkdownBridge`)
- `@react-native-async-storage/async-storage` — offline queue, settings, note/tag index, Karakeep asset record, one-time-disclosure flags
- `expo-secure-store` — one API key **per LLM provider entry**, plus Karakeep's
- `expo-document-picker` / `expo-sharing` — attachments

(`apps/desktop`, a Tauri + React stub, was deprecated and removed 2026-07-25 — see
`.claude/PRPs/plans/completed/desktop-fate.plan.md`.)

## Shared
`@carnet/shared` — types + markdown helpers; imported by mobile.

## CI
`.github/workflows/ci.yml` — jobs: **shared → mobile · mobile-android (parallel) →
gate** (required check) + advisory **apk** (release-signed artifact, 14-day retention).
`mobile-android` runs Expo prebuild + `gradlew :app:compileDebugKotlin` (catches native/config-
plugin regressions). Shared Android toolchain via `.github/actions/android-toolchain`.
`release.yml` on `v*.*.*` tags builds + verifies + publishes a signed APK. See CLAUDE.md.
