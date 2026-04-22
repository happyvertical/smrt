#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
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

const runningInCi = process.env.CI === 'true' || process.env.CI === '1';
const hasDistArtifacts = existsSync(resolve('dist'));

if (runningInCi && hasDistArtifacts && verifyScripts.length > 0) {
  console.log(
    `[smrt-prepack] Reusing existing CI build artifacts for ${packageName} when verification succeeds.`,
  );

  const reusable = verifyScripts.every((scriptName) => tryScript(scriptName));
  if (reusable) {
    process.exit(0);
  }

  console.log(
    `[smrt-prepack] CI build artifacts were incomplete for ${packageName}; rebuilding with "${buildScript}".`,
  );
}

runScript(buildScript);

for (const scriptName of verifyScripts) {
  runScript(scriptName);
}
