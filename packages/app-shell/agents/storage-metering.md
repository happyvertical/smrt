# Storage metering (#5199, storage half; epic #5183)

Per-tenant storage for the hosted shell, recorded as a tenant usage metric.
Cloud profile only: the desktop never measures, records or imports anything of
this. Code: `src/lib/server/storage-metering.ts` (+ `-handle.ts`, the request
hook in `hooks.server.ts`).

## What is recorded

`TenantUsageMetric` rows, `metricKey: 'storage.bytes'`, `source:
'app-shell.storage'`, `sourceId` = the bucket start (ms), window = the bucket,
`quantity` = bytes of the tenant's LIVE app data, `dimensions`:
`{ backend, scope: 'live-app', sampledAt, assets: 'not-measured' }`.

- PostgreSQL (cloud with `DATABASE_URL`, an app with no `app.db`): the app's
  schema (`appSchemaName(tenant, app)`, bound as a parameter) on the shell
  database, `SUM(pg_total_relation_size)` over `relkind IN ('r','m')` only
  (the total already holds indexes and TOAST; counting those again double
  counts). `PG_SCHEMA_BYTES_SQL`.
- SQLite (tests, deployments with no app server): `stat` of `app.db` +
  `app.db-wal` under `tenantAppDirs(...).live`. The file is never opened.
- Not counted: draft copies and side schemas, snapshots, the shell's own rows
  (versions, assistant messages), assets (the shell has no asset store; an
  app's asset records live in its schema and are already counted).

## "One row per bucket", not a true upsert

Usage rows are immutable evidence (`TenantUsageMetric.validateBeforeSave`
refuses a changed row; a `source`+`sourceId` write that exists returns the old
row), and `summarizeUsage` SUMS quantities: right for counters, wrong for a
size. So a sample is an insert-only gauge row, at most one per tenant per
bucket (bucket = the minimum sample interval, default 1 hour); a second sample
in the bucket writes nothing. **Never read `storage.bytes` through
`TenantUsageMeter.summarize` and never put a plan threshold on it**: the sum
over a month of samples is meaningless. Use `readTenantUsage`.

## When it samples (cheap)

Nothing on the request path but a map write. `storageMeteringHandle` (cloud
only, after the response, not awaited) notes the session's tenant
(`getCurrentTenant()`, never input); a tenant not sampled within the interval
is sampled then. An unref'd timer (`sweep`, every 15 min) samples the tenants
seen that are due, re-entering each tenant's context (`withTenant`). Failed
attempts count for the throttle (no retry storm). Sampling never opens or
wakes an app and never touches `lastUsed`: it reads the tenant's `App` row and
the size only. It skips quietly while `_smrt_tenant_usage_metrics` is not
migrated (cloud schema comes only from `smrt db:migrate`) and swallows its own
errors: metering never fails a request. `resetStorageMeter()` stops the timer.

## The one read

`readTenantUsage(window)` (`monthWindow()` for the calendar month) returns, for
the SESSION's tenant (no tenant parameter; it refuses with no context):
`storage { bytes (latest sample), peakBytes, sampledAt (measured), bucketStart, samples, backend }` and
`requests { count, metered }`, `worker { wakes, awakeMs }`.

## Seam for #5195 (request counts and caller kind)

NOT done here: counting requests, and the caller kind (owner, staff, guest,
job, service), need hooks in core's generated API paths (#5195). The reader
already sums `REQUEST_COUNT_METRIC` (`'api.requests'`) rows and reports
`metered: false` until some exist, so the writer only has to record that key
(a counter: summing is right) with the kind in `dimensions`.

## Wake and idle-close samples (host.ts)

`host.ts` calls the meter at two points of the live app's life, on the HOST's
tenant (`holder.tenantId`, never input), cloud only (the desktop holder has no
tenant and never loads the writer; the writer re-checks the profile):

- end of `openLive` (every wake, first open included): `onWake(tenant, wakeMs)`
  writes one `app.wakes` counter row (`quantity` 1, `dimensions.wakeMs`).
- `evict` after the host is closed (idle or capacity): `onClose(tenant,
  awakeMs, why)` writes one `app.awake_ms` counter row (open to close, window =
  that span, `dimensions.why`).

Both rows are `source: 'app-shell.worker'` with a random `sourceId` (counters:
summing is right; `readTenantUsage().worker` = `{ wakes, awakeMs }`, closed
spans only) and each then takes a storage sample through `sample()` (still one
gauge row per bucket, so a wake right after a close adds none). The calls are
`void`ed behind a lazy import (no import cycle) and swallow every error: a
wake or close never waits on, or fails from, metering. A lost-claim drop and
`closeOwnApp` are not samples. Request counts and caller kind remain #5195's.

## Tests

`storage-metering.test.ts` (SQLite shell db, fake probe); `storage-metering-lifecycle.test.ts` (wake, idle close, desktop inert, failing writer; real workers). The catalog query is
in `storage-metering-postgres.test.ts` (registered `test:postgres` suite:
PGlite, and a real server with `SMRT_TEST_POSTGRES_URL`).
