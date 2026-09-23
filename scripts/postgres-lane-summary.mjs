#!/usr/bin/env node
/**
 * Per-package result table for the PostgreSQL lane (#2659).
 *
 * The lane runs `turbo run test:postgres --continue --summarize`, so one
 * package's failure never hides another's result; this reads that run summary
 * and renders every package's outcome for the job summary. It reports only
 * task identity, exit code and duration — never the summary's environment
 * section, which carries hashes of the database URLs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function summarizeRun(summary, task = 'test:postgres') {
  return (summary.tasks ?? [])
    .filter((entry) => entry.task === task)
    .map((entry) => {
      const execution = entry.execution ?? {};
      const exitCode =
        typeof execution.exitCode === 'number' ? execution.exitCode : null;
      const seconds =
        typeof execution.startTime === 'number' &&
        typeof execution.endTime === 'number'
          ? Math.round((execution.endTime - execution.startTime) / 1000)
          : null;
      return {
        package: entry.package,
        result:
          exitCode === 0 ? 'passed' : exitCode === null ? 'not run' : 'failed',
        exitCode,
        seconds,
      };
    })
    .sort((left, right) => left.package.localeCompare(right.package));
}

export function renderMarkdown(rows) {
  const failed = rows.filter((row) => row.result !== 'passed').length;
  const lines = [
    '## PostgreSQL lane',
    '',
    `${rows.length - failed}/${rows.length} package suites passed.`,
    '',
    '| Package | Result | Exit | Seconds |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| \`${row.package}\` | ${row.result} | ${row.exitCode ?? '—'} | ${row.seconds ?? '—'} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export function latestSummary(directory = join('.turbo', 'runs')) {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No Turbo run summary in ${directory}`);
  }
  return JSON.parse(readFileSync(join(directory, files.at(-1)), 'utf8'));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const rows = summarizeRun(latestSummary(process.argv[2]));
  if (rows.length === 0) {
    console.error('The Turbo run summary contains no test:postgres tasks.');
    process.exit(1);
  }
  process.stdout.write(renderMarkdown(rows));
}
