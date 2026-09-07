import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';

export const AGENT_SCHEDULE_SLUG_BACKFILL =
  '@happyvertical/smrt-agents:agent-schedule-slugs:v1';
export const AGENT_SCHEDULE_TABLE = '_smrt_agent_schedules';

export interface AgentScheduleSlugBackfillOptions {
  backfillName?: string;
  packageName?: string;
  lockTimeout?: number;
  statementTimeout?: number;
}

export interface AgentScheduleSlugBackfillResult {
  ran: boolean;
  updated: number;
}

export interface AgentScheduleSlugBackfillPlan {
  pending: number;
}

export class AgentScheduleSlugBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentScheduleSlugBackfillError';
  }
}

type ScheduleIdentityRow = {
  id: unknown;
  slug: unknown;
  context: unknown;
  tenant_id: unknown;
};

type Candidate = { id: string; slug: string; context: string };

/** Mirrors SmrtObject.getSlug()'s final id fallback for persisted schedules. */
export function canonicalScheduleSlug(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || null;
}

function isPresentSlug(value: unknown): value is string {
  // Preserve every nonempty persisted value. Only SQL NULL and the actual
  // empty string are legacy gaps; normalizing whitespace would rewrite data.
  return typeof value === 'string' && value !== '';
}

function normalizeRows(rows: readonly ScheduleIdentityRow[]): Candidate[] {
  const seen = new Map<string, string>();
  const candidates: Candidate[] = [];

  for (const row of rows) {
    if (typeof row.context !== 'string') {
      throw new AgentScheduleSlugBackfillError(
        `${AGENT_SCHEDULE_TABLE}.context must be a non-null string before schedule slug migration`,
      );
    }
    if (row.tenant_id !== null && typeof row.tenant_id !== 'string') {
      throw new AgentScheduleSlugBackfillError(
        `${AGENT_SCHEDULE_TABLE}.tenant_id must be a string or null before schedule slug migration`,
      );
    }
    const slug = isPresentSlug(row.slug)
      ? row.slug
      : canonicalScheduleSlug(row.id);
    if (!slug || typeof row.id !== 'string' || row.id.trim() === '') {
      throw new AgentScheduleSlugBackfillError(
        `Cannot derive a canonical slug for a legacy ${AGENT_SCHEDULE_TABLE} row with a missing or malformed id`,
      );
    }
    const key = JSON.stringify([row.tenant_id, row.context, slug]);
    const prior = seen.get(key);
    if (prior && prior !== row.id) {
      throw new AgentScheduleSlugBackfillError(
        `Refusing schedule slug migration: canonical slug ${JSON.stringify(slug)} collides within tenant ${JSON.stringify(row.tenant_id)} and context ${JSON.stringify(row.context)}`,
      );
    }
    seen.set(key, row.id);
    if (!isPresentSlug(row.slug))
      candidates.push({ id: row.id, slug, context: row.context });
  }

  return candidates;
}

async function readRows(db: Pick<DatabaseInterface, 'query'>) {
  const result = await db.query(
    `SELECT id, slug, context, tenant_id FROM "${AGENT_SCHEDULE_TABLE}" ORDER BY id`,
  );
  return result.rows as ScheduleIdentityRow[];
}

async function assertSupportedShape(db: DatabaseInterface): Promise<void> {
  const schema = await db.getTableSchema?.(AGENT_SCHEDULE_TABLE);
  if (
    !schema?.columns.id ||
    !schema.columns.slug ||
    !schema.columns.context ||
    !schema.columns.tenant_id
  ) {
    throw new AgentScheduleSlugBackfillError(
      `${AGENT_SCHEDULE_TABLE} must contain id, slug, context, and tenant_id columns; run db:migrate before migrating schedule slugs`,
    );
  }
}

function timeout(value: number | undefined, fallback: number): string {
  const milliseconds = value ?? fallback;
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new AgentScheduleSlugBackfillError(
      'Migration timeout must be a positive integer',
    );
  }
  return `${milliseconds}ms`;
}

/** Validate the exact legacy schedule identities without mutating the database. */
export async function planAgentScheduleSlugMigration(
  db: DatabaseInterface,
): Promise<AgentScheduleSlugBackfillPlan> {
  await assertSupportedShape(db);
  return { pending: normalizeRows(await readRows(db)).length };
}

/**
 * Backfill inherited AgentSchedule slugs and enforce the current NOT NULL
 * contract. This is deliberately operator-invoked: it takes an exclusive
 * table lock and never starts or evaluates schedules.
 */
export async function migrateAgentScheduleSlugs(
  db: DatabaseInterface,
  options: AgentScheduleSlugBackfillOptions = {},
): Promise<AgentScheduleSlugBackfillResult> {
  if (!db.transaction) {
    throw new AgentScheduleSlugBackfillError(
      'Agent schedule slug migration requires a transaction-capable PostgreSQL adapter',
    );
  }
  await planAgentScheduleSlugMigration(db);
  const tracker = new BackfillTracker({ db });
  await tracker.initialize();
  const backfillName = options.backfillName ?? AGENT_SCHEDULE_SLUG_BACKFILL;

  return db.transaction(async (tx) => {
    BackfillTracker.inheritInitialization(tx, db);
    const transactionTracker = new BackfillTracker({ db: tx });
    await tx.query(
      `SET LOCAL lock_timeout = '${timeout(options.lockTimeout, 30_000)}'`,
    );
    await tx.query(
      `SET LOCAL statement_timeout = '${timeout(options.statementTimeout, 60_000)}'`,
    );
    await tx.query(
      `LOCK TABLE "${AGENT_SCHEDULE_TABLE}" IN ACCESS EXCLUSIVE MODE`,
    );

    const rows = await readRows(tx);
    const candidates = normalizeRows(rows);
    if (await transactionTracker.isApplied(backfillName)) {
      if (candidates.length > 0) {
        throw new AgentScheduleSlugBackfillError(
          'The schedule slug backfill marker exists but rows still need migration; refusing inconsistent state',
        );
      }
      return { ran: false, updated: 0 };
    }

    for (const candidate of candidates) {
      await tx.query(
        `UPDATE "${AGENT_SCHEDULE_TABLE}" SET slug = ? WHERE id = ? AND (slug IS NULL OR slug = '')`,
        candidate.slug,
        candidate.id,
      );
    }

    const after = await readRows(tx);
    if (normalizeRows(after).length > 0) {
      throw new AgentScheduleSlugBackfillError(
        'Schedule slug migration did not fill every missing slug',
      );
    }
    await tx.query(
      `ALTER TABLE "${AGENT_SCHEDULE_TABLE}" ALTER COLUMN slug SET NOT NULL`,
    );
    await transactionTracker.recordApplied(backfillName, {
      description: 'Backfilled canonical slugs for legacy AgentSchedule rows.',
      packageName: options.packageName ?? '@happyvertical/smrt-agents',
    });
    return { ran: true, updated: candidates.length };
  });
}
