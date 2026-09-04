# MemoryPanel evidence and review

`Evidence & review` is a scoped extension of the established MemoryPanel Tea console. It makes recorded TaskRun evidence inspectable and reviewable; it does not introduce a new visual identity, create work, or change an asset's lifecycle.

## Where it appears

- Workbench task detail and supported Skill, Wiki, Code, and Chat-memory details expose **Usage evidence** filtered to that task or asset.
- The Workbench **Evidence & review** navigation provides team-level run discovery, candidate-source filtering, and asset-enabled run comparison.
- Asset access is identified by its asset ID, type, version, and content digest. Chat-memory evidence is associated with its memory asset ID, not attributed to an individual memory block.

## UI conventions

- **Progressive metadata disclosure.** Run identifiers, task/agent context, variant, evaluation group, base commit, receipt revision, and contribution level live under the run-metadata disclosure. Raw receipts, events, claims, diffs, validations, and candidate records remain available in native disclosures rather than overwhelming the primary review path.
- **Server evidence is authoritative.** The interface renders the receipt and derived states returned by Core. It cannot mark an asset `used`, `validation_passed`, or `contributed`; a usage claim is not reviewed use, and a passing validation is not proof of contribution.
- **Independent audits.** Usage review applies to one `run_id` + `access_id`; reviewers choose support, not support, or uncertain, give a reason, and link behavior, diff, or decision evidence. Candidate-content approval/rejection is a separate audit, retaining source diffs, validations, and audit events.
- **Comparison is observational.** The view selects recorded `without_assets` controls in the same evaluation group and reports inputs, outcomes, cost metrics, deltas, and contamination as recorded. Missing metrics display as `—`, never zero. A matched control and a positive delta do not by themselves establish causality.
- **Failure and absence are explicit.** Loading, retryable API errors, no selected team, no runs, no matching access, no candidates, and no controls use the console's existing status/alert patterns. The UI does not infer runs from participation data and does not backfill history.
- **Responsive scope.** At 640px and below, only the Evidence route's existing console shell wraps its header and tightens content padding; run rows and facts stack, while wide comparison tables retain horizontal scrolling. Other MemoryPanel routes retain their incumbent shell.
- **Bilingual copy.** Evidence labels, safeguards, empty/error states, and audit guidance ship in English and Simplified Chinese. Add or change a user-facing convention in both locales.

## Product boundaries

For the repaired standalone Skill ingestion path and explicit local command capture, see [the verification guide](asset-evidence-verification.md). This does not imply all asset types or service deployments are supported.

- Candidate approval does **not** publish a Skill, Wiki page, code asset, or memory. Publication remains an explicit asset-specific workflow.
- This view does **not** launch agents, create TaskRuns, execute experiments, or automatically record evaluations.
- Only recorded evidence is displayed; there is no automatic historical-session backfill.
- Panel forwards the user's key through its instance registry. Core authenticates it and enforces team membership; review operations require a team reviewer/administrator or system administrator. Browser-supplied reviewer identity is not trusted.

## Storage and deployment limits

Standalone evidence uses SQLite under `TDAI_EVIDENCE_SQLITE_BASE_DIR`, falling back to `TDAI_METADATA_SQLITE_BASE_DIR`, then `./data/metadata`. Put that directory on persistent storage and back it up. Data from the prior in-memory implementation does not survive restart and cannot be recovered after one.

Service-mode evidence remains unavailable until a shared durable evidence-store adapter is configured. The gateway does not silently fall back to process memory. This feature has been exercised locally with SQLite and HTTP; it is not a claim of MongoDB, multi-node, or general production readiness.

## Reproducible local demo

The demo starts a real local Core gateway and a real Panel server, seeds synthetic data through the HTTP APIs, and uses temporary SQLite metadata/evidence directories. It binds loopback only and deletes the temporary directory on `Ctrl-C`; it does not read production configuration.

```sh
cd MemoryPanel
npm run build --prefix web
node --import tsx scripts/evidence-panel-demo.ts
```

Open the printed Panel URL, select login instance `evidence-demo`, and enter the printed local key. The seeded run includes an asset access, observed behavior, diff, linked passing validation, supported usage review, and an asset-enabled/control comparison. It is synthetic data only.

Optional `EVIDENCE_DEMO_GATEWAY_PORT` and `EVIDENCE_DEMO_PANEL_PORT` select different loopback ports. If either is occupied, stop the conflicting local process or choose unused values before starting the demo.

## Verification completed

- Core: 24 evidence tests across four files, including scoped idempotency, SQLite failure-injection rollback, receipt history, and state derivation.
- Panel: 11 tests across four files, including the real Core/Proxy-runtime/workspace/Panel-BFF integration with multiple user roles.
- Proxy: 13 protocol/runtime/stream tests across two files. The local workspace collector has six Node tests.
- Panel backend type checking, frontend production build, and new evidence UI linting pass. Core's bundle build also passes; this does not assert a clean full-repository type check.
- Browser checks verified the task-detail entry, disabled support submission without linked proof, successful linked submission and receipt revision, candidate approval with visible reviewer/reason/timestamp, and the missing-control baseline warning. Desktop and 390px mobile captures passed the final review.

The browser checks above are the original Panel presentation checks. The repair pass adds API/runtime integration checks, not a live Claude Code conversation or a new full-browser end-to-end run. Proxy's full-project type check still reports errors; the focused Core evidence compile passes.
