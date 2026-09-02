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

The default service is persistence-neutral and ships with an in-process store
for local/demo use. Deployments should provide a store implementation backed by
the migration schema before relying on multi-process durability.
