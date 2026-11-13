#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  capture,
  check,
  loadBuild,
  moveOldest,
  save,
  stableJSON,
} from './lib/release-upgrade-gate.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const directory = path.join(repoRoot, 'packages/core/release-upgrade');
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      to: { type: 'string' },
      'upgrade-first-to': { type: 'string' },
      reason: { type: 'string' },
    },
  });
  const root = path.resolve(values.root ?? repoRoot);
  switch (positionals[0]) {
    case 'capture': {
      // Keep stdout a JSON artifact even when the release's migrator logs.
      const original = Object.fromEntries(
        ['log', 'info', 'debug'].map((method) => [method, console[method]]),
      );
      let snapshot;
      try {
        for (const method of Object.keys(original))
          console[method] = (...args) => console.error(...args);
        snapshot = await capture({ root });
      } finally {
        for (const [method, fn] of Object.entries(original))
          console[method] = fn;
      }
      process.stdout.write(stableJSON(snapshot));
      break;
    }
    case 'check':
      process.exitCode = (await check({ root, directory })).ok ? 0 : 1;
      break;
    case 'save': {
      const { snapshot, kept } = await save({ root, directory });
      console.log(`Saved smrt ${snapshot.release}. Kept: ${kept.join(', ')}`);
      break;
    }
    case 'move-oldest': {
      const build = await loadBuild(repoRoot, { manifests: false });
      const next = moveOldest({
        directory,
        to: values.to,
        upgradeFirstTo: values['upgrade-first-to'],
        reason: values.reason,
        compare: build.compareReleases,
      });
      console.log(
        `Oldest supported release is now ${next.release}. ${next.decision}`,
      );
      break;
    }
    default:
      throw new Error(
        'Usage: release-upgrade-gate.mjs capture|check|save|move-oldest [--root <built checkout>]',
      );
  }
} catch (error) {
  console.error(`Release upgrade gate: FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
}
