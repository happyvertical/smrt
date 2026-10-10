# @happyvertical/smrt-approvals

Decision gate plus ledger (slice 1 of #3716): `ApprovalRequest`,
append-only `ApprovalEvent`, tighten-only `ApprovalPolicy`, and
`ApprovalService`, the only write path. Not a workflow engine: no stages, no
executor, no compensation. Read [agents/approvals.md](agents/approvals.md)
before changing a transition, the guard predicates, or the surface.

## Invariants

- Every transition is ONE guarded `UPDATE ... WHERE id AND tenant_id AND
  status AND version AND expires_at ... RETURNING version` plus one event
  insert, in one transaction. Zero rows means a concurrent writer won: retry
  from a fresh read, never write anyway. Keep the predicate the arbiter; the
  in-transaction reads only classify refusals.
- Only `human` principals decide; never the requester; one decision per actor
  (unique `(request_id, vote_key)`); quorum counts distinct approver events.
  Agents and services may request, consume, and expire.
- Tenant: every statement names `tenant_id`, the work runs in
  `withTenant(principal.tenantId)`, and a conflicting active context is
  refused. Principal tenant ids must be UUIDs.
- Policy may only tighten (`assertPolicyTightens` on write, `effectiveRules`
  clamps on read). Quorum and expiry are fixed at request time; decide-time
  permissions are the request snapshot plus the current kind and policy slugs.
- Generated surface is `list`/`get` on REST and MCP, no CLI. A collection's
  `@smrt()` config is applied to its item class by core, so each collection
  repeats its model's surface exactly; changing one without the other opens
  or closes the model. `surface.test.ts` holds this.
- Models refuse re-save and delete of requests and events. Never add an
  update path for events.
- The event FK is physical on PostgreSQL and SQLite only: DuckDB runs an
  indexed-column UPDATE on a referenced row as delete plus insert.
- No Node built-ins in `src/` (browser gate); use `globalThis.crypto`.

## Validation

```bash
pnpm --filter @happyvertical/smrt-approvals test
pnpm --filter @happyvertical/smrt-approvals typecheck
pnpm --filter @happyvertical/smrt-approvals test:postgres
```

The behaviour suite (`src/__tests__/helpers/approval-suite.ts`) runs on
SQLite, DuckDB, and, through `test:postgres`, a migrated PostgreSQL database.
