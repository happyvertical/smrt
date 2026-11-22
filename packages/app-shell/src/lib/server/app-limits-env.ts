// The operator's per-app caps from the environment (#5503). No plan carries a
// numeric entitlement yet (smrt-features flags are on/off), so the cloud
// profile's default is one operator-set cap set for every tenant's app; a plan
// that grants numbers replaces this behind `ShellContext.appLimits`.
import type { AppLimits, WorkerLimits } from '../../engine/index.ts';

const ENV_FIELDS = {
  SMRT_APP_SHELL_MAX_MODELS: 'maxModels',
  SMRT_APP_SHELL_MAX_ROWS: 'maxRows',
  SMRT_APP_SHELL_MAX_ROWS_PER_MODEL: 'maxRowsPerModel',
  SMRT_APP_SHELL_MAX_METHOD_RUNS: 'maxMethodRuns',
  SMRT_APP_SHELL_METHOD_RUN_PERIOD_MS: 'methodRunPeriodMs',
} as const;

function whole(name: string, raw: string, min: number): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min)
    throw new Error(`${name} must be a whole number, ${min} or more`);
  return n;
}

/**
 * The caps every cloud app gets, or undefined when none of the variables is
 * set (apps are then uncapped, as before). A bad value is refused at start,
 * not ignored; `SMRT_APP_SHELL_MAX_METHOD_RUNS` needs the period.
 */
export function appLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AppLimits | undefined {
  const limits: Record<string, number> = {};
  for (const [name, field] of Object.entries(ENV_FIELDS)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    limits[field] = whole(name, raw, field === 'methodRunPeriodMs' ? 1 : 0);
  }
  if (limits.maxMethodRuns !== undefined && !limits.methodRunPeriodMs)
    throw new Error(
      'SMRT_APP_SHELL_MAX_METHOD_RUNS needs SMRT_APP_SHELL_METHOD_RUN_PERIOD_MS',
    );
  return Object.keys(limits).length ? (limits as AppLimits) : undefined;
}

/**
 * The operator's timeouts for every app's PostgreSQL work (ms), as
 * `WorkerLimits` (#5192, wired here by #5503): `statementTimeoutMs` from
 * `SMRT_APP_SHELL_STATEMENT_TIMEOUT_MS` (the server cancels one statement) and
 * `opDeadlineMs` from `SMRT_APP_SHELL_OP_TIMEOUT_MS` (the broker cancels,
 * rolls back and revokes a whole operation, #5188). Undefined when neither is
 * set (nothing here; the shell's hosted default for the operation deadline is
 * `DEFAULT_OP_DEADLINE_MS`). SQLite ignores both. A bad value is refused at start.
 */
export function workerLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): WorkerLimits | undefined {
  const limits: WorkerLimits = {};
  for (const [name, field] of [
    ['SMRT_APP_SHELL_STATEMENT_TIMEOUT_MS', 'statementTimeoutMs'],
    ['SMRT_APP_SHELL_OP_TIMEOUT_MS', 'opDeadlineMs'],
  ] as const) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    limits[field] = whole(name, raw, 1);
  }
  return Object.keys(limits).length ? limits : undefined;
}

/** How long a user's operation (data lane) may stay open on hosted PostgreSQL unless the operator sets `SMRT_APP_SHELL_OP_TIMEOUT_MS` (ms, then every lane). */
export const DEFAULT_OP_DEADLINE_MS = 60_000;

/**
 * The env-derived pieces of a `ShellContext`, read only once the profile is
 * `cloud` (#5503): on the desktop nothing is parsed, so a bad variable cannot
 * stop it and no statement timeout reaches its hosts. A bad value in cloud
 * throws on the first read (the first host open).
 */
export function cloudLimitsFromEnv(
  profile: () => string | null,
  env: Record<string, string | undefined> = process.env,
): {
  readonly workerLimits: WorkerLimits | undefined;
  appLimits: () => AppLimits | undefined;
} {
  let app: { v: AppLimits | undefined } | null = null;
  let worker: { v: WorkerLimits | undefined } | null = null;
  return {
    get workerLimits() {
      if (profile() !== 'cloud') return undefined;
      worker ??= { v: workerLimitsFromEnv(env) };
      return worker.v;
    },
    appLimits() {
      if (profile() !== 'cloud') return undefined;
      app ??= { v: appLimitsFromEnv(env) };
      return app.v;
    },
  };
}
