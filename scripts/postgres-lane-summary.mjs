#!/usr/bin/env node
/**
 * Per-package result table for the PostgreSQL lane (#2659).
 *
 * The lane runs `turbo run <package>#<task>... --continue --summarize`, so one
 * package's failure never hides another's result; this reads that run summary
 * and renders every package's outcome for the job summary. It reports only
 * task identity, exit code and duration — never the summary's environment
 * section, which carries hashes of the database URLs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SPLIT_POSTGRES_UNITS } from './test-shard-balance.mjs';

/**
 * The lane's task names: the plain `test:postgres`, and the two halves of a
 * package in SPLIT_POSTGRES_UNITS (core, #5649).
 */
export const LANE_TASKS = [
  'test:postgres',
  ...new Set(Object.values(SPLIT_POSTGRES_UNITS).flat()),
];

export function summarizeRun(summary, tasks = LANE_TASKS) {
  const accepted = new Set([tasks].flat());
  return (summary.tasks ?? [])
    .filter((entry) => accepted.has(entry.task))
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
        task: entry.task,
        result:
          exitCode === 0 ? 'passed' : exitCode === null ? 'not run' : 'failed',
        exitCode,
        seconds,
      };
    })
    .sort(
      (left, right) =>
        left.package.localeCompare(right.package) ||
        left.task.localeCompare(right.task),
    );
}

export function renderMarkdown(rows) {
  const failed = rows.filter((row) => row.result !== 'passed').length;
  const lines = [
    '## PostgreSQL lane',
    '',
    `${rows.length - failed}/${rows.length} suite units passed.`,
    '',
    '| Package | Task | Result | Exit | Seconds |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| \`${row.package}\` | \`${row.task}\` | ${row.result} | ${row.exitCode ?? '—'} | ${row.seconds ?? '—'} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/** Every run summary in the directory, merged: a step may run turbo more than once. */
export function allSummaries(directory = join('.turbo', 'runs')) {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No Turbo run summary in ${directory}`);
  }
  return {
    tasks: files.flatMap(
      (file) =>
        JSON.parse(readFileSync(join(directory, file), 'utf8')).tasks ?? [],
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const rows = summarizeRun(allSummaries(process.argv[2]));
  if (rows.length === 0) {
    console.error('The Turbo run summary contains no PostgreSQL lane tasks.');
    process.exit(1);
  }
  process.stdout.write(renderMarkdown(rows));
}
