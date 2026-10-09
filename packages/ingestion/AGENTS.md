# @happyvertical/smrt-ingestion

Durable foundation for ADR 0004. `src/models.ts` owns all ingestion tables;
`src/server.ts` owns authenticated service boundaries and lifecycle primitives.
`src/execution.ts` owns authoritative review/apply and imports server-only principals.
See [execution integration](agents/execution.md) for host transaction guarantees,
catalog contracts, deployment dependencies and continuation bindings.
Root, `/models`, and `/dto` remain browser-safe; provider/network/filesystem code
belongs under `/server`. Generated REST/CLI/MCP model mutation is disabled.

See [README.md](README.md) for host integration and recovery/deletion operation.
See [EXTRACTION.md](EXTRACTION.md) for extraction contracts, provider isolation
requirements and corpus validation.
See [PROPOSALS.md](PROPOSALS.md) for the optional server-only proposal stage,
current catalog/candidate authority and immutable source pinning.

All records require tenant and confidential scope. Hosts create service scopes
from authenticated sessions; source metadata is never authority. Every read and
write rechecks the host scope predicate. Analysis input revisions, attempts,
proposals, decisions, executions and feedback are append-only except documented
state projections and retention redaction. Terminal actions outlive job cleanup.

Only SQLite and PostgreSQL are supported. Deploy manifest migrations before
starting services; runtime performs no application DDL. Storage planning and
preservation use AssetRuntime/AssetStore public methods. Blob I/O and queue
submission never run inside ingestion database transactions.

Validation: `pnpm test`, `pnpm test:postgres`, `pnpm test:providers`, `pnpm typecheck`, `pnpm build`.
The PostgreSQL command provisions a real database and fails if unavailable.
Build includes browser import validation. The provider lane exercises local SDK
adapters and process isolation, without claiming live remote recognition quality.
The component/e2e/evaluation
commands are reserved by ADR 0004 and fail explicitly until their owning children
supply real suites.
See ../../docs/test-matrix/3670-ingestion-foundation.md for behavior coverage.
