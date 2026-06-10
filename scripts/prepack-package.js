#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestVerifierPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'verify-manifest-completeness.mjs',
);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/**
 * Run the manifest-completeness guard for the current package (issue #1483).
 * Returns true when the published manifest includes every @smrt object in
 * source (or the check does not apply); false when it is stale/incomplete.
 */
function manifestCheckPasses() {
  const result = spawnSync(
    process.execPath,
    [manifestVerifierPath, process.cwd()],
    { stdio: 'inherit', env: process.env },
  );

  if (result.error) {
    fail(`Failed to run manifest verifier: ${result.error.message}`);
  }

  return result.status === 0;
}

function runScript(scriptName) {
  execFileSync('npm', ['run', scriptName], {
    stdio: 'inherit',
    env: process.env,
  });
}

function tryScript(scriptName) {
  const result = spawnSync('npm', ['run', scriptName], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    fail(`Failed to run "${scriptName}": ${result.error.message}`);
  }

  return result.status === 0;
}

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const packageName = packageJson.name ?? resolve('.');
const scripts = packageJson.scripts ?? {};

const buildScript = scripts['build:fresh']
  ? 'build:fresh'
  : scripts.build
    ? 'build'
    : null;

if (!buildScript) {
  fail(`No build script found for ${packageName}`);
}

const verifyScripts = ['verify:pack', 'verify:exports'].filter(
  (scriptName) => typeof scripts[scriptName] === 'string',
);
const buildScriptCommand =
  typeof scripts[buildScript] === 'string' ? scripts[buildScript] : '';
const verifyScriptsHandledByBuild = new Set(
  verifyScripts.filter((scriptName) => buildScriptCommand.includes(scriptName)),
);

const runningInCi = process.env.CI === 'true' || process.env.CI === '1';
const hasDistArtifacts = existsSync(resolve('dist'));

if (runningInCi && hasDistArtifacts && verifyScripts.length > 0) {
  console.log(
    `[smrt-prepack] Reusing existing CI build artifacts for ${packageName} when verification succeeds.`,
  );

  // The manifest guard is part of the reuse gate: a reused dist whose
  // manifest.json predates a new @smrt class (issue #1483) must NOT be
  // republished. Failing here falls through to a clean rebuild below.
  const reusable =
    verifyScripts.every((scriptName) => tryScript(scriptName)) &&
    manifestCheckPasses();
  if (reusable) {
    process.exit(0);
  }

  console.log(
    `[smrt-prepack] CI build artifacts were incomplete for ${packageName}; rebuilding with "${buildScript}".`,
  );
}

runScript(buildScript);

for (const scriptName of verifyScripts) {
  if (verifyScriptsHandledByBuild.has(scriptName)) {
    continue;
  }
  runScript(scriptName);
}

// Final gate: even a fresh build must produce a manifest that includes every
// @smrt object in source. Catches scanner/build regressions, not just stale
// reused artifacts (issue #1483).
if (!manifestCheckPasses()) {
  fail(
    `Published manifest for ${packageName} is incomplete after build. See the [verify-manifest] output above.`,
  );
}
