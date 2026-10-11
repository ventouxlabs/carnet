# Todos discovery — 2026-10-11

Status: independently reviewed and verified automatically locally; physical acceptance pending.

Baseline: main `929de967`, after preservation #228 (`28a8032`) and SAF #229.
Working tree: `/tmp/carnet-todos-20261011`; branch: `feat/todo-discovery`.
This records local verification before publication; no PR number or merge is claimed.

Implemented: task text/source-title search; Open/Completed/All; capture-mode
and source-tag OR selections combined across filter categories; newest/oldest
source-date and source-title sorts; optional URI-based source grouping; view
preferences isolated by profile plus vault root. Markdown remains canonical.

Independent domain/UI revision review approved the exact 11 reviewed file hashes:
`/tmp/carnet-todo-ui-review.md`. Reviewed fixes propagate storage read I/O failures
while retaining malformed-JSON fallback, provide 48dp controls, preserve writer
ambiguity checks against matching text plus expected checkbox state, and isolate
asynchronous loads/writes across vault/profile changes. Sort/group ordinals maintain
row identity without authorizing ambiguous source writes.

Independent focused verification: 41 tests (UI 22, domain 9, preferences 10).
Final verifier checked 382 source hashes unchanged; aggregate:
`f2b81836a3578b024ea8f9d2e6d516fce986da6fe79bfa9d338d46f01905b100`.
Full gates: mobile 2,813 tests / 159 files; capture-flow 755 / 22; shared 12 / 1.
Both typechecks, mobile lint, stale-plan checks (0 violations / 4 plans) and diff
checks passed. The unchanged shared build was reused. Exact local evidence:
`/tmp/carnet-todo-final-verification.md`.

README explains behavior; TODO reconciles merged preservation/SAF work; the
Todos checklist in `docs/smoke-test.md` retains all physical acceptance steps.
No adb device is attached. Physical Todos, SAF and preservation acceptance remains
pending. No APK installation, real-vault or account action is claimed by this work.
No server, database, SQLite, dependencies or runtime configuration were added.
Publication is the orchestrator's next step; these documents do not assert it occurred.
