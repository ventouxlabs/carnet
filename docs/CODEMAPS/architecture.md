# Architecture — Carnet
<!-- Generated: 2026-09-08 | Files scanned: 308 (171 src + 137 tests) | Token estimate: ~900 -->

Mobile-first knowledge capture. The Android app writes Markdown into a local folder;
Syncthing replicates it peer-to-peer into an Obsidian vault on the workstation. The app
requires **no server and no database**. An optional, independently deployable `mdcrm`
processor can derive contact/event records from schema-v1 captures; plain files remain the
source of truth.

## Workspaces (npm monorepo, v0.11.0)
- `apps/mobile`    — Expo SDK 54 / React Native 0.81 — the primary surface
- `apps/mdcrm`     — Node 20 CLI — optional Markdown validation, matching, review, and index pipeline
- `packages/shared` — `@carnet/shared` — TS types + markdown helpers (no app deps)

(`apps/desktop`, a Tauri placeholder stub, was deprecated and removed 2026-07-25 — see
`.claude/PRPs/plans/completed/desktop-fate.plan.md`.)

## Data flow
```
Capture (Idea / Journal / Contact / Photo / Audio / Share / notification inline-reply)
  → backend dispatcher            lib/dispatcher.ts  (ALL backend-divergent calls cross it;
       selects one of N configured providers — Relais (local) / OmniRoute / OpenAI / Groq /
       OpenRouter presets + custom entries, lib/llmProviders.ts — with a fallback chain)
  → enrich via LLM client         lib/llmClient.ts   (OpenAI-compatible /v1/chat/completions;
       vision on visionModel; stream:false always. NOTHING imports lib/omniroute.ts directly)
  → sanitize LLM output           lib/enrichSanitize.ts  (B3, at the executeChat chokepoint)
  → render Markdown               lib/writer.ts
  → write local folder            {captureFolderPath}/{Ideas,Journal,Notes,People,Photos,Attachments}
        │  (offline → lib/queue.ts buffers in AsyncStorage, drains when online)
        │  (Idea/Journal default SAVE-FIRST: file lands instantly, enrichment patches after — B4)
        ▼  Syncthing p2p
  ~/Obsidian/Carnet/              workstation vault (Obsidian opens it directly)

Retrospective query (v0.11.0 — ask about the notes on screen in Search)
  → lib/retrospective.ts  orderCandidates → pickForRead (MAX_NOTES 12)
  → lib/vault.ts          readNoteBodies (SCAN_CONCURRENCY 8, abortable, frontmatter stripped)
  → lib/retrospective.ts  packBodies (per-note + total char budget)
  → lib/dispatcher.ts     askVault  → same provider seam as every other call
  → sanitize + resolveCitations   ([[Title]] linkifies ONLY if in the retrieval set)
  → ephemeral in AskScreen; explicit Save → writer.writeSynthesis → Notes/{slug}.md
        + upsertNoteInIndex (so it appears in Search without a manual refresh)

Optional schema-v1 capture package
  → apps/mdcrm filesystem adapter → validate / match / review / derive / index
  → Markdown contacts, organizations, events, interactions, and processing jobs

Export (opt-in, per note, from RecentDetail)
  → lib/karakeepNoteExport.ts → lib/karakeep*.ts (HTTPS REST)
  → self-hosted Karakeep: bookmark + tags + assets
        │  (host unreachable, status-0 → lib/pendingSync.ts queues; drains on app
        │   foreground once lib/hostReachability.ts probe answers — VPN/Tailscale-aware)
```

## Layer boundaries
- **UI** `screens/` (11), `components/` (40) — capture + review + search + ask
- **Domain** `lib/` (100 modules, each with co-located tests) — enrichment (dispatcher
  seam covers ALL backend-divergent calls incl. transcribe/OCR/listModels), sanitize,
  markdown/frontmatter, vault IO behind the `VaultFs` seam (SAF/file:// selected once)
  + tag/search index + sync-conflict detection, offline queue + pending-sync (Karakeep)
  queue over shared scaffolding, shared HTTP-client security core (`httpClient.ts`),
  save-first flows, related-notes scoring, cold-start budget, settings, net allowlist
  (B0 SSRF/host hardening), Karakeep export, host reachability, notification capture
- **Voice** `voice/` — on-device STT: recognizer detection/failover (`recognizerSelect`),
  pure error-decision ladder (`sttErrorPolicy` — restart latching, silence auto-stop,
  mic-revoked classification), onboarding/readiness
- **Native bridges** `bridges/` + `editor-web/` (TenTap WebView WYSIWYG)
- **Optional processor** `apps/mdcrm` — LLM-free Phase 1 CLI, JSON Schemas, atomic
  filesystem repository, deterministic matching, review records, disposable full-text index
- **External** — one *configurable* LLM provider (Relais on-device / OmniRoute /
  OpenAI / Groq / OpenRouter / custom; a local provider means nothing leaves the
  handset), Karakeep (export), Syncthing (sync), Android STT RecognitionServices,
  camera/mic/location

## Security invariants
No `.env`; runtime config entered in-app (keys in SecureStore). `netAllowlist.ts` pins
outbound hosts. Frontmatter stays byte-compatible with existing vault files.

See `backend.md` (device pipeline + integrations), `frontend.md` (screens),
`data.md` (vault schema + stores), `dependencies.md` (integrations).
