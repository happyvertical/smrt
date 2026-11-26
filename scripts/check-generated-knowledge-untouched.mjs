#!/usr/bin/env node
/**
 * Fails when a pull request edits generated knowledge pages (#5705).
 *
 * The generated OKF pages (`docs/knowledge/components/**` and the root
 * `docs/knowledge/index.md`) are regenerated after every push to main by the
 * "Regenerate Knowledge Pages" workflow and land through one rolling
 * `chore/knowledge-regenerate` PR. A feature PR that also commits them makes
 * the next queued PR conflict on those files, which is exactly what this
 * rule ends. Hand-authored pages (`intents/`, `solutions/`, `maintenance.md`)
 * are not generated and stay editable.
 *
 * Usage: node scripts/check-generated-knowledge-untouched.mjs [base-ref]
 *        node scripts/check-generated-knowledge-untouched.mjs --files-from F
 *   base-ref defaults to origin/main. Compares the merge base with HEAD, so
 *   changes that only arrived through main are never blamed on the PR.
 *   --files-from reads the PR's changed paths, one per line (CI feeds it the
 *   pull request files API, which needs no git history).
 *
 * Fix for a PR that already touched them:
 *   git restore --source="$(git merge-base origin/main HEAD)" --staged --worktree -- docs/knowledge/components docs/knowledge/index.md
 *   git commit -m "chore(knowledge): drop generated pages from this PR"
 * (a restore to the merge-base content also passes; no rebase needed).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Generated paths: component pages, both generated indexes, root index. */
export function isGeneratedKnowledgePath(path) {
  return (
    path === 'docs/knowledge/index.md' ||
    (path.startsWith('docs/knowledge/components/') && path.endsWith('.md'))
  );
}

export function offendingPaths(changedPaths) {
  return changedPaths.filter(isGeneratedKnowledgePath).sort();
}

export function renderFailure(paths) {
  return [
    'This pull request edits generated knowledge pages:',
    ...paths.map((path) => `  - ${path}`),
    '',
    'Generated pages are regenerated after merge to main and land through the',
    'rolling `chore/knowledge-regenerate` PR (#5705). Do not run',
    '`pnpm knowledge:okf` or commit them in a PR. To drop your changes:',
    '  git restore --source="$(git merge-base origin/main HEAD)" --staged --worktree -- \\',
    '    docs/knowledge/components docs/knowledge/index.md',
    '  git commit -m "chore(knowledge): drop generated pages from this PR"',
  ].join('\n');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function changedPaths() {
  if (process.argv[2] === '--files-from') {
    return readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean);
  }
  const base = process.argv[2] || 'origin/main';
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  return git([
    'diff',
    '--name-only',
    '--no-renames',
    `${mergeBase}..HEAD`,
    '--',
    'docs/knowledge',
  ])
    .split('\n')
    .filter(Boolean);
}

function main() {
  const changed = changedPaths();
  const offending = offendingPaths(changed);
  if (offending.length > 0) {
    console.error(renderFailure(offending));
    process.exit(1);
  }
  console.log('No generated knowledge pages edited.');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
