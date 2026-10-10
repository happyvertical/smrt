# #3732 versioned routing projection

High risk: shared authorization/provenance and a public cross-system contract.
No schema/dependency changes. Coordinator owns combined release validation,
exact-head review and delivery; this worker runs ingestion domain evidence only.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External contract edge | Level / validation command |
|---|---|---|---|---|---|---|---|---|
| Explicit routing subset | Host config before feedback capture | Independent documents with unique request IDs/content share selected routing values | No implicit field removal; default full args differ and fail; changed route fails | Current authenticated reviewer, tenant and confidential scope | Existing ingestion transaction | Node SQLite/PostgreSQL | Versioned server allowlist; malformed/missing/unknown fields reject | Shared proposal service suite; U/P below |
| Immutable contract and full binding | Suggest/read/adopt/replay | Projection version+fields+values retained in ledger and rule | Changed version/fields, old unprojected capture, tampered full args or digest reject | Same actor/source ownership and active scope | Same executor; full source binding rechecked | SQLite/PostgreSQL | Additive DTO; callers cannot choose selectors | U/P |
| Authority, retention and CAS | Adoption or replay after owner callback | Exactly one CAS and audit; inert routing preferences | Denial, source revocation/deletion, policy change and callback contract change roll back | Reviewer plus current source grants; tenant/scope deny | Policy and ingestion audit share executor and rollback | SQLite/PostgreSQL | No provider/permission/automation widening | U/P plus existing feedback regressions |

U: `pnpm exec vitest run src/proposals.test.ts -t feedback` from packages/ingestion.
P: `node ../../scripts/run-with-ci-postgres.mjs -- pnpm exec vitest run --config
vitest.postgres.config.ts src/proposals.postgres.test.ts -t feedback`, using the
documented provisioning runner with focused Vitest arguments.
Type/build: `pnpm typecheck`, `pnpm build` in packages/ingestion.
Browser N/A: no UI behavior changed. Provider I/O N/A: no provider contract changed.
Regression: the independent-document positive case fails against base
`a9e2fa09d` feedback.ts with `Rule evidence unavailable` at the original full-args
comparison. An isolated temporary Vitest import alias selected that unchanged
implementation; tracked source was never replaced. The same case passes on the
new implementation. Temporary baseline files were removed after the run.

## Worker evidence (2026-10-09)

All 66 feedback cases pass on SQLite and real PostgreSQL, including the 20 new
projection cases (also run independently on SQLite). Owning package typecheck
(source, tests and Svelte), build/browser-import validation and changed-file Biome
checks pass. Base regression fails as expected. Full logs are retained in
`/home/will/Work/tmp/smrt-3732-routing/`; the coordinator owns combined release
validation, exact-head review, publication and the consuming native proof.
