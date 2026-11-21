/**
 * db:feed-gaps Command — change-feed gap markers (#5438).
 *
 * A gap marker records a change-feed entry the PostgreSQL drain could not
 * sequence (the feed refused it), so it is kept instead of vanishing or
 * stopping every later drain. `status` reports the markers in each state and
 * the gap rows already in the feed. It only reads: every statement is a
 * SELECT, so a read-only role can run it, and it exits zero whatever it finds.
 *
 * Delivery of markers to feed readers is not enabled by this release; the
 * report says so. Tables in the live sensitive set are omitted (#2937), and
 * no row id or tenant of a lost entry is printed.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/** Parsed CLI options for `db:feed-gaps`. */
interface DbFeedGapsOptions {
  json?: boolean;
}

/** What `db:feed-gaps status` reports. */
export interface FeedGapStatus {
  /** Whether the gap table exists (PostgreSQL databases bootstrapped by 1a+). */
  available: boolean;
  /** Whether the delivery setting is present (never, in this release). */
  deliveryEnabled: boolean;
  /** Markers waiting for a feed position, blocked ones included. */
  unconverted: number;
  /** Unconverted markers whose conversion failed. */
  blocked: number;
  /** Markers retired by an operator; they count in table versions for good. */
  reconciled: number;
  /** Gap rows in the retained feed. */
  positioned: number;
  /** Gap rows in the retained feed with no evidence row. */
  positionedWithoutEvidence: number;
  /** Highest sequence of a gap row in the retained feed. */
  lastPositionedSeq: number | null;
  /** Unconverted and blocked markers per table, sensitive tables omitted. */
  tables: Array<{ table: string; unconverted: number; blocked: number }>;
}

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  return [];
}

const count = (value: unknown): number =>
  value == null ? 0 : Number.parseInt(String(value), 10) || 0;

/**
 * Read the gap-marker status of a PostgreSQL database. SELECT statements
 * only. `sensitiveTables` are left out of every count and listing.
 */
export async function readFeedGapStatus(
  db: Pick<DatabaseInterface, 'query'>,
  sensitiveTables: readonly string[],
): Promise<FeedGapStatus> {
  const presence = rowsOf(
    await db.query(
      `SELECT to_regclass('_smrt_change_gaps') IS NOT NULL AS gaps,
              to_regclass('_smrt_backfills') IS NOT NULL AS settings`,
    ),
  )[0];
  const empty: FeedGapStatus = {
    available: false,
    deliveryEnabled: false,
    unconverted: 0,
    blocked: 0,
    reconciled: 0,
    positioned: 0,
    positionedWithoutEvidence: 0,
    lastPositionedSeq: null,
    tables: [],
  };
  const truthy = (value: unknown) => value === true || value === 't';
  if (!truthy(presence?.gaps)) return empty;
  const excluded = JSON.stringify([...sensitiveTables]);
  const notSensitive = (column: string) =>
    `NOT (${column} = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb))))`;

  const deliveryEnabled = truthy(presence?.settings)
    ? rowsOf(
        await db.query(
          `SELECT EXISTS (
             SELECT 1 FROM _smrt_backfills
             WHERE name = '@happyvertical/smrt-core:change-feed-gap-delivery:v1'
           ) AS enabled`,
        ),
      )[0]?.enabled
    : false;

  const totals =
    rowsOf(
      await db.query(
        `SELECT
           count(*) FILTER (WHERE converted_seq IS NULL AND reconciled_at IS NULL) AS unconverted,
           count(*) FILTER (WHERE converted_seq IS NULL AND reconciled_at IS NULL AND blocked_at IS NOT NULL) AS blocked,
           count(*) FILTER (WHERE reconciled_at IS NOT NULL) AS reconciled
         FROM _smrt_change_gaps
         WHERE ${notSensitive('table_name')}`,
        excluded,
      ),
    )[0] ?? {};

  const positioned =
    rowsOf(
      await db.query(
        `SELECT
           count(*) AS positioned,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM _smrt_change_gaps AS evidence
             WHERE evidence.converted_seq = feed.seq
           )) AS without_evidence,
           MAX(feed.seq) AS last_seq
         FROM _smrt_changes AS feed
         WHERE feed.operation = 'gap' AND ${notSensitive('feed.table_name')}`,
        excluded,
      ),
    )[0] ?? {};

  const tables = rowsOf(
    await db.query(
      `SELECT table_name,
              count(*) AS unconverted,
              count(*) FILTER (WHERE blocked_at IS NOT NULL) AS blocked
         FROM _smrt_change_gaps
        WHERE converted_seq IS NULL AND reconciled_at IS NULL
          AND ${notSensitive('table_name')}
        GROUP BY table_name
        ORDER BY table_name`,
      excluded,
    ),
  ).map((row) => ({
    table: String(row.table_name),
    unconverted: count(row.unconverted),
    blocked: count(row.blocked),
  }));

  return {
    available: true,
    deliveryEnabled: truthy(deliveryEnabled),
    unconverted: count(totals.unconverted),
    blocked: count(totals.blocked),
    reconciled: count(totals.reconciled),
    positioned: count(positioned.positioned),
    positionedWithoutEvidence: count(positioned.without_evidence),
    lastPositionedSeq:
      positioned.last_seq == null ? null : count(positioned.last_seq),
    tables,
  };
}

/** Human-readable report for {@link readFeedGapStatus}. */
export function formatFeedGapStatus(status: FeedGapStatus): string {
  if (!status.available) {
    return 'No gap-marker table in this database (it is created by the system-table bootstrap on PostgreSQL).';
  }
  const lines = [
    `Delivery:                     ${status.deliveryEnabled ? 'enabled' : 'off (markers are kept and counted in table versions)'}`,
    `Unconverted markers:          ${status.unconverted}`,
    `  of which blocked:           ${status.blocked}`,
    `Reconciled markers:           ${status.reconciled}`,
    `Gap rows in the feed:         ${status.positioned}${status.lastPositionedSeq == null ? '' : ` (last sequence ${status.lastPositionedSeq})`}`,
    `  without evidence:           ${status.positionedWithoutEvidence}`,
  ];
  if (status.tables.length > 0) {
    lines.push('', 'Waiting markers by table:');
    for (const entry of status.tables) {
      lines.push(
        `  ${entry.table}: ${entry.unconverted} waiting, ${entry.blocked} blocked`,
      );
    }
  }
  return lines.join('\n');
}

export const dbFeedGapsCommand: CLICommand = {
  name: 'db:feed-gaps',
  description:
    'Report change-feed gap markers (entries the feed could not sequence)',
  args: ['<action>'],
  options: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (args: string[], options: DbFeedGapsOptions) => {
    const action = args[0] ?? 'status';
    if (action !== 'status') {
      const message = `Unknown db:feed-gaps action "${action}". Available: status.`;
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(`\n❌ ${message}\n`);
      process.exitCode = 1;
      return;
    }

    let db: DatabaseInterface | undefined;
    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (!config.database?.url) {
        const message =
          'Database not configured. Set database.url in smrt.config.ts.';
        if (options.json) console.log(JSON.stringify({ error: message }));
        else console.error(`\n❌ ${message}\n`);
        process.exitCode = 1;
        return;
      }
      const dbUrl = config.database.url;
      const dbType = config.database.type || 'sqlite';
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });

      if (dbType !== 'postgres') {
        const message =
          'Gap markers are recorded on PostgreSQL only in this release.';
        if (options.json) {
          console.log(JSON.stringify({ available: false, message }));
        } else {
          console.log(`\n${message}\n`);
        }
        return;
      }

      const { getChangeFeedSensitiveTables } = await import(
        '@happyvertical/smrt-core'
      );
      const status = await readFeedGapStatus(
        db,
        getChangeFeedSensitiveTables(),
      );
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log('\n📭 Change-feed gap markers\n');
        console.log(`Database: ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`);
        console.log(formatFeedGapStatus(status));
        console.log();
      }
    } catch (error) {
      const message = redactDatabaseUrlsInText(
        error instanceof Error ? error.message : String(error),
      );
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(`\n❌ db:feed-gaps failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

export default dbFeedGapsCommand;
