/**
 * ai:usage Command — prompt-run observability report (#4751).
 *
 * Groups `_smrt_ai_usage` by prompt, model, tier, class, tenant, fusion or source
 * through core's `reportAiUsage()`: calls, tokens, estimated cost (with its
 * basis stated and uncosted calls counted beside the total), p50 duration,
 * recorded substitutions and outcome labels per bucket.
 *
 * A filter selects what is totalled, never what is accounted for: calls
 * without a prompt key print as unattributed, and rows a `--tenant` filter
 * leaves out are counted under "excluded" rather than vanishing.
 */

import type {
  AiUsageReport,
  AiUsageReportDimension,
  AiUsageReportStats,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/** Parsed CLI options for the `ai:usage` command. */
interface AiUsageOptions {
  by?: string;
  since?: string;
  until?: string;
  tenant?: string;
  json?: boolean;
}

/** Kept in step with core's `AI_USAGE_REPORT_DIMENSIONS`. */
const DIMENSIONS: readonly AiUsageReportDimension[] = [
  'prompt',
  'model',
  'tier',
  'class',
  'tenant',
  'fusion',
  'source',
];

/** Rendered for a dimension a row did not carry. */
const UNATTRIBUTED = '(unattributed)';

/** Parse `--by prompt,model` into dimensions, refusing unknown names. */
export function parseUsageDimensions(
  value: string | undefined,
): AiUsageReportDimension[] {
  const names = (value ?? 'prompt')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const unknown = names.filter(
    (name) => !DIMENSIONS.includes(name as AiUsageReportDimension),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown --by dimension: ${unknown.join(', ')} (expected ${DIMENSIONS.join(', ')})`,
    );
  }
  const dimensions = [...new Set(names)] as AiUsageReportDimension[];
  return dimensions.length > 0 ? dimensions : ['prompt'];
}

const RELATIVE = /^(\d+)\s*(m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse `--since`/`--until`: a relative window (`30m`, `24h`, `7d`, `2w`,
 * counted back from `now`) or anything `Date` parses (ISO 8601).
 */
export function parseUsageTime(
  value: string | undefined,
  flag: string,
  now: Date = new Date(),
): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const relative = RELATIVE.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[(relative[2] ?? 'd').toLowerCase()] ?? UNIT_MS.d;
    return new Date(now.getTime() - amount * (unit ?? 0));
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid ${flag} "${value}": use an ISO date or a window like 24h, 7d, 2w`,
    );
  }
  return date;
}

function formatInt(value: number): string {
  return value.toLocaleString('en-US');
}

function formatCost(stats: AiUsageReportStats): string {
  const cost = `$${stats.estimatedCost.toFixed(4)}`;
  return stats.uncostedCalls > 0
    ? `${cost} (+${formatInt(stats.uncostedCalls)} uncosted)`
    : cost;
}

function formatOutcomes(outcomes: Record<string, number>): string {
  const entries = Object.entries(outcomes).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return entries.length === 0
    ? '-'
    : entries.map(([label, count]) => `${label}=${count}`).join(' ');
}

function row(
  label: string,
  stats: AiUsageReportStats,
): [string, string, string, string, string, string, string] {
  return [
    label,
    formatInt(stats.calls),
    formatInt(stats.totalTokens),
    formatCost(stats),
    stats.p50DurationMs === null ? '-' : `${formatInt(stats.p50DurationMs)}ms`,
    formatInt(stats.substitutions),
    formatOutcomes(stats.outcomes),
  ];
}

/** Render a report as an operator-readable table. */
export function formatAiUsageReport(report: AiUsageReport): string {
  const header = [
    report.by.join(' / '),
    'calls',
    'tokens',
    'est. cost',
    'p50',
    'subst.',
    'outcomes',
  ];
  const rows = report.buckets.map((bucket) =>
    row(
      report.by
        .map((dimension) => bucket.key[dimension] ?? UNATTRIBUTED)
        .join(' / '),
      bucket,
    ),
  );
  const totalRow = row('total', report.totals);
  const widths = header.map((title, index) =>
    Math.max(
      title.length,
      totalRow[index]?.length ?? 0,
      ...rows.map((cells) => cells[index]?.length ?? 0),
    ),
  );
  const render = (cells: readonly string[]) =>
    `  ${cells
      .map((cell, index) =>
        index === 0 || index === cells.length - 1
          ? cell.padEnd(widths[index] ?? 0)
          : cell.padStart(widths[index] ?? 0),
      )
      .join('  ')
      .trimEnd()}`;

  const lines: string[] = [render(header)];
  lines.push(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`);
  for (const cells of rows) lines.push(render(cells));
  if (rows.length === 0) lines.push('  (no AI usage recorded in this window)');
  lines.push(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`);
  lines.push(render(totalRow));
  lines.push('');
  lines.push(
    `  Unattributed (no prompt key): ${formatInt(report.unattributedCalls)} call(s)`,
  );
  const excluded = [
    report.excluded.otherTenants > 0
      ? `${formatInt(report.excluded.otherTenants)} of other tenants`
      : null,
    report.excluded.externalAgent > 0
      ? `${formatInt(report.excluded.externalAgent)} external-agent measurement(s)`
      : null,
  ].filter((entry): entry is string => entry !== null);
  lines.push(
    `  Excluded from totals: ${excluded.length > 0 ? excluded.join(', ') : 'none'}`,
  );
  lines.push(`  Cost basis: ${report.costBasis}`);
  return lines.join('\n');
}

export const aiUsageCommand: CLICommand = {
  name: 'ai:usage',
  description:
    'Report AI usage by prompt, model, tier, class, tenant, fusion or source (#4751, #4756)',
  args: [],
  options: {
    by: {
      type: 'string',
      description:
        'Comma-separated grouping: prompt, model, tier, class, tenant, fusion, source (default: prompt)',
    },
    since: {
      type: 'string',
      description: 'Window start: ISO date or relative (24h, 7d, 2w)',
    },
    until: {
      type: 'string',
      description: 'Window end: ISO date or relative (24h, 7d, 2w)',
    },
    tenant: {
      type: 'string',
      description:
        'Total only this tenant id; other tenants are counted as excluded',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (_args: string[], options: AiUsageOptions) => {
    let db: DatabaseInterface | undefined;

    try {
      const by = parseUsageDimensions(options.by);
      const since = parseUsageTime(options.since, '--since');
      const until = parseUsageTime(options.until, '--until');

      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      if (!config.database?.url) {
        throw new Error(
          'Database not configured. Set database.url in smrt.config.ts.',
        );
      }

      const dbUrl = config.database.url;
      const dbType = config.database.type || 'sqlite';
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });

      const { reportAiUsage } = await import('@happyvertical/smrt-core');
      const report = await reportAiUsage(db, {
        by,
        since,
        until,
        ...(options.tenant ? { tenantId: options.tenant } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log('\n📊 AI usage\n');
      console.log(`Database: ${formatDatabaseDisplayUrl(dbType, dbUrl)}`);
      console.log(
        `Window:   ${since ? since.toISOString() : 'all time'} → ${
          until ? until.toISOString() : 'now'
        }${options.tenant ? `  (tenant ${options.tenant})` : ''}\n`,
      );
      console.log(formatAiUsageReport(report));
      console.log();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const hint = /prompt_key|_smrt_ai_usage_outcomes/.test(raw)
        ? ' (system tables predate #4751: start the app once, or run `smrt db:migrate`, to upgrade them)'
        : '';
      const message = redactDatabaseUrlsInText(`${raw}${hint}`);
      if (options.json) {
        console.log(JSON.stringify({ error: message }));
      } else {
        console.error(`\n❌ AI usage report failed: ${message}\n`);
      }
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

export default aiUsageCommand;
