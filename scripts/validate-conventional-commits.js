#!/usr/bin/env node

/**
 * Validate Conventional Commits
 *
 * This script validates that commits follow conventional commit format
 * and can be used in pre-commit hooks or CI/CD pipelines.
 */

import { execSync } from 'child_process';

const CONVENTIONAL_COMMIT_TYPES = [
  'feat',     // New feature
  'fix',      // Bug fix
  'docs',     // Documentation changes
  'style',    // Code style changes (formatting, missing semi-colons, etc)
  'refactor', // Code refactoring
  'perf',     // Performance improvements
  'test',     // Adding or modifying tests
  'build',    // Changes to build system or external dependencies
  'ci',       // Changes to CI configuration files and scripts
  'chore',    // Other changes that don't modify src or test files
  'revert',   // Reverts a previous commit
];

const CONVENTIONAL_COMMIT_REGEX = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?(!)?: .{1,50}/;

function getCommits(range = 'HEAD~1..HEAD') {
  try {
    const output = execSync(`git log --pretty=format:"%H|%s" ${range}`, { encoding: 'utf8' });
    return output.trim().split('\n').map(line => {
      const [hash, message] = line.split('|');
      return { hash, message };
    }).filter(commit => commit.hash && commit.message);
  } catch (error) {
    console.error('Error getting commits:', error.message);
    return [];
  }
}

function validateCommit(commit) {
  const { hash, message } = commit;

  // Skip merge commits
  if (message.startsWith('Merge ')) {
    return { valid: true, type: 'merge', message: 'Merge commit (skipped)' };
  }

  // Check if commit message follows conventional commit format
  const match = message.match(CONVENTIONAL_COMMIT_REGEX);

  if (!match) {
    return {
      valid: false,
      type: 'invalid',
      message: `Invalid conventional commit format: "${message}"`
    };
  }

  const [, type, scope, breaking] = match;

  return {
    valid: true,
    type,
    scope: scope ? scope.slice(1, -1) : null, // Remove parentheses
    breaking: !!breaking,
    message: `Valid ${type} commit${scope ? ` (${scope})` : ''}${breaking ? ' [BREAKING]' : ''}`
  };
}

function main() {
  const args = process.argv.slice(2);
  const range = args[0] || 'HEAD~1..HEAD';

  console.log(`Validating commits in range: ${range}`);
  console.log('='.repeat(50));

  const commits = getCommits(range);

  if (commits.length === 0) {
    console.log('No commits found in range');
    return;
  }

  let invalidCommits = 0;
  let validCommits = 0;

  for (const commit of commits) {
    const validation = validateCommit(commit);

    const status = validation.valid ? '✅' : '❌';
    console.log(`${status} ${commit.hash.substring(0, 8)}: ${validation.message}`);

    if (!validation.valid) {
      invalidCommits++;
      console.log(`   Original: ${commit.message}`);
    } else {
      validCommits++;
    }
  }

  console.log('='.repeat(50));
  console.log(`Summary: ${validCommits} valid, ${invalidCommits} invalid commits`);

  if (invalidCommits > 0) {
    console.log('\nConventional Commit Format:');
    console.log('type(scope): description');
    console.log('\nValid types:', CONVENTIONAL_COMMIT_TYPES.join(', '));
    console.log('\nExamples:');
    console.log('feat: add user authentication');
    console.log('fix(api): resolve login endpoint error');
    console.log('feat!: remove deprecated API (breaking change)');

    process.exit(1);
  }

  console.log('✅ All commits follow conventional commit format!');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { validateCommit, getCommits, CONVENTIONAL_COMMIT_TYPES };