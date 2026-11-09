/**
 * ai:transcript Command — read one stored AI call transcript (#4780), and the
 * `ai:usage --with-transcripts` listing of the worst-labelled calls.
 *
 * Transcripts exist only when the app enables `inference.transcripts`. Reads
 * go through core's `listAiTranscripts()`: tenant-scoped (`--tenant`, or the
 * explicit operator path `--all-tenants`), and every read writes an audit
 * event naming the operator (`--actor`, default `cli:<os user>`).
 */

import { userInfo } from 'node:os';
import type {
  AiTranscriptListOptions,
  AiTranscriptWithUsage,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/** Parsed options for `ai:transcript`. */
interface AiTranscriptOptions {
  tenant?: string;
  'all-tenants'?: boolean;
  actor?: string;
  reason?: string;
  json?: boolean;
}

/** The operator a CLI read is audited under. */
export function transcriptActor(explicit: string | undefined): string {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  let user = 'unknown';
  try {
    user = userInfo().username || user;
  } catch {
    // No passwd entry (containers): the audit still names the CLI.
  }
  return `cli:${user}`;
}

/**
 * The tenant scope of a CLI read: `--tenant <id>` (`--tenant global` for
 * tenant-less rows) or `--all-tenants`. One is required; never both.
 */
export function transcriptScope(options: {
  tenant?: string;
  'all-tenants'?: boolean;
}): Pick<AiTranscriptListOptions, 'tenantId' | 'allowCrossTenant'> {
  const tenant = options.tenant?.trim();
  if (tenant && options['all-tenants']) {
    throw new Error('Pass --tenant or --all-tenants, not both');
  }
  if (tenant) return { tenantId: tenant === 'global' ? null : tenant };
  if (options['all-tenants']) return { allowCrossTenant: true };
  throw new Error(
    'Transcripts are tenant content: pass --tenant <id> (global for tenant-less rows) or --all-tenants',
  );
}

function asMessages(part: unknown): Array<Record<string, unknown>> {
  const messages = (part as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages)
    ? (messages as Array<Record<string, unknown>>)
    : [];
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function renderTruncated(part: unknown): string | undefined {
  const record = part as {
    truncated?: unknown;
    originalBytes?: unknown;
    head?: unknown;
    tail?: unknown;
  } | null;
  if (record?.truncated !== true) return undefined;
  return `[truncated from ${String(record.originalBytes)} bytes]\n${String(record.head)}\n…\n${String(record.tail)}`;
}

/** Render one transcript for a terminal. */
export function formatAiTranscript(transcript: AiTranscriptWithUsage): string {
  const lines: string[] = [];
  lines.push(`Call:      ${transcript.callId}`);
  lines.push(`Created:   ${transcript.createdAt.toISOString()}`);
  lines.push(`Tenant:    ${transcript.tenantId ?? '(global)'}`);
  lines.push(
    `Model:     ${transcript.provider ?? '?'}:${transcript.model ?? '?'} (${transcript.operation})`,
  );
  if (transcript.promptKey) {
    lines.push(
      `Prompt:    ${transcript.promptKey}${transcript.templateHash ? ` @ ${transcript.templateHash}` : ''}`,
    );
  }
  if (transcript.className) lines.push(`Class:     ${transcript.className}`);
  if (transcript.runId) lines.push(`Run:       ${transcript.runId}`);
  lines.push(
    `Stored:    ${transcript.bytes} bytes${transcript.truncated ? ' (truncated)' : ''}`,
  );
  const tokens = transcript.usage.reduce(
    (sum, row) => sum + (row.totalTokens ?? 0),
    0,
  );
  lines.push(`Usage:     ${transcript.usage.length} row(s), ${tokens} tokens`);
  lines.push(
    `Outcomes:  ${
      transcript.outcomes.length === 0
        ? '-'
        : transcript.outcomes
            .map(
              (outcome) =>
                `${outcome.label}${outcome.score === null ? '' : ` (${outcome.score})`} by ${outcome.actor}`,
            )
            .join('; ')
    }`,
  );
  for (const [title, part] of [
    ['Request', transcript.request],
    ['Response', transcript.response],
  ] as const) {
    lines.push('', `--- ${title} ---`);
    const truncated = renderTruncated(part);
    if (truncated) {
      lines.push(truncated);
      continue;
    }
    for (const message of asMessages(part)) {
      lines.push(
        `[${String(message.role)}${message.name ? ` ${String(message.name)}` : ''}]`,
        renderContent(message.content),
      );
    }
  }
  if (transcript.toolEvents !== null) {
    lines.push('', '--- Tool events ---');
    const truncated = renderTruncated(transcript.toolEvents);
    lines.push(truncated ?? renderContent(transcript.toolEvents));
  }
  return lines.join('\n');
}

/** Lowest score of a transcript's labels; `null` when none is scored. */
function worstScore(transcript: AiTranscriptWithUsage): number | null {
  const scores = transcript.outcomes
    .map((outcome) => outcome.score)
    .filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
}

/**
 * Order labelled transcripts worst first: lowest score, then unscored
 * labels, newest first within each; unlabelled ones are dropped.
 */
export function worstLabelledTranscripts(
  transcripts: AiTranscriptWithUsage[],
  limit: number,
): AiTranscriptWithUsage[] {
  return transcripts
    .filter((transcript) => transcript.outcomes.length > 0)
    .sort((a, b) => {
      const scoreA = worstScore(a);
      const scoreB = worstScore(b);
      if (scoreA !== scoreB) {
        if (scoreA === null) return 1;
        if (scoreB === null) return -1;
        return scoreA - scoreB;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .slice(0, limit);
}

/** Render the `--with-transcripts` listing. */
export function formatWorstLabelledTranscripts(
  transcripts: AiTranscriptWithUsage[],
): string {
  if (transcripts.length === 0) {
    return '  (no labelled transcripts in this window)';
  }
  const rows = transcripts.map((transcript) => [
    transcript.callId,
    transcript.promptKey ?? '(unattributed)',
    `${transcript.provider ?? '?'}:${transcript.model ?? '?'}`,
    worstScore(transcript)?.toString() ?? '-',
    [...new Set(transcript.outcomes.map((outcome) => outcome.label))].join(','),
    transcript.createdAt.toISOString(),
  ]);
  const header = ['call id', 'prompt', 'model', 'worst', 'labels', 'created'];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (cells: string[]) =>
    `  ${cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()}`;
  return [
    render(header),
    `  ${widths.map((width) => '-'.repeat(width)).join('  ')}`,
    ...rows.map(render),
  ].join('\n');
}

/** Open the CLI-configured database (same source as `ai:usage`). */
export async function openCliDatabase(): Promise<DatabaseInterface> {
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');
  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  if (!config.database?.url) {
    throw new Error(
      'Database not configured. Set database.url in smrt.config.ts.',
    );
  }
  const { getDatabase } = await import('@happyvertical/sql');
  return getDatabase({
    type: config.database.type || 'sqlite',
    url: config.database.url,
  });
}

/** Error text for a transcript command, with the upgrade hint when relevant. */
export function transcriptErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const hint = /_smrt_ai_transcripts|call_id/.test(raw)
    ? ' (system tables predate #4780: start the app once, or run `smrt db:migrate`, to upgrade them)'
    : '';
  return redactDatabaseUrlsInText(`${raw}${hint}`);
}

export const aiTranscriptCommand: CLICommand = {
  name: 'ai:transcript',
  description:
    'Print a stored AI call transcript by call id (#4780); reads are tenant-scoped and audited',
  args: ['<callId>'],
  options: {
    tenant: {
      type: 'string',
      description:
        'Tenant id whose transcript to read (global for tenant-less rows)',
    },
    'all-tenants': {
      type: 'boolean',
      description: 'Operator read across tenants (audited)',
      default: false,
    },
    actor: {
      type: 'string',
      description: 'Who reads, for the audit event (default: cli:<os user>)',
    },
    reason: {
      type: 'string',
      description: 'Why, for the audit event',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (args: string[], options: AiTranscriptOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const callId = args[0]?.trim();
      if (!callId) throw new Error('Usage: smrt ai:transcript <callId>');
      const scope = transcriptScope(options);
      db = await openCliDatabase();
      const { listAiTranscripts } = await import('@happyvertical/smrt-core');
      const transcripts = await listAiTranscripts(db, {
        ...scope,
        callId,
        actor: transcriptActor(options.actor),
        ...(options.reason ? { reason: options.reason } : {}),
        limit: 20,
      });
      if (options.json) {
        console.log(JSON.stringify(transcripts, null, 2));
        if (transcripts.length === 0) process.exitCode = 1;
        return;
      }
      if (transcripts.length === 0) {
        console.error(
          `\nNo transcript for call ${callId} in this scope (not sampled, pruned, or another tenant).\n`,
        );
        process.exitCode = 1;
        return;
      }
      for (const transcript of transcripts) {
        console.log(`\n${formatAiTranscript(transcript)}\n`);
      }
    } catch (error) {
      const message = transcriptErrorMessage(error);
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(`\n❌ AI transcript read failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

export default aiTranscriptCommand;
