/** Permanent deployment data-step ledger. Schema changes belong to MigrationTracker. */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabaseEngine } from '../system/compatibility.js';

type Session = Awaited<
  ReturnType<NonNullable<DatabaseInterface['acquireSession']>>
>;
/** Maximum UTF-8 byte length of serialized checkpoint JSON (16 KiB). */
export const MAX_DEPLOYMENT_CHECKPOINT_BYTES = 16 * 1024;

export type DeploymentStepMode = 'transactional' | 'reconciled';
export type DeploymentStepStatus = 'running' | 'complete' | 'needs-repair';
export interface DeploymentStepKey {
  application: string;
  environment: string;
  stepId: string;
}
export interface DeploymentStepRecord extends DeploymentStepKey {
  checksum: string;
  mode: DeploymentStepMode;
  status: DeploymentStepStatus;
  checkpoint: unknown;
}
/** All mutations must use this pinned connection; do not use a pooled root db. */
export type DeploymentStepTransaction = Pick<Session, 'query'>;
export interface DeploymentStepOptions extends DeploymentStepKey {
  checksum: string;
  /** Must verify runtime/static agreement AND writer quiescence; throw to refuse. */
  checkSafety: (connection: DeploymentStepTransaction) => Promise<void>;
  /** Bounded advisory-lock wait. Defaults to 30 seconds. */
  lockTimeoutMs?: number;
}
export interface DeploymentReconciliation {
  outcome: 'complete' | 'safe-to-resume' | 'needs-repair';
  checkpoint?: unknown;
}
export interface DeploymentReconciledContext extends DeploymentStepTransaction {
  checkpoint: unknown;
  /** Persist progress before an external operation; never secrets. */
  saveCheckpoint: (value: unknown) => Promise<void>;
  /** Check before external effects. Does not fence an external service. */
  assertActive: () => Promise<void>;
}
export class DeploymentStepError extends Error {
  constructor(
    public readonly code:
      | 'UNSUPPORTED'
      | 'CHECKSUM_MISMATCH'
      | 'NEEDS_REPAIR'
      | 'SESSION_LOST'
      | 'INVALID_CHECKPOINT',
    message: string,
  ) {
    super(message);
    this.name = 'DeploymentStepError';
  }
}
const TABLE = '_smrt_deployment_steps';
const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
 application TEXT NOT NULL, environment TEXT NOT NULL, step_id TEXT NOT NULL,
 checksum TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('transactional', 'reconciled')),
 status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'needs-repair')),
 checkpoint JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (application, environment, step_id)
)`;

/** PostgreSQL only; no retention: deleting a completed marker permits replay. */
export class DeploymentPhaseTracker {
  private readonly acquireSession: () => Promise<Session>;

  constructor(db: DatabaseInterface) {
    if (getDatabaseEngine(db) !== 'postgres' || !db.acquireSession) {
      throw new DeploymentStepError(
        'UNSUPPORTED',
        'Deployment steps require PostgreSQL acquireSession().',
      );
    }
    this.acquireSession = db.acquireSession.bind(db);
  }

  /** Read-only, including before the ledger is provisioned. */
  async getStepStatus(
    key: DeploymentStepKey,
  ): Promise<DeploymentStepRecord | null> {
    validateKey(key);
    const session = await this.acquireSession();
    try {
      const table = await session.query(
        'SELECT to_regclass(?) AS relation',
        TABLE,
      );
      if (!table.rows[0]?.relation) return null;
      return await readRecord(session, key);
    } finally {
      await session.release();
    }
  }

  async runTransactionalStep(
    options: DeploymentStepOptions,
    work: (tx: DeploymentStepTransaction) => Promise<void>,
  ): Promise<DeploymentStepRecord> {
    return this.locked(options, async (session) => {
      await session.query('BEGIN');
      try {
        const previous = await readRecord(session, options);
        assertCompatible(previous, options, 'transactional');
        if (previous?.status === 'complete') {
          await session.query('COMMIT');
          return previous;
        }
        if (previous) throw repairRequired();
        await writeRecord(session, options, 'transactional', 'running', null);
        await work({ query: session.query.bind(session) });
        await writeRecord(session, options, 'transactional', 'complete', null);
        await session.query('COMMIT');
      } catch (error) {
        // A lost COMMIT response is ambiguous. Never retry work here: next call
        // observes either the atomically committed marker+data or neither.
        if (session.isActive()) {
          try {
            await session.query('ROLLBACK');
          } catch {
            // Preserve the work/commit failure if the connection died meanwhile.
          }
        }
        throw error;
      }
      return requireRecord(await readRecord(session, options));
    });
  }

  async runReconciledStep(
    options: DeploymentStepOptions & {
      inspect: (
        context: DeploymentReconciledContext,
      ) => Promise<DeploymentReconciliation>;
      apply: (context: DeploymentReconciledContext) => Promise<void>;
    },
  ): Promise<DeploymentStepRecord> {
    return this.locked(options, async (session) => {
      const previous = await readRecord(session, options);
      assertCompatible(previous, options, 'reconciled');
      if (previous?.status === 'complete') return previous;
      let checkpoint: unknown = previous?.checkpoint ?? null;
      const context: DeploymentReconciledContext = {
        query: session.query.bind(session),
        checkpoint,
        assertActive: async () => {
          if (!session.isActive())
            throw new DeploymentStepError(
              'SESSION_LOST',
              'Deployment session was lost.',
            );
          await session.query('SELECT 1');
        },
        saveCheckpoint: async (value) => {
          await writeRecord(session, options, 'reconciled', 'running', value);
          checkpoint = value;
          context.checkpoint = value;
        },
      };
      // Committed BEFORE inspection/application: interruption is durably unknown.
      await writeRecord(session, options, 'reconciled', 'running', checkpoint);
      try {
        const inspection = await options.inspect(context);
        checkpoint =
          inspection.checkpoint === undefined
            ? context.checkpoint
            : inspection.checkpoint;
        context.checkpoint = checkpoint;
        if (inspection.outcome === 'needs-repair') throw repairRequired();
        if (
          inspection.outcome !== 'complete' &&
          inspection.outcome !== 'safe-to-resume'
        )
          throw repairRequired();
        if (inspection.outcome === 'safe-to-resume') {
          await writeRecord(
            session,
            options,
            'reconciled',
            'running',
            checkpoint,
          );
          await context.assertActive();
          await options.apply(context);
          // Apply's return alone is not proof: independently reconcile effects.
          const verified = await options.inspect(context);
          checkpoint =
            verified.checkpoint === undefined
              ? context.checkpoint
              : verified.checkpoint;
          context.checkpoint = checkpoint;
          if (verified.outcome !== 'complete') throw repairRequired();
        }
        await context.assertActive();
        await writeRecord(
          session,
          options,
          'reconciled',
          'complete',
          checkpoint,
        );
      } catch (error) {
        // Preserve the original failure; a dead connection leaves running and
        // the next executor MUST inspect it, never blindly replay the command.
        if (session.isActive()) {
          try {
            await writeRecord(
              session,
              options,
              'reconciled',
              'needs-repair',
              context.checkpoint,
            );
          } catch {
            /* durable running marker remains unresolved */
          }
        }
        throw error;
      }
      return requireRecord(await readRecord(session, options));
    });
  }

  private async locked<T>(
    options: DeploymentStepOptions,
    work: (session: Session) => Promise<T>,
  ): Promise<T> {
    validateKey(options);
    if (!options.checksum?.trim() || typeof options.checkSafety !== 'function')
      throw new TypeError('checksum and checkSafety are required.');
    const timeout = options.lockTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      throw new TypeError('lockTimeoutMs must be a positive safe integer.');
    const session = await this.acquireSession();
    try {
      await session.query(
        "SELECT set_config('lock_timeout', ?, false)",
        `${timeout}ms`,
      );
      // All steps within one application/environment serialize, including DDL.
      await session.query(
        "SELECT pg_advisory_lock(hashtext('smrt:deployment'), hashtext(?))",
        JSON.stringify([options.application, options.environment]),
      );
      await options.checkSafety({ query: session.query.bind(session) });
      // Separate global initialization lock prevents concurrent CREATE races
      // across scopes. Both DDL and this lock are outside the data transaction.
      await session.query(
        "SELECT pg_advisory_lock(hashtext('smrt:deployment'), hashtext('ledger:init'))",
      );
      try {
        await session.query(DDL);
      } finally {
        await session.query(
          "SELECT pg_advisory_unlock(hashtext('smrt:deployment'), hashtext('ledger:init'))",
        );
      }
      return await work(session);
    } finally {
      await session.release();
    }
  }
}

function validateKey(key: DeploymentStepKey): void {
  for (const value of [key.application, key.environment, key.stepId]) {
    if (typeof value !== 'string' || !value.trim())
      throw new TypeError(
        'application, environment and stepId must be nonempty.',
      );
  }
}
function assertCompatible(
  record: DeploymentStepRecord | null,
  options: DeploymentStepOptions,
  mode: DeploymentStepMode,
): void {
  if (
    record &&
    (record.checksum !== options.checksum || record.mode !== mode)
  ) {
    throw new DeploymentStepError(
      'CHECKSUM_MISMATCH',
      'Stable deployment step checksum or mode changed; use a new step ID.',
    );
  }
}
function repairRequired(): DeploymentStepError {
  return new DeploymentStepError(
    'NEEDS_REPAIR',
    'Deployment step requires explicit reconciliation or operator repair.',
  );
}
function requireRecord(
  record: DeploymentStepRecord | null,
): DeploymentStepRecord {
  if (!record) throw new Error('Deployment step marker is missing.');
  return record;
}
async function readRecord(
  session: Session,
  key: DeploymentStepKey,
): Promise<DeploymentStepRecord | null> {
  const result = await session.query(
    `SELECT checksum, mode, status, checkpoint FROM ${TABLE} WHERE application = ? AND environment = ? AND step_id = ?`,
    key.application,
    key.environment,
    key.stepId,
  );
  const row = result.rows[0];
  return row
    ? {
        application: key.application,
        environment: key.environment,
        stepId: key.stepId,
        checksum: String(row.checksum),
        mode: row.mode,
        status: row.status,
        checkpoint: row.checkpoint,
      }
    : null;
}
async function writeRecord(
  session: Session,
  key: DeploymentStepOptions,
  mode: DeploymentStepMode,
  status: DeploymentStepStatus,
  checkpoint: unknown,
): Promise<void> {
  const serializedCheckpoint = serializeCheckpoint(checkpoint);
  await session.query(
    `INSERT INTO ${TABLE} (application, environment, step_id, checksum, mode, status, checkpoint)
    VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)
    ON CONFLICT (application, environment, step_id) DO UPDATE SET status = EXCLUDED.status, checkpoint = EXCLUDED.checkpoint, updated_at = CURRENT_TIMESTAMP`,
    key.application,
    key.environment,
    key.stepId,
    key.checksum,
    mode,
    status,
    serializedCheckpoint,
  );
}

function serializeCheckpoint(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    throw new DeploymentStepError(
      'INVALID_CHECKPOINT',
      'Deployment checkpoint must be JSON serializable.',
    );
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength >
      MAX_DEPLOYMENT_CHECKPOINT_BYTES
  ) {
    throw new DeploymentStepError(
      'INVALID_CHECKPOINT',
      'Deployment checkpoint must be JSON serializable and at most 16 KiB UTF-8.',
    );
  }
  return serialized;
}
