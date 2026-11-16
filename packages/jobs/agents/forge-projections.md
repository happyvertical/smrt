# Durable forge projections

`ForgeDeliveryCollection` owns the provider-neutral delivery inbox in
`_smrt_forge_deliveries`; `ForgeProjectionRuntime` owns lease/retry/dead-letter
transitions and monotonic checkpoints in
`_smrt_forge_projection_checkpoints`.

- Inbox identity is `(tenant_id, provider, delivery_id)`.
- Runtimes sharing the inbox pass `providers` (to `ForgeProjectionRuntime` or
  `claimReady`) so each claims and dead-letters only its own deliveries;
  unfiltered claims take every provider (smrt-commerce billing uses
  `<name>-billing:<sellerTenantId>`, #3060).
- `claimReady` leases exactly one delivery; PostgreSQL uses the same
  `MATERIALIZED` CTE claim as jobs (#3105).
- Tenant-facing accept/replay requires ambient tenant context. Worker claim is
  cross-tenant, then runtime restores the captured context before observation.
  Reads in the accept path go through the tenant-scoped collection (`list()`),
  so intake works under the interceptor's `rawQueryPolicy: 'throw'` production
  default without a bypass (#3100); keep new tenant-facing reads that way.
- Projection callbacks must write through `ForgeProjectionContext.db`; the
  application projection, checkpoint, and inbox completion share one
  transaction.
- Observation identity is tracker-independent
  `(projection, subjectKey, version)`. Equal or older versions are acknowledged
  without reapplying.
- Lease-token conditions guard every terminal/failure write. Expired final
  attempts become replayable `dead_letter` rows, and persisted errors are
  redacted.
- Generated API, CLI, and MCP surfaces stay disabled; replay is an explicit
  tenant-scoped operator action.
