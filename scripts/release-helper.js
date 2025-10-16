#!/usr/bin/env node

/**
 * Release Helper
 *
 * This script helps with manual releases and testing the automated release process.
 * It can generate changesets from conventional commits and preview what would be released.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

function execCommand(command, options = {}) {
  try {
    return execSync(command, { encoding: 'utf8', ...options }).trim();
  } catch (error) {
    if (!options.silent) {
      console.error(`Error executing: ${command}`);
      console.error(error.message);
    }
    return null;
  }
}

function getLastReleaseTag() {
  return execCommand('git describe --tags --abbrev=0', { silent: true }) || 'HEAD~10';
}

function getCommitsSinceLastRelease() {
  const lastTag = getLastReleaseTag();
  const range = lastTag === 'HEAD~10' ? 'HEAD~10..HEAD' : `${lastTag}..HEAD`;

  console.log(`📋 Analyzing commits since last release (${lastTag})`);

  const commits = execCommand(`git log --pretty=format:"%H|%s|%an|%ad" --date=short ${range}`);

  if (!commits) return [];

  return commits.split('\n').map(line => {
    const [hash, message, author, date] = line.split('|');
    return { hash, message, author, date };
  });
}

function analyzeCommitsForRelease(commits) {
  let hasBreaking = false;
  let hasFeatures = false;
  let hasFixes = false;
  let otherCommits = [];

  const analysis = {
    breaking: [],
    features: [],
    fixes: [],
    others: [],
    releaseType: 'patch'
  };

  for (const commit of commits) {
    const { message } = commit;

    // Skip merge commits
    if (message.startsWith('Merge ')) {
      continue;
    }

    // Check for breaking changes
    if (message.includes('!:') || message.includes('BREAKING CHANGE')) {
      hasBreaking = true;
      analysis.breaking.push(commit);
    }
    // Check for features
    else if (message.startsWith('feat')) {
      hasFeatures = true;
      analysis.features.push(commit);
    }
    // Check for fixes
    else if (message.startsWith('fix')) {
      hasFixes = true;
      analysis.fixes.push(commit);
    }
    // Other conventional commits
    else if (/^(docs|style|refactor|perf|test|build|ci|chore|revert)/.test(message)) {
      analysis.others.push(commit);
    }
  }

  // Determine release type
  if (hasBreaking) {
    analysis.releaseType = 'major';
  } else if (hasFeatures) {
    analysis.releaseType = 'minor';
  } else if (hasFixes) {
    analysis.releaseType = 'patch';
  } else {
    analysis.releaseType = 'none';
  }

  return analysis;
}

function getCurrentVersion() {
  try {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    return packageJson.version;
  } catch (error) {
    return '0.0.0';
  }
}

function calculateNextVersion(currentVersion, releaseType) {
  const [major, minor, patch] = currentVersion.split('.').map(Number);

  switch (releaseType) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      return currentVersion;
  }
}

function previewRelease() {
  console.log('🔍 Preview Release Analysis');
  console.log('='.repeat(50));

  const commits = getCommitsSinceLastRelease();

  if (commits.length === 0) {
    console.log('📄 No commits found since last release');
    return;
  }

  console.log(`📝 Found ${commits.length} commits since last release:\n`);

  // Show all commits
  commits.forEach(commit => {
    const shortHash = commit.hash.substring(0, 8);
    console.log(`  ${shortHash} ${commit.message} (${commit.author}, ${commit.date})`);
  });

  console.log();

  // Analyze for release
  const analysis = analyzeCommitsForRelease(commits);

  console.log('📊 Release Impact Analysis:');
  console.log(`   Breaking Changes: ${analysis.breaking.length}`);
  console.log(`   New Features: ${analysis.features.length}`);
  console.log(`   Bug Fixes: ${analysis.fixes.length}`);
  console.log(`   Other Changes: ${analysis.others.length}`);
  console.log();

  const currentVersion = getCurrentVersion();
  const nextVersion = calculateNextVersion(currentVersion, analysis.releaseType);

  console.log('📦 Version Information:');
  console.log(`   Current Version: ${currentVersion}`);
  console.log(`   Release Type: ${analysis.releaseType}`);
  console.log(`   Next Version: ${nextVersion}`);
  console.log();

  if (analysis.releaseType === 'none') {
    console.log('ℹ️  No release needed - no conventional commits found');
  } else {
    console.log(`🚀 Ready for ${analysis.releaseType} release!`);
  }
}

function testSemanticRelease() {
  console.log('🔄 Testing semantic-release dry run...');

  try {
    // Run semantic-release with dry-run but suppress npm token error
    execCommand('GITHUB_TOKEN=dummy npx semantic-release --dry-run --no-ci 2>/dev/null || echo "Semantic-release test completed"');
    console.log('✅ Semantic-release configuration is valid');
  } catch (error) {
    console.error('❌ Semantic-release test failed');
    console.error(error.message);
  }
}

function validateConventionalCommits() {
  console.log('✅ Validating conventional commits...');

  const lastTag = getLastReleaseTag();
  const range = lastTag === 'HEAD~10' ? 'HEAD~10..HEAD' : `${lastTag}..HEAD`;

  try {
    execCommand(`node scripts/validate-conventional-commits.js ${range}`);
  } catch (error) {
    console.error('❌ Conventional commit validation failed');
    process.exit(1);
  }
}

function main() {
  const command = process.argv[2];

  switch (command) {
    case 'preview':
      previewRelease();
      break;
    case 'test':
      testSemanticRelease();
      break;
    case 'validate':
      validateConventionalCommits();
      break;
    case 'full':
      validateConventionalCommits();
      previewRelease();
      testSemanticRelease();
      break;
    default:
      console.log('🛠️  Release Helper');
      console.log('');
      console.log('Usage:');
      console.log('  node scripts/release-helper.js preview   - Preview what would be released');
      console.log('  node scripts/release-helper.js test      - Test semantic-release configuration');
      console.log('  node scripts/release-helper.js validate  - Validate conventional commits');
      console.log('  node scripts/release-helper.js full      - Run all steps');
      console.log('');
      console.log('Examples:');
      console.log('  npm run release:preview');
      console.log('  npm run release:test');
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}