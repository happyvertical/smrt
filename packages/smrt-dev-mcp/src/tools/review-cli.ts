/**
 * `smrt-dev-mcp review` — runs `review-smrt-project` from a shell so a CI job
 * (the reusable consumer-knowledge-review workflow, #4690) can call it without
 * speaking MCP. Advisory: the exit code is 0 unless `--fail-on-findings` is set
 * and a duplicate-detection finding exists. It exits 2, never 0, when no
 * intent index can be found.
 */

import { reviewSmrtProject } from './review-smrt-project.js';

export interface ReviewCliArgs {
  directory?: string;
  intentIndexPath?: string;
  format: 'json' | 'summary';
  failOnFindings: boolean;
}

interface ReviewFinding {
  severity: string;
  area: string;
  code: string;
  title: string;
  message?: string;
  file?: string;
  intentPage?: string;
  componentPages?: string[];
  recommendation: string;
}

interface ReviewResult {
  projectPath: string;
  findings: ReviewFinding[];
  duplicateDetection?: { indexPath: string | null; notes: string[] };
}

export function parseReviewCliArgs(argv: readonly string[]): ReviewCliArgs {
  const result: ReviewCliArgs = { format: 'json', failOnFindings: false };
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--'))
      throw new Error(`${flag} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--directory') {
      result.directory = value(index, arg);
      index += 1;
    } else if (arg === '--intent-index') {
      result.intentIndexPath = value(index, arg);
      index += 1;
    } else if (arg === '--format') {
      const format = value(index, arg);
      if (format !== 'json' && format !== 'summary') {
        throw new Error('--format must be "json" or "summary"');
      }
      result.format = format;
      index += 1;
    } else if (arg === '--fail-on-findings') {
      result.failOnFindings = true;
    } else {
      throw new Error(`Unknown review option: ${arg}`);
    }
  }
  return result;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Markdown suitable for `$GITHUB_STEP_SUMMARY`. */
export function renderReviewSummary(result: ReviewResult): string {
  const duplicates = result.findings.filter(
    (finding) => finding.area === 'duplicate-detection',
  );
  const lines = ['## smrt knowledge review', ''];
  const detection = result.duplicateDetection;
  if (!detection?.indexPath) {
    lines.push(
      'Intent index not found; duplicate detection did not run.',
      ...(detection?.notes ?? []).map((note) => `- ${escapeCell(note)}`),
    );
    return `${lines.join('\n')}\n`;
  }
  if (duplicates.length === 0) {
    lines.push('No hand-rolled equivalents of smrt packages found.');
  } else {
    lines.push(
      `${duplicates.length} advisory finding(s). Nothing here is blocking.`,
      '',
      '| Location | Finding | Intent page | Component pages |',
      '| --- | --- | --- | --- |',
      ...duplicates.map(
        (finding) =>
          `| \`${escapeCell(finding.file ?? '')}\` | ${escapeCell(finding.title)} | \`${finding.intentPage ?? ''}\` | ${(finding.componentPages ?? []).map((page) => `\`${page}\``).join(', ')} |`,
      ),
    );
  }
  const notes = detection.notes;
  if (notes.length > 0) {
    lines.push('', 'Notes:', ...notes.map((note) => `- ${escapeCell(note)}`));
  }
  return `${lines.join('\n')}\n`;
}

export async function runReviewCli(
  argv: readonly string[],
  options: { packageRoot?: string } = {},
): Promise<number> {
  const args = parseReviewCliArgs(argv);
  const raw = await reviewSmrtProject({
    directory: args.directory,
    intentIndexPath: args.intentIndexPath,
    packageRoot: options.packageRoot,
  });
  const result = JSON.parse(raw) as ReviewResult;
  process.stdout.write(
    args.format === 'summary' ? renderReviewSummary(result) : `${raw}\n`,
  );
  // Never a green no-op: a run that could not load its index did not review.
  if (!result.duplicateDetection?.indexPath) {
    process.stderr.write(
      `smrt-dev-mcp review: no intent index found; duplicate detection did not run. ${(result.duplicateDetection?.notes ?? []).join(' ')}\n`,
    );
    return 2;
  }
  const hasFindings = result.findings.some(
    (finding) => finding.area === 'duplicate-detection',
  );
  return args.failOnFindings && hasFindings ? 1 : 0;
}
