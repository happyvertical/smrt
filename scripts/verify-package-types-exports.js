#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bundledVerifierPath = fileURLToPath(
  new URL(
    '../packages/cli/scripts/verify-package-types-exports.js',
    import.meta.url,
  ),
);

const result = spawnSync(
  process.execPath,
  [bundledVerifierPath, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(`❌ Failed to run bundled verifier: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
