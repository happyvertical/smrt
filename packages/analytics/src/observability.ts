/**
 * Read-only OpenObserve reader for the `default/project_observability` stream
 * (happyvertical/smrt#4908).
 *
 * SERVER-ONLY. This entry point (`@happyvertical/smrt-analytics/observability`)
 * is deliberately not re-exported from the package root or `./browser`, and it
 * refuses to run in a browser. The credential is resolved at call time and sent
 * only in the `Authorization` header of the search request; it is never stored,
 * logged, or placed in an error message.
 *
 * Stream shape. The iac collector (`project-observability/runtime.py`,
 * `collect()`) writes LONG-FORMAT rows every 10 minutes: one row per
 * (project, source, entity) per poll. Every row carries `project`, `source`
 * (`matomo`, `glitchtip`, `bifrost`, `workloads`, `deployments`, `ci`, plus the
 * opt-in `codex`/`claude` configuration rows, which this reader ignores),
 * `entity`, `record_kind` (`snapshot`), `status` (`connected`, `not_connected`,
 * `error`), `_timestamp`, `observed_at` and `last_success_at` (microseconds),
 * plus source-specific fields:
 *
 * | source      | fields                                                               |
 * | ----------- | -------------------------------------------------------------------- |
 * | matomo      | period, visitors, visits, actions                                    |
 * | glitchtip   | period, window_start, window_end, error_events, error_events_current_hour |
 * | bifrost     | context, period, requests, input_tokens, output_tokens, total_tokens, estimated_cost_usd (gateway estimate, USD), budget_usd, budget_used_usd, budget_reset, cost_kind |
 * | workloads   | namespace, desired/ready/updated_replicas, images (deployment rows); cpu_cores, memory_bytes, measured_at (pod rows) |
 * | deployments | ready, revision, transition_at                                       |
 * | ci          | workflow, run_status, conclusion, revision, run_updated_at           |
 *
 * A source with no data or a failed poll is a single row with entity
 * `connection` and status `not_connected` or `error`. Fields the collector does
 * not write (a dashboard URL, integer-minor-unit cost) are not invented: AI cost
 * is the collector's USD estimate, and metrics absent from a row are `null`.
 *
 * @packageDocumentation
 */

export const PROJECT_OBSERVABILITY_SOURCES = [
  'matomo',
  'glitchtip',
  'bifrost',
  'workloads',
  'deployments',
  'ci',
] as const;

export type ProjectObservabilitySource =
  (typeof PROJECT_OBSERVABILITY_SOURCES)[number];

/** Collector connection state of a row. */
export type ProjectObservabilityStatus =
  | 'connected'
  | 'not_connected'
  | 'error'
  | (string & {});

interface RecordBase {
  project: string;
  entity: string;
  status: ProjectObservabilityStatus;
  /** Poll time (`observed_at`), microseconds since epoch. */
  observedAtMicros: number;
  /** Poll time, ISO 8601 UTC. */
  observedAt: string;
  lastSuccessAtMicros: number | null;
}

export interface MatomoRecord extends RecordBase {
  source: 'matomo';
  period: string | null;
  visitors: number | null;
  visits: number | null;
  actions: number | null;
}

export interface GlitchtipRecord extends RecordBase {
  source: 'glitchtip';
  period: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  errorEvents: number | null;
  errorEventsCurrentHour: number | null;
}

export interface BifrostRecord extends RecordBase {
  source: 'bifrost';
  context: string | null;
  period: string | null;
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Gateway estimate in USD (decimal), never an invoice. */
  estimatedCostUsd: number | null;
  budgetUsd: number | null;
  budgetUsedUsd: number | null;
  budgetReset: string | null;
  costKind: string | null;
}

export interface WorkloadsRecord extends RecordBase {
  source: 'workloads';
  namespace: string | null;
  desiredReplicas: number | null;
  readyReplicas: number | null;
  updatedReplicas: number | null;
  images: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  measuredAt: string | null;
}

export interface DeploymentsRecord extends RecordBase {
  source: 'deployments';
  /** Flux Ready condition status: `True`, `False`, `Unknown`. */
  ready: string | null;
  revision: string | null;
  transitionAt: string | null;
}

export interface CiRecord extends RecordBase {
  source: 'ci';
  workflow: string | null;
  runStatus: string | null;
  /** GitHub conclusion, or `pending`. */
  conclusion: string | null;
  revision: string | null;
  runUpdatedAt: string | null;
}

/** One typed collector row, discriminated by `source`. */
export type ProjectObservabilityRecord =
  | MatomoRecord
  | GlitchtipRecord
  | BifrostRecord
  | WorkloadsRecord
  | DeploymentsRecord
  | CiRecord;

export interface ProjectSourceState {
  status: ProjectObservabilityStatus;
  observedAtMicros: number;
  lastSuccessAtMicros: number | null;
}

/** Per-project totals over the latest poll. `null` means no data, never 0. */
export interface ProjectObservabilitySummary {
  /** Matomo unique visitors today, summed over sites. */
  visitors: number | null;
  /** GlitchTip error events, last 24 complete UTC hours. */
  errorEvents: number | null;
  /** Bifrost rolling-24h total tokens over the project's keys. */
  aiTotalTokens: number | null;
  /** Bifrost rolling-24h estimated cost in USD. */
  aiEstimatedCostUsd: number | null;
  /** Sum of desired / ready replicas over deployment rows. */
  workloadsDesired: number | null;
  workloadsReady: number | null;
  /** Flux kustomizations Ready=True / total. */
  deploymentsReady: number | null;
  deploymentsTotal: number | null;
  /** Latest CI conclusion per repository (entity = `owner/repo`). */
  latestCi: { repository: string; conclusion: string | null }[];
}

/** Latest records for one project folded into a snapshot. */
export interface ProjectObservabilitySnapshot {
  projectId: string;
  /** Newest poll across sources. */
  observedAtMicros: number;
  observedAt: string;
  sources: Partial<Record<ProjectObservabilitySource, ProjectSourceState>>;
  /** Latest data rows per source (connection rows excluded). */
  records: {
    [S in ProjectObservabilitySource]: Extract<
      ProjectObservabilityRecord,
      { source: S }
    >[];
  };
  summary: ProjectObservabilitySummary;
}

/** Credential scheme for the `Authorization` header. */
export type ObservabilityAuthScheme = 'Basic' | 'Bearer';

type MaybeAsync<T> = T | Promise<T>;

/** Structural subset of `SecretService` so callers can pass one directly. */
export interface ObservabilitySecretSource {
  retrieve(name: string): Promise<{ value: string }>;
}

export interface OpenObserveStreamReaderOptions {
  /** Base URL, e.g. `https://openobserve.example.com`. Resolved per call. */
  endpoint: string | (() => MaybeAsync<string>);
  /**
   * Returns the read-only credential (the pre-encoded Basic token, or a bearer
   * token). Resolved per call; see {@link credentialFromSecret}.
   */
  credential: () => MaybeAsync<string>;
  authScheme?: ObservabilityAuthScheme;
  /** OpenObserve organization. Default `default`. */
  org?: string;
  /** Stream name. Default `project_observability`. */
  stream?: string;
  /** Injected fetch (tests). Default global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
  /**
   * Max rows per query. Exceeding it throws rather than silently truncating.
   * Default 5000.
   */
  maxRows?: number;
  /** Clock override for window defaults (tests). */
  now?: () => Date;
}

export interface ProjectObservabilityQuery {
  /** Window start (inclusive). Default: `end` minus 24h. */
  start?: Date;
  /** Window end. Default: now. */
  end?: Date;
  /** Restrict to these project ids. */
  projectIds?: readonly string[];
}

/** Error raised by the reader. The message never contains the credential. */
export class OpenObserveReadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenObserveReadError';
    this.status = status;
  }
}

/** Build a `credential` resolver from a secrets store entry (e.g. `SecretService`). */
export function credentialFromSecret(
  source: ObservabilitySecretSource,
  secretName: string,
): () => Promise<string> {
  return async () => (await source.retrieve(secretName)).value;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const CONNECTION = 'connection';

function toNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isSource(value: unknown): value is ProjectObservabilitySource {
  return (PROJECT_OBSERVABILITY_SOURCES as readonly unknown[]).includes(value);
}

/**
 * Normalize one raw stream hit into a typed record. Returns null for rows that
 * are not collector snapshots of a known source (e.g. `codex`/`claude`
 * configuration rows) or lack a project, entity, or timestamp.
 */
export function parseProjectObservabilityRecord(
  raw: unknown,
): ProjectObservabilityRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const project = toText(r.project);
  const entity = toText(r.entity);
  const observed = toNum(r.observed_at) ?? toNum(r._timestamp);
  if (!project || !entity || observed === null || !isSource(r.source)) {
    return null;
  }
  if (r.record_kind !== undefined && r.record_kind !== 'snapshot') return null;
  const base = {
    project,
    entity,
    status: toText(r.status) ?? 'unknown',
    observedAtMicros: observed,
    observedAt: new Date(Math.floor(observed / 1000)).toISOString(),
    lastSuccessAtMicros: toNum(r.last_success_at),
  };
  switch (r.source) {
    case 'matomo':
      return {
        ...base,
        source: 'matomo',
        period: toText(r.period),
        visitors: toNum(r.visitors),
        visits: toNum(r.visits),
        actions: toNum(r.actions),
      };
    case 'glitchtip':
      return {
        ...base,
        source: 'glitchtip',
        period: toText(r.period),
        windowStart: toText(r.window_start),
        windowEnd: toText(r.window_end),
        errorEvents: toNum(r.error_events),
        errorEventsCurrentHour: toNum(r.error_events_current_hour),
      };
    case 'bifrost':
      return {
        ...base,
        source: 'bifrost',
        context: toText(r.context),
        period: toText(r.period),
        requests: toNum(r.requests),
        inputTokens: toNum(r.input_tokens),
        outputTokens: toNum(r.output_tokens),
        totalTokens: toNum(r.total_tokens),
        estimatedCostUsd: toNum(r.estimated_cost_usd),
        budgetUsd: toNum(r.budget_usd),
        budgetUsedUsd: toNum(r.budget_used_usd),
        budgetReset: toText(r.budget_reset),
        costKind: toText(r.cost_kind),
      };
    case 'workloads':
      return {
        ...base,
        source: 'workloads',
        namespace: toText(r.namespace),
        desiredReplicas: toNum(r.desired_replicas),
        readyReplicas: toNum(r.ready_replicas),
        updatedReplicas: toNum(r.updated_replicas),
        images: toText(r.images),
        cpuCores: toNum(r.cpu_cores),
        memoryBytes: toNum(r.memory_bytes),
        measuredAt: toText(r.measured_at),
      };
    case 'deployments':
      return {
        ...base,
        source: 'deployments',
        ready: toText(r.ready),
        revision: toText(r.revision),
        transitionAt: toText(r.transition_at),
      };
    case 'ci':
      return {
        ...base,
        source: 'ci',
        workflow: toText(r.workflow),
        runStatus: toText(r.run_status),
        conclusion: toText(r.conclusion),
        revision: toText(r.revision),
        runUpdatedAt: toText(r.run_updated_at),
      };
  }
}

function sumOf(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/**
 * Fold records into per-project snapshots. Groups by (project, source, entity)
 * keeping the newest row, then keeps only entities seen in each source's latest
 * poll so entities the collector stopped reporting do not linger.
 */
export function foldProjectSnapshots(
  records: readonly ProjectObservabilityRecord[],
): ProjectObservabilitySnapshot[] {
  const latest = new Map<string, ProjectObservabilityRecord>();
  for (const rec of records) {
    const key = JSON.stringify([rec.project, rec.source, rec.entity]);
    const cur = latest.get(key);
    if (!cur || rec.observedAtMicros > cur.observedAtMicros)
      latest.set(key, rec);
  }
  const poll = new Map<string, number>();
  for (const rec of latest.values()) {
    const key = `${rec.project}\u0000${rec.source}`;
    poll.set(key, Math.max(poll.get(key) ?? 0, rec.observedAtMicros));
  }
  const byProject = new Map<string, ProjectObservabilityRecord[]>();
  for (const rec of latest.values()) {
    if (
      rec.observedAtMicros !== poll.get(`${rec.project}\u0000${rec.source}`)
    ) {
      continue;
    }
    const list = byProject.get(rec.project) ?? [];
    list.push(rec);
    byProject.set(rec.project, list);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectId, recs]) => buildSnapshot(projectId, recs));
}

function buildSnapshot(
  projectId: string,
  recs: ProjectObservabilityRecord[],
): ProjectObservabilitySnapshot {
  const records = {
    matomo: [],
    glitchtip: [],
    bifrost: [],
    workloads: [],
    deployments: [],
    ci: [],
  } as ProjectObservabilitySnapshot['records'];
  const sources: ProjectObservabilitySnapshot['sources'] = {};
  let newest = 0;
  for (const rec of recs.sort((a, b) => a.entity.localeCompare(b.entity))) {
    newest = Math.max(newest, rec.observedAtMicros);
    if (rec.entity === CONNECTION || !sources[rec.source]) {
      sources[rec.source] = {
        status: rec.status,
        observedAtMicros: rec.observedAtMicros,
        lastSuccessAtMicros: rec.lastSuccessAtMicros,
      };
    }
    if (rec.entity !== CONNECTION) {
      (records[rec.source] as ProjectObservabilityRecord[]).push(rec);
    }
  }
  const deploys = records.workloads.filter((w) => w.desiredReplicas !== null);
  const aiRolling = records.bifrost.filter(
    (b) => b.period === 'rolling_24h' && b.totalTokens !== null,
  );
  return {
    projectId,
    observedAtMicros: newest,
    observedAt: new Date(Math.floor(newest / 1000)).toISOString(),
    sources,
    records,
    summary: {
      visitors: sumOf(records.matomo.map((m) => m.visitors)),
      errorEvents: sumOf(records.glitchtip.map((g) => g.errorEvents)),
      aiTotalTokens: sumOf(aiRolling.map((b) => b.totalTokens)),
      aiEstimatedCostUsd: sumOf(aiRolling.map((b) => b.estimatedCostUsd)),
      workloadsDesired: sumOf(deploys.map((w) => w.desiredReplicas)),
      workloadsReady: sumOf(deploys.map((w) => w.readyReplicas)),
      deploymentsReady:
        records.deployments.length === 0
          ? null
          : records.deployments.filter((d) => d.ready === 'True').length,
      deploymentsTotal:
        records.deployments.length === 0 ? null : records.deployments.length,
      latestCi: records.ci.map((c) => ({
        repository: c.entity,
        conclusion: c.conclusion,
      })),
    },
  };
}

function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
}

/** Read-only client for the per-project observability stream. */
export class OpenObserveStreamReader {
  private readonly options: OpenObserveStreamReaderOptions;
  private readonly org: string;
  private readonly stream: string;

  constructor(options: OpenObserveStreamReaderOptions) {
    const org = options.org ?? 'default';
    const stream = options.stream ?? 'project_observability';
    if (!NAME_PATTERN.test(org) || !NAME_PATTERN.test(stream)) {
      throw new OpenObserveReadError('Invalid org or stream name');
    }
    this.options = options;
    this.org = org;
    this.stream = stream;
  }

  /** Every collector snapshot row in the window, newest poll first. */
  async queryWindow(
    query: ProjectObservabilityQuery = {},
  ): Promise<ProjectObservabilityRecord[]> {
    const where = this.where(query.projectIds);
    const sql = `SELECT * FROM "${this.stream}"${where} ORDER BY observed_at DESC`;
    return this.search(query, sql);
  }

  /**
   * Latest snapshot per project in the window (default last 24h). The newest row
   * per (project, source, entity) is chosen server-side, so the row cap bounds
   * distinct entities, not poll history.
   */
  async latestPerProject(
    query: ProjectObservabilityQuery = {},
  ): Promise<ProjectObservabilitySnapshot[]> {
    const where = this.where(query.projectIds);
    const sql =
      `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY project, source, entity ORDER BY observed_at DESC) AS rn ` +
      `FROM "${this.stream}"${where}) WHERE rn = 1 ORDER BY project, source, entity`;
    return foldProjectSnapshots(await this.search(query, sql));
  }

  private where(projectIds?: readonly string[]): string {
    const clauses = [`record_kind = 'snapshot'`];
    if (projectIds && projectIds.length > 0) {
      for (const id of projectIds) {
        if (!PROJECT_ID_PATTERN.test(id)) {
          throw new OpenObserveReadError('Invalid project id in query');
        }
      }
      clauses.push(
        `project IN (${projectIds.map((id) => `'${id}'`).join(', ')})`,
      );
    }
    return ` WHERE ${clauses.join(' AND ')}`;
  }

  private async search(
    query: ProjectObservabilityQuery,
    sql: string,
  ): Promise<ProjectObservabilityRecord[]> {
    if (isBrowser()) {
      throw new OpenObserveReadError(
        'OpenObserveStreamReader is server-only and cannot run in a browser',
      );
    }
    const now = (this.options.now ?? (() => new Date()))();
    const end = query.end ?? now;
    const start = query.start ?? new Date(end.getTime() - DAY_MS);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new OpenObserveReadError('Query window contains an invalid date');
    }
    if (start.getTime() >= end.getTime()) {
      throw new OpenObserveReadError('Query window start must precede end');
    }

    const endpoint =
      typeof this.options.endpoint === 'function'
        ? await this.options.endpoint()
        : this.options.endpoint;
    const credential = await this.options.credential();
    if (!endpoint || !credential) {
      throw new OpenObserveReadError(
        'OpenObserve endpoint and credential must be configured',
      );
    }
    const maxRows = this.options.maxRows ?? 5000;
    const url = `${endpoint.replace(/\/+$/, '')}/api/${this.org}/_search`;
    const body = JSON.stringify({
      query: {
        sql,
        start_time: start.getTime() * 1000,
        end_time: end.getTime() * 1000,
        from: 0,
        size: maxRows + 1,
      },
    });

    const doFetch = this.options.fetch ?? fetch;
    const redact = (text: string): string =>
      text.split(credential).join('[redacted]').slice(0, 200);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `${this.options.authScheme ?? 'Basic'} ${credential}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'error';
      throw new OpenObserveReadError(
        redact(`OpenObserve request failed (${reason})`),
      );
    }
    if (!response.ok) {
      throw new OpenObserveReadError(
        redact(`OpenObserve search failed with HTTP ${response.status}`),
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OpenObserveReadError('OpenObserve returned a non-JSON body');
    }
    const hits = (payload as { hits?: unknown } | null)?.hits;
    if (!Array.isArray(hits)) {
      throw new OpenObserveReadError('OpenObserve response has no hits array');
    }
    if (hits.length > maxRows) {
      throw new OpenObserveReadError(
        `OpenObserve result exceeded the ${maxRows}-row cap; narrow the window or raise maxRows`,
      );
    }
    return hits
      .map(parseProjectObservabilityRecord)
      .filter((rec): rec is ProjectObservabilityRecord => rec !== null);
  }
}

const T1 = 1_760_000_000_000_000;
const T2 = T1 + 600_000_000;
function polled(project: string, observed: number) {
  return {
    project,
    _timestamp: observed,
    observed_at: observed,
    last_success_at: observed,
    record_kind: 'snapshot',
    status: 'connected',
  };
}

/**
 * Fixture raw stream hits in the collector's long format (obviously fake data).
 * Project `example-site` has two polls (the older with different values) and a
 * failed GlitchTip source; `example-internal` has only workloads and an
 * unconnected Matomo. Includes an opt-in `codex` configuration row that the
 * reader must ignore.
 */
export const PROJECT_OBSERVABILITY_FIXTURE_HITS: readonly Record<
  string,
  unknown
>[] = [
  // Older poll of example-site.
  {
    ...polled('example-site', T1),
    source: 'matomo',
    entity: '7',
    period: 'today_site_timezone',
    visitors: 100,
    visits: 120,
    actions: 300,
  },
  {
    ...polled('example-site', T1),
    source: 'ci',
    entity: 'example-org/example-site',
    workflow: 'CI',
    run_status: 'completed',
    conclusion: 'failure',
    revision: '0000000000000000000000000000000000000001',
    run_updated_at: '2025-10-09T08:00:00Z',
  },
  // Latest poll of example-site.
  {
    ...polled('example-site', T2),
    source: 'matomo',
    entity: '7',
    period: 'today_site_timezone',
    visitors: 120,
    visits: 150,
    actions: 340,
  },
  {
    ...polled('example-site', T2),
    source: 'bifrost',
    entity: 'vk-example',
    context: 'app',
    period: 'rolling_24h',
    requests: 12,
    input_tokens: 30000,
    output_tokens: 15000,
    total_tokens: 45000,
    estimated_cost_usd: 2.75,
    cost_kind: 'gateway_estimate',
  },
  {
    ...polled('example-site', T2),
    source: 'bifrost',
    entity: 'vk-example:budget-1',
    context: 'app',
    period: '1M',
    budget_usd: 50,
    budget_used_usd: 12.5,
    budget_reset: '2025-10-01T00:00:00Z',
    cost_kind: 'governance_estimate',
  },
  {
    ...polled('example-site', T2),
    source: 'workloads',
    entity: 'example-ns/web',
    namespace: 'example-ns',
    desired_replicas: 2,
    ready_replicas: 2,
    updated_replicas: 2,
    images: 'registry.example.invalid/web:1',
  },
  {
    ...polled('example-site', T2),
    source: 'workloads',
    entity: 'example-ns/web-abc',
    namespace: 'example-ns',
    cpu_cores: 0.05,
    memory_bytes: 104857600,
    measured_at: '2025-10-09T11:59:00Z',
  },
  {
    ...polled('example-site', T2),
    source: 'deployments',
    entity: 'example-site',
    ready: 'True',
    revision: 'main@sha1:0000000000000000000000000000000000000002',
    transition_at: '2025-10-08T10:00:00Z',
  },
  {
    ...polled('example-site', T2),
    source: 'ci',
    entity: 'example-org/example-site',
    workflow: 'CI',
    run_status: 'completed',
    conclusion: 'success',
    revision: '0000000000000000000000000000000000000002',
    run_updated_at: '2025-10-09T11:00:00Z',
  },
  {
    ...polled('example-site', T2),
    source: 'glitchtip',
    entity: 'connection',
    status: 'error',
    last_success_at: undefined,
  },
  {
    project: 'example-site',
    source: 'codex',
    entity: 'connection',
    record_kind: 'configuration',
    status: 'opt_in_import_required',
    _timestamp: T2,
    observed_at: T2,
  },
  // Second project.
  {
    ...polled('example-internal', T2),
    source: 'matomo',
    entity: 'connection',
    status: 'not_connected',
    last_success_at: undefined,
  },
  {
    ...polled('example-internal', T2),
    source: 'workloads',
    entity: 'internal-ns/api',
    namespace: 'internal-ns',
    desired_replicas: 1,
    ready_replicas: 0,
    updated_replicas: 1,
    images: 'registry.example.invalid/api:3',
  },
];

/** Fixture records parsed from {@link PROJECT_OBSERVABILITY_FIXTURE_HITS}. */
export const PROJECT_OBSERVABILITY_FIXTURE_RECORDS: readonly ProjectObservabilityRecord[] =
  PROJECT_OBSERVABILITY_FIXTURE_HITS.map(
    parseProjectObservabilityRecord,
  ).filter((rec): rec is ProjectObservabilityRecord => rec !== null);
