# Phase 1A Implementation Progress

This ledger is the single progress index for the local Phase 1A implementation. `Status:` remains the triage label; `Implementation:` is the lifecycle state. A completed Ticket must point to a local Git commit and a Ticket `Comments` entry.

| Ticket | Implementation | Commit    |
| ------ | -------------- | --------- |
| 01     | completed      | `b73461e` |
| 02     | completed      | `dfbeae6` |
| 03     | completed      | `9ccf7f6` |
| 04     | completed      | `d996d3b` |
| 05     | completed      | `0b7cba8` |
| 06     | completed      | `921654e` |
| 07     | completed      | `9970dff` |
| 08     | completed      | `4b38ac5` |
| 09     | completed      | `a5489b0` |
| 10     | completed      | `bc2a40b` |
| 11     | completed      | `aa26a5c` |
| 12     | completed      | `2c3431f` |
| 13     | completed      | `436c8d3` |
| 14     | completed      | `e661d4a` |
| 15     | completed      | `d027250` |
| 16     | completed      | `eb6d594` |
| 17     | not-started    | -         |
| 18     | completed      | `5e1972c` |
| 19     | completed      | `f1b00ee` |
| 20     | completed      | `1bd1ecf` |
| 21     | completed      | `8a65284` |
| 21.1   | completed      | `eeb063d` |
| 22     | completed      | `5ff5f72` |
| 23     | completed      | `95c09b3` |
| 24     | completed      | `a27a48c` |
| 25     | completed      | `58a7ebc` |
| 26     | completed      | `397a52d` |
| 27     | completed      | `4e316eb` |
| 28     | completed      | `ce5c27b` |
| 29     | completed      | `1c4c268` |
| 30     | completed      | `86b2fe7` |
| 31     | completed      | `fd15cee` |
| 32     | completed      | `5a6bf32` |
| 33     | completed      | `bd5260e` |
| 34     | completed      | `6017195` |
| 35     | completed      | `f30a45e` |
| 36     | completed      | `76e6577` |
| 37     | completed      | `c7e5880` |
| 38     | completed      | `b4168a4` |

Tickets 01–19 are historical records under a superseded product contract. Completed rows retain implementation evidence; an unstarted historical row is not part of, and does not block, the current v5.3 implementation sequence in Tickets 20–32. Tickets 20–32 have passed their respective Owner checkpoints. Tickets 31–32 are the v5.3 parity work identified by the v5.3 delta audit. Ticket 30's fixed correction commit is `86b2fe7`; the Project Owner accepted it from checkpoint commit `2858801`.

On 2026-09-09, the Project Owner accepted the `docs/test-plan-phase1a.md` §F.2 final end-to-end loop on checkpoint commit `894b6e4`. This closes the Phase 1A v5.3 implementation sequence; it does not evaluate or approve the Production Gate.

The Non-production Server Development Gate is `Passed`. Production Gate remains `Not Evaluated / Not Approved`. A completed Ticket never authorizes the next Ticket automatically; Project Owner confirmation is still required.

On 2026-09-18, Tickets 33–38 were specified for the ADR-0011 incremental-storage iteration: migration → unified reads → sparse publication → Checkpoint limits → deletion dependency cuts/cache → derived-version incremental submission protocol (UI unchanged). Ticket 33 completed on `bd5260e` and passed its Owner checkpoint at `4ea48a1`; Ticket 34 completed implementation on `6017195` and passed its Owner checkpoint on 2026-09-27; Tickets 35–38 remain not started. Tickets 33–37 retain legacy public writes; Ticket 38 enables delta writes only after the preceding lifecycle protections pass. This does not reopen the accepted v5.3 sequence or authorize implementation of later Tickets, main merge, push, or deployment.

On 2026-09-26, the Project Owner changed the planned acceptance cadence for Tickets 34–38 to four Owner checkpoints: 34, 35+36, 37, and 38. Ticket 35 still requires its own implementation authorization, automated evidence and report; Ticket 36 requires separate authorization before the combined checkpoint. Each checkpoint must contain small synthetic data ready for browser testing. After explicit acceptance, preserve evidence and release only that checkpoint's isolated containers, networks, volumes, test data and port. This was a planning change; Ticket 34 is now implemented, Tickets 35–38 remain not started, and Ticket 34 acceptance is recorded below.

On 2026-09-26, Ticket 34 unified legacy, Delta, and validated Checkpoint reads across the existing consumers on branch `codex/ticket-34-unified-version-resolution` at implementation commit `6017195`. A dedicated `evalbase-ticket34-owner-checkpoint` serves the same frontend/backend/Worker at loopback port 4214 with a small synthetic test set; health and browser smoke confirm the fixed SHA and equivalent visible records in three formats. Standards/Spec P0/P1 findings were repaired and rechecked; bounded Ticket Closure Review P0/P1 cleared at `6017195`. Owner acceptance was recorded on 2026-09-27. Ticket 35 is unblocked but not authorized to start; Production Gate is `Not Evaluated / Not Approved`.

On 2026-09-27, the Project Owner accepted Ticket 34 at implementation `6017195`. Its isolated checkpoint, and the previously accepted Ticket 33 checkpoint, were removed after their service logs, health responses, Compose status and SHA-256 manifests were saved under `local-acceptance-evidence/`. Both dedicated ports, networks, volumes and images were released; the formal `evalbase` deployment and other projects remain running. Ticket 35 is ready for separate authorization, not started. Production Gate remains `Not Evaluated / Not Approved`.

On 2026-09-27, the Project Owner authorized Tickets 35 and 36. Ticket 35 completed on branch `codex/ticket-35-sparse-publication` at implementation `f30a45e`: the internal Delta publisher writes only net changes and a canonical manifest while public writes remain legacy. Directed sparse, legacy and migration integration tests passed; Standards/Spec review has no unresolved P0/P1. Ticket 35 has no separate Owner checkpoint; the 35+36 browser checkpoint will use Ticket 36's fixed HEAD. Production Gate remains `Not Evaluated / Not Approved`.

On 2026-09-27, Ticket 36 implementation completed on branch `codex/ticket-36-checkpoint-limits` at `76e6577`. It schedules periodic Checkpoint work at the ADR-0011 20-generation/20% thresholds and atomically materializes a Checkpoint before publishing beyond 40 generations/40% of the baseline. The worker revalidates content and source references, retries idempotently, and skips deleted versions. Focused Ticket 36 and adjacent Ticket 35/34 tests passed; full host typecheck and targeted lint passed. Standards/Spec P0/P1 findings were repaired and rechecked. The combined 35+36 Owner checkpoint is pending at a fixed HEAD; Ticket 37 remains blocked until acceptance. Production Gate remains `Not Evaluated / Not Approved`.

The fixed 35+36 Owner checkpoint runs at `5b15133` on isolated `evalbase-ticket35-36-owner-checkpoint` with loopback port 4215, five synthetic browser-visible versions, and a real Worker-completed periodic Checkpoint job. Browser version links and same-origin records, provenance, data CSV and provenance CSV passed smoke validation. Bounded Ticket Closure Review P0/P1 cleared at `5b15133`; see Ticket 36 Comments for IDs, tests, remaining P2, and cleanup. Ticket 36's isolated test Compose and one orphan Ticket 33 test PostgreSQL container were released after checking ownership and activity. The combined checkpoint stays running for Owner acceptance; Ticket 37 remains blocked. Production Gate remains `Not Evaluated / Not Approved`.

On 2026-09-27, the Project Owner explicitly accepted the combined Tickets 35+36 checkpoint at runtime SHA `5b15133`. Local browser testing through the SSH tunnel verified all five version views, ordered records, v3 provenance detail, unchanged v4 derivative, periodic branch and CSV download. Health, Compose status, four service logs, version/job state, a browser-test summary and verified SHA-256 manifest are preserved under `local-acceptance-evidence/ticket35-36-owner-checkpoint-20260927/`. Ticket 37's prerequisite acceptance is satisfied, but implementation still needs separate Project Owner authorization. Production Gate remains `Not Evaluated / Not Approved`.

After acceptance, the exact `evalbase-ticket35-36-owner-checkpoint` Compose ownership of four containers, two networks and two volumes was verified. Those resources, the batch images, synthetic data and port 4215 binding were removed; the local SSH tunnel was closed. Cleanup logs and the empty remaining-resource audit joined the same SHA-256 verified evidence directory. The formal `evalbase` deployment and other projects were untouched.

On 2026-09-27, the Project Owner authorized Ticket 37. Implementation on `codex/ticket-37-deletion-cut-cache` completed at `c7e5880` (after initial commit `4179921`): deletion cuts protect every surviving boundary, scrub exclusive storage and historical preimages, preserve shared references and retry lists, and keep evidence-keyed CSV caches consistent with source changes. Public writes remain legacy and `frontend-v3` is unchanged. After the test database migration, focused Ticket 37 integration tests passed 19/19 and adjacent Tickets 34–36 tests passed 26/26; host typecheck and `git diff --check` passed. Standards/Spec review found no unresolved P0/P1. Targeted lint reports only an unchanged unused function at `src/server/app.ts:633`; broad suites were omitted in favor of deletion, failure, cache, and adjacent resolver coverage. The Project Owner has explicitly accepted this Ticket's checkpoint; the fixed-HEAD browser verification and dedicated resource cleanup are being recorded separately. Production Gate remains `Not Evaluated / Not Approved`.

On 2026-09-27, the Project Owner accepted the Ticket 37 checkpoint at fixed runtime SHA `c9b755f` and separately authorized permanent deletion of isolated synthetic v2. Local browser testing restored v3-b2, deleted v2 while preserving the graph and three parent edges, read all three 20-row descendants, inspected provenance, downloaded both CSVs, and confirmed the deleted version returned 404. Database checks found the target tombstoned and cleared, required dependency checkpoints on all descendants, and no deleted unique text in revisions or export cache. Logs, browser summary, cleanup audit and verified SHA-256 manifest are under `local-acceptance-evidence/ticket37-owner-checkpoint-20260927/`. The exact isolated four containers, two networks, two volumes, image, port 4217 binding and local SSH tunnel were removed after acceptance; the formal `evalbase` deployment and other projects were untouched. Ticket 38's prerequisite checkpoint has passed, but implementation requires separate Project Owner authorization. Production Gate remains `Not Evaluated / Not Approved`.

On 2026-09-27, the Project Owner authorized Ticket 38. Implementation on `codex/ticket-38-incremental-editor-cutover` completed at runtime code SHA `b4168a4`: the existing root and derived publication endpoints now write delta_v1 initial Checkpoints and net add/update/delete operations, while the frozen frontend editor loads parent records by page and preserves case-bound edits and retry state. The reused/narrowed/retired route inventory, tests, benchmark limits, and browser checkpoint evidence are recorded in Ticket 38 Comments. Standards/Spec review has no unresolved P0/P1. The isolated Owner checkpoint runs on port 4218; final acceptance and cleanup are recorded separately. No main merge, GitHub push, or formal deployment occurred. Production Gate remains `Not Evaluated / Not Approved`.

On 2026-09-27, the Agent passed Ticket 38's Owner checkpoint under the Project Owner's prior authorization to record a passing result, with separate action-time confirmation for the isolated synthetic v2 tombstone. At fixed runtime code SHA `b4168a4`, browser testing covered new delta v1/v2/v3, a paged legacy-parent branch, net changes, filters, source details, both CSVs, failed publish retry, Trash restore, tombstone dependency cut, and web/worker restart persistence. The v2 URL returned `version_not_found`; v3 retained three rows and a three-member `deletion_cut` Checkpoint. Evidence and verified SHA-256 manifest are under `local-acceptance-evidence/ticket38-owner-checkpoint-20260927/`. The exact Ticket 38 test and Owner Compose resources, image, port 4218 and local SSH tunnel were released; formal `evalbase` and other projects remain intact. No main merge, GitHub push or formal deployment occurred. Production Gate remains `Not Evaluated / Not Approved`.

On 2026-09-27, a pre-merge review repair on Ticket 38 added `4fd375b` and `328bc40` to the same branch. It bounds inherited-source lookup to one filtered request and makes consistency scans understand Delta Candidate/Version manifests. Targeted Standards/Spec re-review has no open P0/P1; isolated integration and capacity tests, unit tests, frontend build, typechecks, lint, docs and diff checks passed. The earlier Owner checkpoint acceptance remains fixed at `b4168a4`; the repaired HEAD has not received a new browser checkpoint. No main merge, push or formal deployment occurred. Production Gate remains `Not Evaluated / Not Approved`.
