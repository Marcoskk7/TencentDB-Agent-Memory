> ⚠️ **此文档已过时。请以项目中确认有效的最新 spec 为准进行开发。**

# Asset evidence MVP implementation

The MVP is split into four layers:

- `MemoryCore/src/evidence` contains the immutable event model, task-run service,
  deterministic state derivation, receipts, and candidate generation.
- `MemoryCore/src/gateway` and the TypeScript SDK expose `/v3/evidence` for task
  runs, accesses, claims, behaviors, diffs, validations, reviews, receipts and
  close/correction operations.
- `MemoryProxy/src/session/claude-code` contains request classification, SSE
  tool evidence buffering, two-stage asset context metadata, and the structured
  `<asset_usage>` parser.
- `MemoryCore/scripts/db/evidence-init.sql` documents the durable normalized
  schema and idempotency/foreign-key constraints for a production store.

`used` is only derived from a supporting human review with evidence references;
`validation_passed` requires an explicitly related passing validation; and
`contributed` requires a clean with-assets/without-assets evaluation with
independent causal evidence. Candidate assets remain `candidate` until reviewed.

Standalone gateway routes use SQLite with scoped durable idempotency and atomic
ingestion. Direct `EvidenceService` construction still defaults to an in-process
store for unit tests. Service deployments explicitly return 503 until a shared
durable adapter exists. See [the verification guide](asset-evidence-verification.md)
for the repaired fixed-Skill Proxy path, local workspace capture, and remaining
deployment/adapter limits.
