/**
 * ai:compare and prompts:history Commands — compare two prompt versions,
 * models or tiers on one prompt key (#4782).
 *
 * Thin wrappers over core's `compareAiPromptRuns()` and
 * `listAiPromptTemplateHistory()`. Both reads are tenant-scoped: `--tenant
 * <id>` (`global` for tenant-less rows) or the explicit operator path
 * `--all-tenants`. `ai:compare --transcripts N` also prints the N
 * worst-labelled transcripts of each side side by side; that is a
 * transcript read through `listAiTranscripts()`, audited under `--actor`.
 *
 * Labels come from `recordAiUsageOutcome()`; nothing here asks a model to
 * judge. Rows of the prompt matching neither side are counted, not dropped.
 */

import type {
  AiPromptCompareSelector,
  AiPromptCompareSide,
  AiPromptComparison,
  AiPromptTemplateHistory,
  AiTranscriptWithUsage,
  AiUsageTenantScope,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  formatAiTranscript,
  openCliDatabase,
  transcriptActor,
} from './ai-transcript.js';
import { parseUsageTime } from './ai-usage.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/** Most `--transcripts` per side. */
const MAX_TRANSCRIPTS = 20;

/**
 * The tenant scope of a CLI usage read: `--tenant <id>` (`global` for
 * tenant-less rows) or `--all-tenants`. One is required; never both.
 */
export function usageScope(options: {
  tenant?: string;
  'all-tenants'?: boolean;
}): AiUsageTenantScope {
  const tenant = options.tenant?.trim();
  if (tenant && options['all-tenants']) {
    throw new Error('Pass --tenant or --all-tenants, not both');
  }
  if (tenant) return { tenantId: tenant === 'global' ? null : tenant };
  if (options['all-tenants']) return { allowCrossTenant: true };
  throw new Error(
    'AI usage is tenant data: pass --tenant <id> (global for tenant-less rows) or --all-tenants',
  );
}

/**
 * Parse a side selector: `hash:<templateHash>`, `model:<provider:model or
 * model>`, `tier:<tier>`. Only the first colon separates the kind.
 */
export function parseCompareSelector(
  value: string | undefined,
  flag: string,
): AiPromptCompareSelector {
  const text = value?.trim() ?? '';
  const colon = text.indexOf(':');
  const kind = colon > 0 ? text.slice(0, colon).toLowerCase() : '';
  const rest = colon > 0 ? text.slice(colon + 1).trim() : '';
  if (rest.length > 0) {
    if (kind === 'hash') return { templateHash: rest };
    if (kind === 'model') return { model: rest };
    if (kind === 'tier') return { tier: rest };
  }
  throw new Error(
    `Invalid ${flag} "${text}": use hash:<template hash>, model:<provider:model> or tier:<tier>`,
  );
}

/** Parse `--transcripts N` (0 to {@link MAX_TRANSCRIPTS}). */
export function parseTranscriptCount(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_TRANSCRIPTS) {
    throw new Error(
      `Invalid --transcripts "${value}": use a whole number from 0 to ${MAX_TRANSCRIPTS}`,
    );
  }
  return count;
}

function describeSelector(selector: AiPromptCompareSelector): string {
  if (selector.templateHash !== undefined)
    return `hash:${selector.templateHash}`;
  if (selector.model !== undefined) return `model:${selector.model}`;
  return `tier:${selector.tier}`;
}

function formatInt(value: number): string {
  return value.toLocaleString('en-US');
}

function formatRate(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  return value === null ? '-' : `${formatInt(value)}ms`;
}

function formatOutcomes(outcomes: Record<string, number>): string {
  const entries = Object.entries(outcomes).sort(([x], [y]) =>
    x.localeCompare(y),
  );
  return entries.length === 0
    ? '-'
    : entries.map(([label, count]) => `${label}=${count}`).join(' ');
}

function sideCells(side: AiPromptCompareSide): string[] {
  return [
    formatInt(side.calls),
    formatInt(side.blocked),
    formatInt(side.totalTokens),
    `$${side.estimatedCost.toFixed(4)}${
      side.uncostedCalls > 0
        ? ` (+${formatInt(side.uncostedCalls)} uncosted)`
        : ''
    }`,
    side.meanCost === null ? '-' : `$${side.meanCost.toFixed(6)}`,
    formatMs(side.latencyMs.p50),
    formatMs(side.latencyMs.p90),
    formatMs(side.latencyMs.p95),
    formatMs(side.latencyMs.p99),
    `${formatRate(side.fallbackRate)} (${formatInt(side.fallbackCalls)})`,
    `${formatRate(side.degradedRate)} (${formatInt(side.degradedCalls)})`,
    formatOutcomes(side.outcomes),
    side.meanScore === null
      ? '-'
      : `${side.meanScore.toFixed(3)} (n=${formatInt(side.scoredLabels)})`,
    formatInt(side.transcriptCount),
  ];
}

const METRICS = [
  'calls',
  'blocked',
  'tokens',
  'est. cost',
  'cost / call',
  'p50',
  'p90',
  'p95',
  'p99',
  'fallback',
  'degraded',
  'outcomes',
  'mean score',
  'transcripts',
];

/** Render a comparison as a metric-by-side table plus its accounting. */
export function formatAiPromptComparison(result: AiPromptComparison): string {
  const a = sideCells(result.a);
  const b = sideCells(result.b);
  const header = [
    'metric',
    `A ${describeSelector(result.a.selector)}`,
    `B ${describeSelector(result.b.selector)}`,
  ];
  const rows = METRICS.map((metric, index) => [
    metric,
    a[index] ?? '',
    b[index] ?? '',
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((cells) => cells[index]?.length ?? 0)),
  );
  const render = (cells: string[]) =>
    `  ${cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()}`;
  const rule = `  ${widths.map((width) => '-'.repeat(width)).join('  ')}`;
  const lines = [render(header), rule, ...rows.map(render), ''];
  lines.push(
    `  Rows of ${result.promptKey} in scope: ${formatInt(result.rows)} (neither side: ${formatInt(
      result.unmatched,
    )}, both sides: ${formatInt(result.inBoth)})`,
  );
  lines.push(
    `  Excluded from totals: ${
      result.excluded.externalAgent > 0
        ? `${formatInt(result.excluded.externalAgent)} external-agent measurement(s)`
        : 'none'
    }`,
  );
  lines.push(`  Cost basis: ${result.costBasis}`);
  return lines.join('\n');
}

/** Wrap one line to `width` columns. */
function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  for (let start = 0; start < line.length; start += width) {
    out.push(line.slice(start, start + width));
  }
  return out;
}

/**
 * Render two transcripts side by side in `width` terminal columns; either
 * may be missing (the shorter side ran out of labelled transcripts).
 */
export function formatSideBySide(
  left: AiTranscriptWithUsage | undefined,
  right: AiTranscriptWithUsage | undefined,
  width: number,
): string {
  const column = Math.max(20, Math.floor((width - 5) / 2));
  const lines = (transcript: AiTranscriptWithUsage | undefined) =>
    (transcript ? formatAiTranscript(transcript) : '(none)')
      .split('\n')
      .flatMap((line) => wrap(line, column));
  const l = lines(left);
  const r = lines(right);
  const out: string[] = [];
  for (let index = 0; index < Math.max(l.length, r.length); index++) {
    out.push(
      `${(l[index] ?? '').padEnd(column)} | ${r[index] ?? ''}`.trimEnd(),
    );
  }
  return out.join('\n');
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const hint =
    /prompt_key|_smrt_ai_usage_outcomes|_smrt_ai_runs|_smrt_ai_transcripts|call_id/.test(
      raw,
    )
      ? ' (system tables predate #4751/#4753/#4780: start the app once, or run `smrt db:migrate`, to upgrade them)'
      : '';
  return redactDatabaseUrlsInText(`${raw}${hint}`);
}

/** Parsed options for `ai:compare`. */
interface AiCompareOptions {
  prompt?: string;
  a?: string;
  b?: string;
  since?: string;
  until?: string;
  tenant?: string;
  'all-tenants'?: boolean;
  transcripts?: string;
  actor?: string;
  json?: boolean;
}

/**
 * Read the full transcripts behind the `count` worst-labelled references of
 * a side: one audited read per distinct call, in the row's own tenant, at
 * the read path's maximum page so newer transcripts of the same call never
 * push the chosen one out.
 */
async function readWorstTranscripts(
  db: DatabaseInterface,
  side: AiPromptCompareSide,
  count: number,
  actor: string,
): Promise<AiTranscriptWithUsage[]> {
  const { listAiTranscripts } = await import('@happyvertical/smrt-core');
  const refs = side.transcripts
    .filter((ref) => ref.labels.length > 0)
    .slice(0, count);
  const calls = new Map<string, { tenantId: string | null; callId: string }>();
  for (const ref of refs) {
    calls.set(JSON.stringify([ref.tenantId, ref.callId]), {
      tenantId: ref.tenantId,
      callId: ref.callId,
    });
  }
  const byId = new Map<string, AiTranscriptWithUsage>();
  for (const { tenantId, callId } of calls.values()) {
    const rows = await listAiTranscripts(db, {
      actor,
      reason: 'ai:compare --transcripts',
      tenantId,
      callId,
      limit: 500,
    });
    for (const row of rows) byId.set(row.id, row);
  }
  return refs.flatMap((ref) => {
    const row = byId.get(ref.id);
    return row ? [row] : [];
  });
}

export const aiCompareCommand: CLICommand = {
  name: 'ai:compare',
  description:
    'Compare two prompt versions, models or tiers on one prompt key (#4782); tenant-scoped',
  args: [],
  options: {
    prompt: { type: 'string', description: 'Prompt key both sides ran' },
    a: {
      type: 'string',
      description:
        'Side A: hash:<template hash>, model:<provider:model> or tier:<tier>',
    },
    b: {
      type: 'string',
      description:
        'Side B: hash:<template hash>, model:<provider:model> or tier:<tier>',
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
      description: 'Tenant id to compare within (global for tenant-less rows)',
    },
    'all-tenants': {
      type: 'boolean',
      description: 'Operator read across tenants',
      default: false,
    },
    transcripts: {
      type: 'string',
      description: `Also print the N worst-labelled transcripts of each side side by side (0-${MAX_TRANSCRIPTS}; audited)`,
    },
    actor: {
      type: 'string',
      description:
        'With --transcripts: who reads, for the audit event (default: cli:<os user>)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (_args: string[], options: AiCompareOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const promptKey = options.prompt?.trim();
      if (!promptKey) {
        throw new Error(
          'Usage: smrt ai:compare --prompt <key> --a hash:<h1> --b hash:<h2> --tenant <id>|--all-tenants',
        );
      }
      // Validated before any query: usage rows are tenant data.
      const scope = usageScope(options);
      const a = parseCompareSelector(options.a, '--a');
      const b = parseCompareSelector(options.b, '--b');
      const count = parseTranscriptCount(options.transcripts);
      const since = parseUsageTime(options.since, '--since');
      const until = parseUsageTime(options.until, '--until');

      db = await openCliDatabase();
      const { compareAiPromptRuns } = await import('@happyvertical/smrt-core');
      const result = await compareAiPromptRuns(db, {
        ...scope,
        promptKey,
        a,
        b,
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
      });
      let worst:
        | { a: AiTranscriptWithUsage[]; b: AiTranscriptWithUsage[] }
        | undefined;
      if (count > 0) {
        const actor = transcriptActor(options.actor);
        worst = {
          a: await readWorstTranscripts(db, result.a, count, actor),
          b: await readWorstTranscripts(db, result.b, count, actor),
        };
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            { ...result, ...(worst ? { worstTranscripts: worst } : {}) },
            null,
            2,
          ),
        );
        return;
      }

      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      console.log(`\n📊 AI compare: ${promptKey}\n`);
      if (config.database?.url) {
        console.log(
          `Database: ${formatDatabaseDisplayUrl(config.database.type || 'sqlite', config.database.url)}`,
        );
      }
      console.log(
        `Window:   ${since ? since.toISOString() : 'all time'} → ${
          until ? until.toISOString() : 'now'
        }  (${scope.allowCrossTenant ? 'all tenants' : `tenant ${scope.tenantId ?? 'global'}`})\n`,
      );
      console.log(formatAiPromptComparison(result));
      if (worst) {
        const width = Math.max(80, process.stdout.columns ?? 160);
        console.log(
          `\nWorst-labelled transcripts (A | B, up to ${count} each)\n`,
        );
        const pairs = Math.max(worst.a.length, worst.b.length);
        if (pairs === 0) {
          console.log('  (no labelled transcripts on either side)');
        }
        for (let index = 0; index < pairs; index++) {
          console.log(
            `--- #${index + 1} ${'-'.repeat(Math.max(0, width - 10))}`,
          );
          console.log(formatSideBySide(worst.a[index], worst.b[index], width));
          console.log();
        }
      }
      console.log();
    } catch (error) {
      const message = errorMessage(error);
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(`\n❌ AI compare failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

/** Render a template history as a table. */
export function formatAiPromptTemplateHistory(
  history: AiPromptTemplateHistory,
): string {
  if (history.hashes.length === 0) {
    return `  (no calls of ${history.promptKey} in this window)`;
  }
  const header = [
    'template hash',
    'calls',
    'blocked',
    'first seen',
    'last seen',
    'layers',
    'models',
  ];
  const rows = history.hashes.map((entry) => [
    entry.templateHash ?? '(unrecorded)',
    formatInt(entry.calls),
    formatInt(entry.blocked),
    entry.firstSeen.toISOString(),
    entry.lastSeen.toISOString(),
    entry.layers.join(',') || '-',
    entry.models.join(','),
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((cells) => cells[index]?.length ?? 0)),
  );
  const render = (cells: string[]) =>
    `  ${cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()}`;
  const lines = [
    render(header),
    `  ${widths.map((width) => '-'.repeat(width)).join('  ')}`,
    ...rows.map(render),
  ];
  if (history.excluded.externalAgent > 0) {
    lines.push(
      '',
      `  Excluded: ${formatInt(history.excluded.externalAgent)} external-agent measurement(s)`,
    );
  }
  return lines.join('\n');
}

/** Parsed options for `prompts:history`. */
interface PromptsHistoryOptions {
  since?: string;
  until?: string;
  tenant?: string;
  'all-tenants'?: boolean;
  json?: boolean;
}

export const promptsHistoryCommand: CLICommand = {
  name: 'prompts:history',
  description:
    'List the template hashes a prompt key ran with, first/last seen and calls (#4782); tenant-scoped',
  args: ['<key>'],
  options: {
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
      description: 'Tenant id (global for tenant-less rows)',
    },
    'all-tenants': {
      type: 'boolean',
      description: 'Operator read across tenants',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (args: string[], options: PromptsHistoryOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const promptKey = args[0]?.trim();
      if (!promptKey) {
        throw new Error(
          'Usage: smrt prompts:history <key> --tenant <id>|--all-tenants',
        );
      }
      const scope = usageScope(options);
      const since = parseUsageTime(options.since, '--since');
      const until = parseUsageTime(options.until, '--until');
      db = await openCliDatabase();
      const { listAiPromptTemplateHistory } = await import(
        '@happyvertical/smrt-core'
      );
      const history = await listAiPromptTemplateHistory(db, {
        ...scope,
        promptKey,
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(history, null, 2));
        return;
      }
      console.log(`\n🧾 Template history: ${promptKey}\n`);
      console.log(
        `Window:   ${since ? since.toISOString() : 'all time'} → ${
          until ? until.toISOString() : 'now'
        }  (${scope.allowCrossTenant ? 'all tenants' : `tenant ${scope.tenantId ?? 'global'}`})\n`,
      );
      console.log(formatAiPromptTemplateHistory(history));
      console.log(
        `\n  Compare two: smrt ai:compare --prompt ${promptKey} --a hash:<h1> --b hash:<h2>\n`,
      );
    } catch (error) {
      const message = errorMessage(error);
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(`\n❌ Prompt history failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

export default aiCompareCommand;
