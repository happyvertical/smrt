# OpenObserve stream reader (#4908)

`@happyvertical/smrt-analytics/observability` is a **server-only**, read-only
client for the OpenObserve stream `default/project_observability`. It is a
dedicated subpath: never re-exported from the package root or `./browser`, no
model registration, and it throws `OpenObserveReadError` if run in a browser.

```ts
import {
  OpenObserveStreamReader,
  credentialFromSecret,
} from '@happyvertical/smrt-analytics/observability';

const reader = new OpenObserveStreamReader({
  endpoint: () => config.openobserve.url, // resolved per call
  credential: credentialFromSecret(secretService, 'openobserve.read'),
});
const projects = await reader.latestPerProject(); // snapshot per project, last 24h
const rows = await reader.queryWindow({ start, end, projectIds: ['site-a'] });
```

## Stream shape (source of truth: iac `project-observability/runtime.py`)

The collector writes **long-format** rows every 10 minutes: one row per
(project, source, entity) per poll. Common columns: `project`, `source`,
`entity`, `record_kind` (`snapshot`), `status` (`connected`, `not_connected`,
`error`), `_timestamp`, `observed_at`, `last_success_at` (microseconds).
Source-specific columns:

- `matomo`: `period`, `visitors`, `visits`, `actions`
- `glitchtip`: `period`, `window_start`, `window_end`, `error_events`,
  `error_events_current_hour`
- `bifrost`: `context`, `period`, `requests`, `input_tokens`, `output_tokens`,
  `total_tokens`, `estimated_cost_usd`, `budget_usd`, `budget_used_usd`,
  `budget_reset`, `cost_kind`
- `workloads`: deployment rows (`namespace`, `desired/ready/updated_replicas`,
  `images`) and pod rows (`cpu_cores`, `memory_bytes`, `measured_at`)
- `deployments`: `ready`, `revision`, `transition_at`
- `ci`: `workflow`, `run_status`, `conclusion`, `revision`, `run_updated_at`

A source with no data or a failed poll is one row with entity `connection` and
status `not_connected` or `error`. `codex`/`claude` configuration rows and
non-`snapshot` rows are ignored.

## Reader behavior

- `parseProjectObservabilityRecord()` yields a typed record per source
  (`ProjectObservabilityRecord`, discriminated by `source`). Fields a row does
  not carry are `null`, never `0`.
- `latestPerProject()` picks the newest row per (project, source, entity) in SQL
  (window function), then `foldProjectSnapshots()` keeps only entities from each
  source's latest poll and builds a `ProjectObservabilitySnapshot`: per-source
  `sources` state, latest `records`, and a `summary` (visitors, error events,
  AI tokens and USD estimate from `rolling_24h` rows, replicas, Flux ready
  counts, latest CI per repository).
- Not provided by the collector, so not modeled: a detail-dashboard URL (the
  dashboards use id `project-<project id>`; build the link in the app) and
  integer-minor-unit AI cost (the collector reports a USD gateway estimate).
- `queryWindow()` returns raw records newest first. Both methods throw when the result exceeds
  result exceeds `maxRows` (default 5000) instead of silently truncating.
- Invalid `start`/`end` dates are rejected. Project ids must match the
  collector's `[a-z][a-z0-9-]{0,62}`; org and stream names are validated.

## Credential and tests

The credential is a read-only OpenObserve credential from the secrets store
(`SecretService.retrieve` via structural `ObservabilitySecretSource`; no
`smrt-secrets` dependency, DAG #1582). It is resolved on every call, sent only
in the `Authorization` header (`Basic` by default, or `Bearer`), and scrubbed
from errors. `PROJECT_OBSERVABILITY_FIXTURE_HITS` / `_RECORDS` are fake
long-format fixtures; tests inject `fetch` with placeholder tokens, no
containers.
