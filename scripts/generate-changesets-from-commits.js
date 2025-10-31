#!/usr/bin/env node

/**
 * Generate Changesets from Conventional Commits
 * 
 * Analyzes commits since main branch and generates changeset files
 * based on conventional commit format.
 * 
 * Usage:
 *   node scripts/generate-changesets-from-commits.js [base-branch]
 */

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const baseBranch = process.argv[2] || 'main';

// Package mapping
const PACKAGE_MAP = {
  'accounts': '@happyvertical/smrt-accounts',
  'agents': '@happyvertical/smrt-agents',
  'assets': '@happyvertical/smrt-assets',
  'cli': '@happyvertical/smrt-cli',
  'config': '@happyvertical/smrt-config',
  'content': '@happyvertical/smrt-content',
  'core': '@happyvertical/smrt-core',
  'dev-mcp': '@happyvertical/smrt-dev-mcp',
  'docs-mcp': '@happyvertical/smrt-docs-mcp',
  'events': '@happyvertical/smrt-events',
  'gnode': '@happyvertical/smrt-gnode',
  'places': '@happyvertical/smrt-places',
  'products': '@happyvertical/smrt-products',
  'profiles': '@happyvertical/smrt-profiles',
  'svelte': '@happyvertical/smrt-svelte',
  'tags': '@happyvertical/smrt-tags',
  'types': '@happyvertical/smrt-types'
};

// Get all packages
const ALL_PACKAGES = Object.values(PACKAGE_MAP);

function execCommand(command) {
  try {
    return execSync(command, { encoding: 'utf8' }).trim();
  } catch (error) {
    return '';
  }
}

function getCommitsSinceBase() {
  const commits = execCommand(`git log ${baseBranch}..HEAD --pretty=format:"%H|||%s|||%b"`);

  if (!commits) {
    console.log(`No commits found since ${baseBranch}`);
    return [];
  }

  return commits.split('\n').filter(Boolean).map(line => {
    const parts = line.split('|||');
    const hash = parts[0] || '';
    const subject = parts[1] || '';
    const body = parts[2] || '';
    return { hash, subject, body };
  });
}

function parseConventionalCommit(commit) {
  const { subject, body } = commit;
  
  // Parse: type(scope): description
  // Examples:
  //   feat(core): add feature
  //   fix(agents, core): fix bug
  //   feat!: breaking change
  const match = subject.match(/^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/);
  
  if (!match) {
    return null;
  }
  
  const [, type, , scope, breaking, description] = match;
  
  // Check for BREAKING CHANGE in body
  const hasBreakingInBody = /BREAKING CHANGE:/i.test(body);
  const isBreaking = breaking === '!' || hasBreakingInBody;
  
  // Determine bump type (pre-1.0: breaking = minor)
  let bumpType = 'patch';
  if (isBreaking || type === 'feat') {
    bumpType = 'minor';
  }
  if (type === 'fix' || type === 'perf') {
    bumpType = 'patch';
  }
  
  // Parse scope to packages
  let packages = [];
  if (scope) {
    const scopes = scope.split(',').map(s => s.trim());
    for (const s of scopes) {
      if (PACKAGE_MAP[s]) {
        packages.push(PACKAGE_MAP[s]);
      }
    }
  }
  
  // If no packages specified, include all
  if (packages.length === 0) {
    packages = ALL_PACKAGES;
  }
  
  return {
    type,
    scope,
    packages,
    bumpType,
    description,
    isBreaking,
    body
  };
}

function generateChangesetContent(commits, parsedCommits) {
  // Group by packages and bump type
  const packageBumps = {};
  
  for (const parsed of parsedCommits) {
    for (const pkg of parsed.packages) {
      if (!packageBumps[pkg]) {
        packageBumps[pkg] = { bump: 'patch', commits: [] };
      }
      
      // Use highest bump type
      const currentBump = packageBumps[pkg].bump;
      const newBump = parsed.bumpType;
      
      if (newBump === 'minor' || (newBump === 'patch' && currentBump === 'patch')) {
        packageBumps[pkg].bump = newBump;
      }
      
      packageBumps[pkg].commits.push(parsed);
    }
  }
  
  // Generate frontmatter
  const frontmatter = Object.entries(packageBumps)
    .map(([pkg, data]) => `"${pkg}": ${data.bump}`)
    .join('\n');
  
  // Generate summary
  const summary = parsedCommits
    .map(p => {
      const breaking = p.isBreaking ? ' **BREAKING**' : '';
      return `- ${p.type}(${p.scope || 'all'}): ${p.description}${breaking}`;
    })
    .join('\n');
  
  return `---\n${frontmatter}\n---\n\n${summary}\n`;
}

function writeChangeset(content) {
  const changesetDir = '.changeset';
  
  if (!existsSync(changesetDir)) {
    mkdirSync(changesetDir);
  }
  
  // Generate unique changeset ID
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const filename = `${timestamp}-${random}.md`;
  
  const filepath = join(changesetDir, filename);
  writeFileSync(filepath, content);
  
  console.log(`✅ Created changeset: ${filename}`);
  return filename;
}

function hasExistingChangesets() {
  const changesetDir = '.changeset';
  
  if (!existsSync(changesetDir)) {
    return false;
  }
  
  const files = readdirSync(changesetDir);
  // Ignore config and README
  return files.some(f => f.endsWith('.md') && f !== 'README.md');
}

function main() {
  console.log('🔍 Analyzing commits...\n');
  
  // Check if changesets already exist
  if (hasExistingChangesets()) {
    console.log('ℹ️  Changesets already exist - skipping auto-generation');
    console.log('   (Delete existing changesets if you want to regenerate)');
    process.exit(0);
  }
  
  const commits = getCommitsSinceBase();
  
  if (commits.length === 0) {
    console.log(`ℹ️  No commits found since ${baseBranch}`);
    process.exit(0);
  }
  
  console.log(`Found ${commits.length} commit(s) since ${baseBranch}\n`);
  
  const parsedCommits = commits
    .map(c => parseConventionalCommit(c))
    .filter(Boolean);
  
  if (parsedCommits.length === 0) {
    console.log('⚠️  No conventional commits found - skipping changeset generation');
    console.log('   Commits should follow format: type(scope): description');
    console.log('   Examples: feat(core): add feature, fix(agents): fix bug');
    process.exit(0);
  }
  
  console.log('Parsed commits:');
  for (const parsed of parsedCommits) {
    console.log(`  ${parsed.type}(${parsed.scope || 'all'}): ${parsed.description}`);
    console.log(`    → ${parsed.packages.length} package(s), ${parsed.bumpType} bump`);
  }
  
  console.log('\n📝 Generating changeset...\n');
  
  const content = generateChangesetContent(commits, parsedCommits);
  const filename = writeChangeset(content);
  
  console.log('\n✨ Done! Changeset generated from conventional commits.');
  console.log(`   File: .changeset/${filename}`);
  console.log('\nYou can edit the changeset to add more details if needed.');
}

main();
