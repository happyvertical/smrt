#!/usr/bin/env node
/**
 * Decide whether a release has anything to version (#5152).
 *
 * Run by the Prepare Release step after `changeset:auto`. Exits 0 when at
 * least one pending changeset exists, and 3 when there is nothing to release,
 * so the workflow can record an explicit `should_publish=false` decision
 * instead of letting `changeset version` fail with "No unreleased changesets
 * found".
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NO_PENDING_EXIT_CODE = 3;

export function hasPendingChangesets(root = process.cwd()) {
  const dir = join(root, '.changeset');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (name) => name.endsWith('.md') && name !== 'README.md',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pending = hasPendingChangesets(process.argv[2] ?? process.cwd());
  console.log(pending ? 'pending changesets found' : 'no pending changesets');
  process.exit(pending ? 0 : NO_PENDING_EXIT_CODE);
}
