#!/usr/bin/env node
/**
 * Sequential Package Publisher with Concurrency Control
 *
 * This script publishes packages sequentially (or with limited concurrency)
 * to avoid V8 bytecode cache race conditions that occur when many npm publish
 * processes run in parallel.
 *
 * Root Cause:
 * - Changesets publishes all packages in parallel using Promise.all()
 * - Multiple concurrent npm publish processes create race conditions in
 *   Node.js v24's V8 bytecode cache
 * - Results in "Fatal error: unreachable code" crashes during deserialization
 *
 * Solution:
 * - Publishes packages with controlled concurrency (default: 1)
 * - Eliminates race conditions while maintaining reliability
 *
 * Related Issues:
 * - https://github.com/nodejs/node/issues/51555
 * - https://github.com/happyvertical/smrt/actions/runs/19048362868
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Configuration
const CONCURRENCY = process.env.PUBLISH_CONCURRENCY
  ? Number.parseInt(process.env.PUBLISH_CONCURRENCY, 10)
  : 1;

/**
 * Execute a shell command and return the output
 */
function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // Use pnpm exec to run changeset from node_modules
    const isChangeset = command === 'changeset';
    const finalCommand = isChangeset ? 'pnpm' : command;
    const finalArgs = isChangeset ? ['exec', 'changeset', ...args] : args;

    const child = spawn(finalCommand, finalArgs, {
      cwd: options.cwd || rootDir,
      stdio: options.silent ? 'pipe' : 'inherit',
      env: { ...process.env, ...options.env },
    });

    let stdout = '';
    let stderr = '';

    if (options.silent) {
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

/**
 * Get packages that need to be published from changesets
 */
async function getPackagesToPublish() {
  console.log('🔍 Checking which packages need publishing...\n');

  try {
    const { stdout } = await exec(
      'changeset',
      ['status', '--output=status.json'],
      {
        silent: true,
      },
    );

    // Parse the changesets status output
    // This tells us which packages have unpublished changes
    const status = JSON.parse(stdout);

    if (!status.releases || status.releases.length === 0) {
      console.log('✅ No packages need publishing\n');
      return [];
    }

    const packages = status.releases.map((release) => ({
      name: release.name,
      version: release.newVersion,
      type: release.type,
    }));

    console.log(`📦 Found ${packages.length} packages to publish:\n`);
    for (const pkg of packages) {
      console.log(`   - ${pkg.name}@${pkg.version} (${pkg.type})`);
    }
    console.log('');

    return packages;
  } catch (_error) {
    // If changeset status fails, fall back to regular publish
    console.log(
      '⚠️  Could not get package list from changesets, using standard publish\n',
    );
    return null;
  }
}

/**
 * Publish a single package
 */
async function publishPackage(pkg) {
  console.log(`📤 Publishing ${pkg.name}@${pkg.version}...`);

  try {
    await exec('changeset', ['publish', '--no-git-tag'], {
      env: {
        // Ensure authentication tokens are passed through
        // biome-ignore lint/style/useNamingConvention: Environment variable names
        NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
        // biome-ignore lint/style/useNamingConvention: Environment variable names
        NPM_TOKEN: process.env.NPM_TOKEN,
      },
    });

    console.log(`✅ Successfully published ${pkg.name}@${pkg.version}\n`);
    return { success: true, package: pkg };
  } catch (error) {
    console.error(`❌ Failed to publish ${pkg.name}@${pkg.version}`);
    console.error(`   Error: ${error.message}\n`);
    return { success: false, package: pkg, error };
  }
}

/**
 * Publish packages with controlled concurrency
 */
async function publishWithConcurrency(packages, concurrency) {
  const results = [];
  const queue = [...packages];
  const inFlight = new Set();

  console.log(
    `🚀 Publishing ${packages.length} packages with concurrency ${concurrency}\n`,
  );
  console.log('─'.repeat(80));
  console.log('');

  while (queue.length > 0 || inFlight.size > 0) {
    // Start new publishes up to concurrency limit
    while (inFlight.size < concurrency && queue.length > 0) {
      const pkg = queue.shift();
      const promise = publishPackage(pkg).then((result) => {
        inFlight.delete(promise);
        return result;
      });
      inFlight.add(promise);
    }

    // Wait for at least one to complete
    if (inFlight.size > 0) {
      const result = await Promise.race(inFlight);
      results.push(result);
    }
  }

  return results;
}

/**
 * Main execution
 */
async function main() {
  console.log('🦋 Sequential Package Publisher\n');
  console.log('─'.repeat(80));
  console.log('');

  try {
    // Get packages to publish
    const packages = await getPackagesToPublish();

    if (packages === null) {
      // Fallback: use standard changeset publish
      console.log(
        '📦 Using standard changeset publish (no concurrency control)\n',
      );
      await exec('changeset', ['publish']);
      console.log('\n✅ Publishing completed\n');
      return;
    }

    if (packages.length === 0) {
      console.log('✅ Nothing to publish\n');
      return;
    }

    // Publish with concurrency control
    const results = await publishWithConcurrency(packages, CONCURRENCY);

    // Summary
    console.log('─'.repeat(80));
    console.log('');
    console.log('📊 Publishing Summary:\n');

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    console.log(`✅ Successful: ${successful.length}`);
    for (const result of successful) {
      console.log(`   - ${result.package.name}@${result.package.version}`);
    }

    if (failed.length > 0) {
      console.log(`\n❌ Failed: ${failed.length}`);
      for (const result of failed) {
        console.log(`   - ${result.package.name}@${result.package.version}`);
        console.log(`     Error: ${result.error.message}`);
      }
      console.log('');
      process.exit(1);
    }

    console.log('\n🎉 All packages published successfully!\n');
  } catch (error) {
    console.error('\n❌ Publishing failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
