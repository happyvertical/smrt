#!/usr/bin/env node
/**
 * Redaction rules ledgers (#5352).
 *
 * Core's built-in redaction rules and smrt-config's value rules each carry a
 * version, pinned in a ledger next to them: one row per version with the
 * digest of the rules' source and of their output on a fixed corpus. Each
 * package's ledger test fails when the current rules no longer match the
 * last row. This check makes the version bump mechanical: compared with the
 * base revision, every row the base already has must be unchanged, rows may
 * only be appended, and versions must strictly increase. So a rules change
 * cannot be absorbed by rewriting a row: it needs a new, higher version,
 * which is what tells a reader that text stored earlier was redacted under
 * other rules.
 *
 * Usage: node scripts/check-redaction-ledgers.mjs [--base REV] [--root DIR]
 * The base defaults to $BASE_SHA, then origin/main. CI runs it in the
 * "CI Control Plane Regression" job (on-pull-request.yml) with the pull
 * request or merge group base.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGERS = [
  'packages/core/src/redaction-rules-ledger.json',
  'packages/config/src/secret-value-rules-ledger.json',
];

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const root = flag('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const base = flag('--base') ?? process.env.BASE_SHA ?? 'origin/main';

function rowsOf(text, where) {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.rows)) {
    throw new Error(`${where}: no "rows" array`);
  }
  return parsed.rows;
}

/** The ledger at the base, or null when the base does not have the file. */
function baseRows(path) {
  const exists = spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (exists.status !== 0) {
    throw new Error(`base revision ${base} is not available (fetch it first)`);
  }
  const shown = spawnSync('git', ['show', `${base}:${path}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (shown.status === 0) return rowsOf(shown.stdout, `${base}:${path}`);
  const listed = spawnSync('git', ['ls-tree', '--name-only', base, '--', path], {
    cwd: root,
    encoding: 'utf8',
  });
  if (listed.status === 0 && listed.stdout.trim() === '') return null;
  throw new Error(`cannot read ${base}:${path}: ${shown.stderr.trim()}`);
}

const problems = [];
try {
  for (const path of LEDGERS) {
    const head = rowsOf(readFileSync(join(root, path), 'utf8'), path);
    for (let i = 0; i < head.length; i++) {
      const version = head[i]?.version;
      if (!Number.isSafeInteger(version) || version < 1) {
        problems.push(`${path}: row ${i + 1} has no positive integer version`);
      } else if (i > 0 && !(version > head[i - 1].version)) {
        problems.push(`${path}: row ${i + 1} (version ${version}) does not raise the version`);
      }
    }
    const previous = baseRows(path);
    if (previous === null) continue;
    if (head.length < previous.length) {
      problems.push(`${path}: ${previous.length - head.length} row(s) of ${base} removed`);
    }
    for (let i = 0; i < Math.min(previous.length, head.length); i++) {
      if (JSON.stringify(previous[i]) !== JSON.stringify(head[i])) {
        problems.push(
          `${path}: row ${i + 1} (version ${previous[i]?.version}) differs from ${base}; append a row with a higher version instead`,
        );
      }
    }
  }
} catch (error) {
  console.error(`check-redaction-ledgers: ${error.message}`);
  process.exit(2);
}

if (problems.length > 0) {
  console.error('check-redaction-ledgers: a rules ledger was changed in place:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`check-redaction-ledgers: ${LEDGERS.length} ledgers append-only against ${base}`);
