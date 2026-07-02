#!/usr/bin/env node
/**
 * Writes (--write) or verifies (--verify, default) the generated framework
 * contract files checked into @happyvertical/smrt-mobile. Imports from
 * ../dist — run after `vite build` (the package `build`/`generate` scripts
 * order this correctly).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkKotlinFiles, verifyFileSet, writeFileSet } from '../dist/index.js';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetDir = path.resolve(
  pkgRoot,
  '../smrt-mobile/src/commonMain/kotlin/com/happyvertical/smrt/mobile/contract',
);

const files = frameworkKotlinFiles();
const write = process.argv.includes('--write');

if (write) {
  writeFileSet(targetDir, files);
  console.log(`✓ wrote ${files.size} framework contract file(s) to ${targetDir}`);
} else {
  const stale = verifyFileSet(targetDir, files);
  if (stale.length > 0) {
    console.error('✗ smrt-mobile framework contract is stale:');
    for (const relPath of stale) {
      console.error(`  - ${relPath}`);
    }
    console.error(
      'Run: pnpm --filter @happyvertical/smrt-mobile-contract generate:framework',
    );
    process.exit(1);
  }
  console.log(`✓ smrt-mobile framework contract is fresh (${files.size} file(s)).`);
}
