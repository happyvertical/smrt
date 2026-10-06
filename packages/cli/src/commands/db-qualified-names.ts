/**
 * Stored references to deprecated qualified names (#3338).
 *
 * `smrt doctor --db` reports how many rows still store a name a class
 * declared in `@smrt({ previousQualifiedNames })` — the signal that an alias
 * can (or cannot yet) be removed. `smrt db:migrate-qualified-names` is the
 * opt-in, idempotent cleanup; nothing rewrites stored names automatically.
 */

import {
  backfillLegacyQualifiedNames,
  countLegacyQualifiedNameReferences,
  type LegacyQualifiedNameReport,
} from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/** Result of one CLI-level legacy-name count. */
export interface LegacyQualifiedNameOutcome {
  report: LegacyQualifiedNameReport | null;
  /** Human-readable failure reason; non-null exactly when `report` is null. */
  error: string | null;
}

async function connect(): Promise<{
  db: DatabaseInterface;
  dbType: string;
  url: string;
}> {
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');
  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  if (!config.database?.url || config.database.url === ':memory:') {
    throw new Error(
      'No persistent database is configured. Set `database.url` in smrt.config.ts (or DATABASE_URL).',
    );
  }
  const dbType = config.database.type || 'sqlite';
  const { getDatabase } = await import('@happyvertical/sql');
  const db = await getDatabase({ type: dbType, url: config.database.url });
  return { db, dbType, url: config.database.url };
}

/**
 * Count stored deprecated qualified names in the configured database.
 * Never throws for an operational problem.
 */
export async function runLegacyQualifiedNameReport(
  options: { discover?: boolean } = {},
): Promise<LegacyQualifiedNameOutcome> {
  let db: DatabaseInterface | undefined;
  try {
    if (options.discover ?? true) await autoDiscoverAndLoad();
    const connection = await connect();
    db = connection.db;
    const report = await countLegacyQualifiedNameReferences(db, {
      engineHint: connection.dbType,
    });
    return { report, error: null };
  } catch (error) {
    return {
      report: null,
      error: redactDatabaseUrlsInText(
        error instanceof Error ? error.message : String(error),
      ),
    };
  } finally {
    await closeDatabaseConnection(db);
  }
}

/**
 * Render a legacy-name report as the lines `smrt doctor --db` and
 * `smrt db:migrate-qualified-names` print.
 *
 * A zero count is a removal signal only when it is global and complete: a
 * tenant-scoped count (`tenantId`) or one that skipped untenanted tables
 * never says the aliases are removable. Stored rows are also only half the
 * picture, so every report reminds the operator that source still naming an
 * old name must move first.
 */
export function formatLegacyQualifiedNameReport(
  report: LegacyQualifiedNameReport,
  options: { tenantId?: string } = {},
): string[] {
  if (report.aliases.length === 0) {
    return ['   No class declares previousQualifiedNames.'];
  }
  const scope =
    options.tenantId !== undefined ? ` for tenant ${options.tenantId}` : '';
  const lines = [
    `   Declared aliases: ${report.aliases.length}`,
    ...report.aliases.map(
      ({ alias, current }) => `     - ${alias} → ${current}`,
    ),
  ];
  if (report.total > 0) {
    lines.push(
      `   ⚠️  ${report.total} stored reference(s)${scope} still use a deprecated name:`,
    );
    for (const reference of report.references) {
      lines.push(
        `     - ${reference.table}.${reference.column} = ${reference.alias}: ${reference.count} row(s)`,
      );
    }
    lines.push(
      '   They keep resolving. Rewrite them early with `smrt db:migrate-qualified-names` (opt-in); keep the aliases until this count is zero.',
    );
  } else if (options.tenantId !== undefined) {
    lines.push(
      `   ✅ No counted row${scope} uses a deprecated name. This is a tenant-scoped count, not a removal signal: other tenants and untenanted tables were not counted. Run without --tenant (or \`smrt doctor --db\`) before deciding to remove an alias.`,
    );
  } else if (report.untenantedTables.length > 0) {
    lines.push(
      '   ✅ No counted row uses a deprecated name, but some tables were skipped (below), so this is not a removal signal.',
    );
  } else {
    lines.push(
      '   ✅ No stored row in this database uses a deprecated name. The aliases may be removed in a breaking release once every deployment reports zero and no source still names them.',
    );
  }
  if (report.untenantedTables.length > 0) {
    lines.push(
      `   Skipped (no tenant column, not counted): ${report.untenantedTables.join(', ')}`,
    );
  }
  if (report.missingTables.length > 0) {
    lines.push(
      `   (not migrated in this database: ${report.missingTables.join(', ')})`,
    );
  }
  lines.push(
    '   Before removing an alias, also update source still naming an old qualified name (@crossPackageRef / relationship targets, playbook step models) to the current name.',
  );
  return lines;
}

interface DbMigrateQualifiedNamesOptions {
  'dry-run'?: boolean;
  tenant?: string;
  force?: boolean;
}

/** `smrt db:migrate-qualified-names` — the opt-in rewrite. */
export const dbMigrateQualifiedNamesCommand: CLICommand = {
  name: 'db:migrate-qualified-names',
  description:
    'Rewrite stored deprecated qualified names (declared via @smrt({ previousQualifiedNames })) to current names. Opt-in and idempotent (#3338).',
  aliases: ['migrate-qualified-names'],
  args: [],
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Report the rows that would be rewritten without writing.',
      default: false,
    },
    tenant: {
      type: 'string',
      description:
        "Rewrite only this tenant's rows (tables without a tenant column are skipped).",
    },
    force: {
      type: 'boolean',
      description: 'Run again even if this alias set was already recorded.',
      default: false,
    },
  },
  handler: async (_args: string[], options: DbMigrateQualifiedNamesOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      await autoDiscoverAndLoad();
      const connection = await connect();
      db = connection.db;
      console.log('\n🏷️  Deprecated qualified-name backfill\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(connection.dbType, connection.url)}\n`,
      );
      const result = await backfillLegacyQualifiedNames(db, {
        engineHint: connection.dbType,
        dryRun: options['dry-run'] === true,
        force: options.force === true,
        ...(options.tenant ? { tenantId: options.tenant } : {}),
      });
      for (const line of formatLegacyQualifiedNameReport(result.before, {
        ...(options.tenant ? { tenantId: options.tenant } : {}),
      })) {
        console.log(line);
      }
      console.log();
      if (result.dryRun) {
        console.log('DRY RUN: no changes made.\n');
        return;
      }
      if (!result.ran) {
        console.log(
          result.before.aliases.length === 0
            ? 'Nothing to do.\n'
            : `Already applied (${result.backfillName}); pass --force to run again.\n`,
        );
        return;
      }
      for (const reference of result.rewritten) {
        console.log(
          `✓ ${reference.table}.${reference.column}: ${reference.count} row(s) ${reference.alias} → ${reference.current}`,
        );
      }
      for (const reference of result.skippedDuplicates) {
        console.log(
          `⚠️  ${reference.table}.${reference.column}: ${reference.count} row(s) kept as ${reference.alias} — a row with the same identity already uses ${reference.current}. Resolve the duplicates, then re-run.`,
        );
      }
      if (result.skippedDuplicates.length > 0) process.exitCode = 1;
      console.log(
        result.recorded
          ? `\n✓ Recorded ${result.backfillName}.\n`
          : '\nNot recorded: references remain.\n',
      );
    } catch (error) {
      console.error(
        `\n❌ Qualified-name backfill failed: ${redactDatabaseUrlsInText(
          error instanceof Error ? error.message : String(error),
        )}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
