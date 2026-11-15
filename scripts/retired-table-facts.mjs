#!/usr/bin/env node
/**
 * Write what the retire step (#5005) needs from a published release, read
 * from that release's published package manifests (npm, or --from a
 * directory holding them):
 *
 *   node scripts/retired-table-facts.mjs owners --release 0.61.1
 *     packages/core/release-upgrade/owners/0.61.1.json: which classes
 *     declared each model table in that release. The release upgrade gate
 *     checks a retirement's lastOwner against it.
 *
 *   node scripts/retired-table-facts.mjs definition \
 *     --package @happyvertical/smrt-inference \
 *     --table _smrt_inference_design_runs --release 0.61.1
 *     The definition of that retirement in the package's package.json: the
 *     table's columns and types as the release declared them. Migrate drops
 *     the live table only when it matches.
 *
 * Run `pnpm build` first: the manifests are read with this build's core.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  loadCore,
  loadReleaseManifests,
  releaseFacts,
  writeDefinition,
  writeOwnersOverlay,
} from './lib/retired-table-facts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'packages/core/release-upgrade');
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      release: { type: 'string' },
      from: { type: 'string' },
      package: { type: 'string' },
      table: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!values.release || !['owners', 'definition'].includes(command))
    throw new Error(
      'Usage: retired-table-facts.mjs owners --release <release> [--from <dir>] | definition --package <name> --table <table> --release <release> [--from <dir>]',
    );
  const manifests = loadReleaseManifests({
    root,
    release: values.release,
    from: values.from,
    log: (line) => console.error(line),
  });
  const facts = releaseFacts(await loadCore(root), manifests);
  if (command === 'owners') {
    const file = writeOwnersOverlay({
      directory,
      release: values.release,
      owners: facts.owners,
    });
    console.log(`Wrote ${path.relative(root, file)} from ${manifests.length} manifest(s).`);
  } else {
    if (!values.package || !values.table)
      throw new Error('definition needs --package and --table');
    const file = writeDefinition({
      root,
      packageName: values.package,
      table: values.table,
      release: values.release,
      facts,
    });
    console.log(`Wrote the definition of ${values.table} into ${path.relative(root, file)}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
