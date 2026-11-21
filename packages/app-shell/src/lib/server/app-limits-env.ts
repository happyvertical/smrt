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
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
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
 * The operator's statement timeout for every app's PostgreSQL statements (ms),
 * as `WorkerLimits.statementTimeoutMs` (#5192, wired here by #5503), or
 * undefined when `SMRT_APP_SHELL_STATEMENT_TIMEOUT_MS` is not set (no
 * timeout, as before). SQLite ignores it. A bad value is refused at start.
 */
export function workerLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): WorkerLimits | undefined {
  const name = 'SMRT_APP_SHELL_STATEMENT_TIMEOUT_MS';
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  return { statementTimeoutMs: whole(name, raw, 1) };
}
