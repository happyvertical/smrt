#!/usr/bin/env node
/**
 * Measure per-unit test seconds from `test-packages` job logs, to refresh
 * TEST_SECONDS in test-shard-balance.mjs (#5706).
 *
 * Turbo's GitHub log mode prints each task as one `##[group]<package>:<task>`
 * block when the task finishes, so the block's timestamp is the task's finish
 * time even under `--concurrency=2`, where the live output of two tasks would
 * interleave. A block's start is the first Vitest `Start at HH:MM:SS` line
 * inside it (the runner clock is UTC, the log timestamps are UTC). Wall time is
 * finish minus start: it includes time spent next to the sibling task on the
 * other lane, which is what the balancer's weights mean. It leaves out the few
 * seconds of manifest generation before Vitest starts, and it is rounded to
 * the second. A block with no `Start at` line (a build, a generate task) is
 * skipped, and so is a `cache hit, replaying logs` block, whose `Start at` is
 * from the cached run, not this one.
 *
 * Usage: node scripts/measure-test-seconds.mjs [--min=30] <job-log>...
 * Fetch each log with
 *   gh api --allow-escape-sequences repos/{owner}/{repo}/actions/jobs/{id}/logs
 * (`gh run view --log` truncates a large log silently, #5074). Prints the
 * per-unit median over every log, then each log's per-unit seconds.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SPLIT_TEST_UNITS, unitId } from './test-shard-balance.mjs';

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
const ANSI = /\x1b\[[0-9;]*m/g;
const GROUP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d+Z ##\[group\](.+)$/;
const HIT = /^\S+Z cache hit, replaying logs/;
const END = /^\S+Z ##\[endgroup\]/;
const START = /^\S+Z\s+Start at\s+(\d{2}):(\d{2}):(\d{2})\s*$/;
const DAY = 86400;

/** Map a turbo group title to a TEST_SECONDS key, or null for other tasks. */
export function unitKey(title) {
  const match = title.match(/^(@[^/\s]+\/[^:\s]+|[^@:\s][^:\s]*):(test.*)$/);
  if (!match) return null;
  const [, packageName, task] = match;
  const split = SPLIT_TEST_UNITS[packageName];
  if (split) return split.includes(task) ? unitId(packageName, task) : null;
  return task === 'test' ? packageName : null;
}

/**
 * Wall seconds of every test unit that ran in one job log.
 *
 * @param {string} log raw job log text
 * @returns {Map<string, number>} unit key to seconds
 */
export function parseUnitSeconds(log) {
  const units = new Map();
  let open = null;
  for (const line of log.replace(ANSI, '').split('\n')) {
    const group = line.match(GROUP);
    if (group) {
      const [, , hh, mm, ss, title] = group;
      open = {
        key: unitKey(title.trim()),
        endOfDay: Number(hh) * 3600 + Number(mm) * 60 + Number(ss),
        startOfDay: null,
        cached: false,
      };
      continue;
    }
    if (!open) continue;
    if (HIT.test(line)) open.cached = true;
    const start = line.match(START);
    if (start && open.startOfDay === null) {
      open.startOfDay = Number(start[1]) * 3600 + Number(start[2]) * 60 + Number(start[3]);
    }
    if (END.test(line)) {
      if (open.key && !open.cached && open.startOfDay !== null) {
        const wall = (open.endOfDay - open.startOfDay + DAY) % DAY;
        units.set(open.key, (units.get(open.key) ?? 0) + wall);
      }
      open = null;
    }
  }
  return units;
}

/** Median of a list of numbers (mean of the middle two for an even count). */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median seconds per unit over several logs' measurements. A unit measured in
 * only some logs takes the median of those.
 *
 * @param {Map<string, number>[]} runs
 * @returns {Record<string, number>} unit key to rounded seconds, sorted by key
 */
export function medianUnitSeconds(runs) {
  const samples = new Map();
  for (const run of runs) {
    for (const [key, seconds] of run) {
      samples.set(key, [...(samples.get(key) ?? []), seconds]);
    }
  }
  return Object.fromEntries(
    [...samples]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, values]) => [key, Math.round(median(values))]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const min = Number(args.find((arg) => arg.startsWith('--min='))?.slice(6) ?? 30);
  const files = args.filter((arg) => !arg.startsWith('--'));
  if (files.length === 0) {
    console.error('Usage: measure-test-seconds.mjs [--min=30] <job-log>...');
    process.exit(1);
  }
  const runs = files.map((file) => parseUnitSeconds(readFileSync(file, 'utf8')));
  const medians = medianUnitSeconds(runs);
  console.log(`# median over ${runs.length} logs, units of ${min} s or more`);
  console.log('# comment columns: seconds in each log, in argument order');
  for (const [key, seconds] of Object.entries(medians)) {
    if (seconds < min) continue;
    const per = runs.map((run) => run.get(key) ?? '-').join(' ');
    console.log(`  '${key}': ${seconds}, // ${per}`);
  }
}
