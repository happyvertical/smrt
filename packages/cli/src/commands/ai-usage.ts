/**
 * ai:usage Command — prompt-run observability report (#4751).
 *
 * Groups `_smrt_ai_usage` by prompt, model, tier, class, tenant, fusion or source
 * through core's `reportAiUsage()`: calls, tokens, estimated cost (with its
 * basis stated and uncosted calls counted beside the total), hosted-gate
 * blocks counted beside calls (#4760), p50 duration,
 * recorded substitutions and outcome labels per bucket.
 *
 * A filter selects what is totalled, never what is accounted for: calls
 * without a prompt key print as unattributed, and rows a `--tenant` filter
 * leaves out are counted under "excluded" rather than vanishing.
 *
 * `--by fusion` also totals runs from `_smrt_ai_runs` (#4753) through
 * `reportAiRuns()`: runs per fusion with ok / degraded / failed, seats,
 * degraded seats and p50 run duration (JSON: a `runs` member).
 *
 * `--with-transcripts` (#4780) also lists the worst-labelled calls that have
 * a stored transcript (optionally one `--prompt`), with their call ids for
 * `smrt ai:transcript <callId>`. That is a transcript read: it needs
 * `--tenant` or `--all-tenants` and writes an audit event (JSON:
 * `transcripts`).
 */

import type {
  AiRunReport,
  AiRunReportStats,
  AiUsageReport,
  AiUsageReportDimension,
  AiUsageReportStats,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  formatWorstLabelledTranscripts,
  transcriptActor,
  transcriptScope,
  worstLabelledTranscripts,
} from './ai-transcript.js';
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
  'with-transcripts'?: boolean;
  'all-tenants'?: boolean;
  prompt?: string;
  actor?: string;
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
  'template',
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
): [string, string, string, string, string, string, string, string] {
  return [
    label,
    formatInt(stats.calls),
    formatInt(stats.blocked),
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
    'blocked',
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

function runRow(label: string, stats: AiRunReportStats): string[] {
  return [
    label,
    formatInt(stats.runs),
    formatInt(stats.ok),
    formatInt(stats.degraded),
    formatInt(stats.failed),
    formatInt(stats.seats),
    formatInt(stats.degradedSeats),
    stats.p50DurationMs === null ? '-' : `${formatInt(stats.p50DurationMs)}ms`,
  ];
}

/** Render the `_smrt_ai_runs` totals behind `--by fusion` (#4753). */
export function formatAiRunReport(report: AiRunReport): string {
  const header = [
    'fusion',
    'runs',
    'ok',
    'degraded',
    'failed',
    'seats',
    'degr. seats',
    'p50',
  ];
  const rows = report.buckets.map((bucket) => runRow(bucket.fusionKey, bucket));
  const totalRow = runRow('total', report.totals);
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
        index === 0
          ? cell.padEnd(widths[index] ?? 0)
          : cell.padStart(widths[index] ?? 0),
      )
      .join('  ')
      .trimEnd()}`;
  const rule = `  ${widths.map((width) => '-'.repeat(width)).join('  ')}`;
  const lines = [render(header), rule, ...rows.map(render)];
  if (rows.length === 0)
    lines.push('  (no fusion runs recorded in this window)');
  lines.push(rule, render(totalRow));
  if (report.excluded.otherTenants > 0) {
    lines.push(
      '',
      `  Excluded from totals: ${formatInt(report.excluded.otherTenants)} run(s) of other tenants`,
    );
  }
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
        'Comma-separated grouping: prompt, model, tier, class, tenant, fusion, source, template (default: prompt); fusion also totals runs',
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
    'with-transcripts': {
      type: 'boolean',
      description:
        'Also list the worst-labelled calls with stored transcripts and their call ids (#4780; needs --tenant or --all-tenants; audited)',
      default: false,
    },
    'all-tenants': {
      type: 'boolean',
      description: 'With --with-transcripts: operator read across tenants',
      default: false,
    },
    prompt: {
      type: 'string',
      description: 'With --with-transcripts: only this prompt key',
    },
    actor: {
      type: 'string',
      description:
        'With --with-transcripts: who reads, for the audit event (default: cli:<os user>)',
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
      // Validated before any query: a transcript read is tenant content.
      const transcriptRead = options['with-transcripts']
        ? transcriptScope({
            ...(options.tenant ? { tenant: options.tenant } : {}),
            ...(options['all-tenants'] ? { 'all-tenants': true } : {}),
          })
        : undefined;
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

      const { listAiTranscripts, reportAiRuns, reportAiUsage } = await import(
        '@happyvertical/smrt-core'
      );
      const filters = {
        since,
        until,
        ...(options.tenant ? { tenantId: options.tenant } : {}),
      };
      const report = await reportAiUsage(db, { by, ...filters });
      const runs = by.includes('fusion')
        ? await reportAiRuns(db, filters)
        : undefined;
      const transcripts = transcriptRead
        ? worstLabelledTranscripts(
            await listAiTranscripts(db, {
              ...transcriptRead,
              actor: transcriptActor(options.actor),
              reason: 'ai:usage --with-transcripts',
              labelled: true,
              ...(options.prompt ? { promptKey: options.prompt } : {}),
              ...(since ? { since } : {}),
              ...(until ? { until } : {}),
              limit: 500,
            }),
            20,
          )
        : undefined;

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ...report,
              ...(runs ? { runs } : {}),
              ...(transcripts ? { transcripts } : {}),
            },
            null,
            2,
          ),
        );
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
      if (runs) {
        console.log('\nFusion runs (_smrt_ai_runs)\n');
        console.log(formatAiRunReport(runs));
      }
      if (transcripts) {
        console.log(
          `\nWorst-labelled calls with transcripts${options.prompt ? ` (prompt ${options.prompt})` : ''}\n`,
        );
        console.log(formatWorstLabelledTranscripts(transcripts));
        console.log('\n  Read one: smrt ai:transcript <call id> --tenant <id>');
      }
      console.log();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const hint =
        /prompt_key|_smrt_ai_usage_outcomes|_smrt_ai_runs|_smrt_ai_transcripts|call_id/.test(
          raw,
        )
          ? ' (system tables predate #4751/#4753/#4780: start the app once, or run `smrt db:migrate`, to upgrade them)'
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
