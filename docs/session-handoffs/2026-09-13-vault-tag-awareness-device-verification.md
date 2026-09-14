# Session handoff — 2026-09-13 (vault tag awareness device verification)

S3 is merged in [PR #215](https://github.com/ventouxlabs/carnet/pull/215) and
its prior evidence handoff in [PR #217](https://github.com/ventouxlabs/carnet/pull/217)
is also merged. This record closes the remaining on-device checks; it does not
claim the soft prompt hint has a measured causal benefit.

## Pixel 9 results

The Pixel 9 Pro Fold (`4A111FDKD0000C`) ran a current release-signed APK with
the local Relais provider live at `127.0.0.1:8080` and the existing
`Documents/carnet` SAF vault grant.

| Check | Result |
|---|---|
| Enabled happy path | With a refreshed vault containing `travel` and `Austria`, `Neutral travel test: plan a travel to Austria.` produced `[idea, seedling, travel, austria]`. |
| Disabled handoff | A temporary, release-only dialog immediately before `llmClient.enrichIdea` showed `enabled=false; cached=4; passed=0`. The warm cache had four tags, and the false arm passed an empty list. |
| Cold start | After `pm clear com.ventouxlabs.carnet`, an immediate Idea capture returned to the save-first confirmation in roughly five seconds: no vault walk blocked capture. |

The disabled-handoff probe logged only the toggle state and array lengths. It
did not expose note content, tag values, provider configuration, or keys.

## Limits and cleanup

`pm clear` also removes provider credentials and the SAF permission. Therefore
the cold-start run verifies capture timing only; it cannot show a successful
enrichment or directly inspect the resulting empty prompt. The positive sample
and disabled handoff prove device behavior, but one stochastic model output is
not evidence that the hint caused improved tag selection. The deferred
canonicalizer remains an evidence decision, not a known defect.

All temporary Idea files were deleted. The Relais configuration and vault grant
were restored on-device, tag reuse was saved as enabled, and a normal signed
release APK (with the temporary dialog removed) was reinstalled. The focused
dispatcher suite passed: 31 tests.

The durable plan and TODO status are updated in
`.claude/PRPs/plans/vault-tag-awareness.plan.md` and `TODO.md`.
