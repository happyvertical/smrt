#!/usr/bin/env node
/**
 * Decide how much a merge-group run must validate (#5364).
 *
 * Usage: merge-group-scope.mjs --base <sha> --head <sha>
 *
 * Wraps `ci-impact.mjs`, which already falls back to the full suite for any
 * global, unowned, harness (core/scanner/vitest) or unreadable input. This only
 * turns that plan into the two things workflows consume:
 *
 *   mode      `full` when the plan is full or anything about it is uncertain,
 *             else `affected`; Turbo then selects `...[base]` from that mode.
 *   postgres  the affected `test:postgres` packages as a JSON array, or `all`
 *             when the plan is full. An empty array means no suite can change.
 *
 * Soundness: the base is `merge_group.base_sha`. Under the queue's ALLGREEN
 * grouping an entry only merges when every earlier entry did, so the base is
 * itself validated and the diff against it is exactly what this group adds.
 * Any failure to compute a plan selects `full`, never `affected`.
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planFromGit } from './ci-impact.mjs';

/** Pure decision from an impact plan; anything unexpected is full. */
export function decideScope(plan) {
  const complete = plan && plan.inventoryComplete === true && Array.isArray(plan.packages);
  if (!complete || plan.full !== false) {
    return { mode: 'full', postgres: 'all', reasons: plan?.reasons ?? ['No impact plan'] };
  }
  const names = plan.suites?.['test:postgres'];
  if (!Array.isArray(names)) {
    return { mode: 'full', postgres: 'all', reasons: ['No PostgreSQL suite inventory'] };
  }
  return {
    mode: 'affected',
    postgres: names.map((entry) => entry.name).sort(),
    reasons: plan.reasons,
  };
}

export function scopeFromGit(options) {
  try {
    return decideScope(planFromGit(options));
  } catch (cause) {
    return { mode: 'full', postgres: 'all', reasons: [cause.message] };
  }
}

function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    if (!['--base', '--head'].includes(key) || !process.argv[index + 1] || options[key]) {
      throw new Error('Usage: merge-group-scope.mjs --base <sha> --head <sha>');
    }
    options[key] = process.argv[index + 1];
  }
  const scope = scopeFromGit({ base: options['--base'], head: options['--head'] });
  const postgres = scope.postgres === 'all' ? 'all' : JSON.stringify(scope.postgres);
  const lines = [`mode=${scope.mode}`, `postgres=${postgres}`];
  console.error(`merge-group scope: ${lines.join(' ')}`);
  for (const reason of scope.reasons.slice(0, 20)) console.error(`  - ${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
