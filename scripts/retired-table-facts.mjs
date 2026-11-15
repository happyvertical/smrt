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
 *     --package @acme/orders --table acme_order_drafts --release 1.3.2
 *     That release's entry of the retirement's `definitions` in the
 *     package's package.json: the table's columns and types as the release
 *     declared them. Run it once per supported release the table's shape may
 *     differ in. Migrate drops the live table only when it matches one.
 *
 *   node scripts/retired-table-facts.mjs check [--release <release>]
 *     Regenerate every owners file and every declaration's definitions from
 *     the published manifests and fail on any difference: a hand edit is
 *     caught. Without --release it checks every release that has an owners
 *     file or a definition (fetching each from npm).
 *
 *   node scripts/retired-table-facts.mjs refresh
 *     (pnpm release-upgrade:refresh-owners) All of the above for the whole
 *     snapshot set in one idempotent run: write an owners file for each
 *     snapshot, delete one whose snapshot is gone, and rewrite every
 *     declaration's definitions to the snapshot releases holding its table.
 *     Run it after a base merge or a `release:snapshot` that changes
 *     snapshots/. Needs npm.
 *
 * Run `pnpm build` first: the manifests are read with this build's core.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkRetiredFacts,
  loadCore,
  refreshRetiredFacts,
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
  if (
    !['owners', 'definition', 'check', 'refresh'].includes(command) ||
    (!['check', 'refresh'].includes(command) && !values.release)
  )
    throw new Error(
      'Usage: retired-table-facts.mjs owners --release <release> [--from <dir>] | definition --package <name> --table <table> --release <release> [--from <dir>] | refresh | check [--release <release> [--from <dir>]]',
    );
  if (command === 'refresh') {
    const core = await loadCore(root);
    const summary = refreshRetiredFacts({
      root,
      directory,
      factsFor: (release) =>
        releaseFacts(
          core,
          loadReleaseManifests({ root, release, log: (line) => console.error(line) }),
        ),
      log: (line) => console.error(line),
    });
    console.log(
      `Refreshed owners for ${summary.owners.join(', ') || 'no release'}; removed ${summary.removed.join(', ') || 'none'}; ${summary.definitions.length} declaration(s) updated.`,
    );
  } else if (command === 'check') {
    if (values.from && !values.release)
      throw new Error('check --from needs --release: the directory holds one release.');
    const core = await loadCore(root);
    const failures = checkRetiredFacts({
      root,
      directory,
      releases: values.release ? [values.release] : undefined,
      factsFor: (release) =>
        releaseFacts(
          core,
          loadReleaseManifests({
            root,
            release,
            from: values.release === release ? values.from : undefined,
            log: (line) => console.error(line),
          }),
        ),
    });
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.log(
      `Retired table facts: ${failures.length ? 'FAIL' : 'PASS'} (${failures.length} failure(s))`,
    );
    if (failures.length) process.exitCode = 1;
  } else {
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
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
