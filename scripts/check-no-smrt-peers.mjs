#!/usr/bin/env node
/**
 * DAG guardrail (happyvertical/smrt#1582).
 *
 * Fails if any package declares another `@happyvertical/smrt-*` package as a
 * `peerDependency`. Inter-smrt peers are what drove pnpm's per-peer-set physical
 * fan-out — the same package version resolving into multiple incompatible
 * instances — that broke consumer typechecks non-deterministically. With every
 * `@happyvertical/smrt-*` package version-locked, a plain `dependency` dedupes to
 * one instance; a `peerDependency` does not.
 *
 * Use instead:
 *   - a regular `dependency` for a real (value/type) cross-package edge;
 *   - `@crossPackageRef('@happyvertical/smrt-x:Class')` (string-keyed, resolved
 *     at runtime via the ObjectRegistry) for an optional integration that needs
 *     no package edge at all;
 *   - a `devDependency` when only tests touch the other package.
 *
 * Exempt: the `template-*` scaffolds, whose peers describe what the *generated*
 * project must provide (the template itself is not a runtime consumer and is not
 * depended on by other packages, so it cannot fan out).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = join(import.meta.dirname, '..', 'packages');

const EXEMPT = new Set([
  '@happyvertical/smrt-template-site-static-json',
  '@happyvertical/smrt-template-sveltekit',
]);

const violations = [];
for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(PACKAGES, entry.name, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (!pkg.name || EXEMPT.has(pkg.name)) continue;
  const smrtPeers = Object.keys(pkg.peerDependencies ?? {}).filter((k) =>
    k.startsWith('@happyvertical/smrt-'),
  );
  if (smrtPeers.length) violations.push({ pkg: pkg.name, peers: smrtPeers });
}

if (violations.length > 0) {
  console.error(
    '✗ no-smrt-peer-deps: @happyvertical/smrt-* must not be a peerDependency (drives pnpm peer fan-out — #1582).\n',
  );
  for (const { pkg, peers } of violations) {
    console.error(`  ${pkg}:`);
    for (const peer of peers) console.error(`    - ${peer}`);
  }
  console.error(
    '\nUse a regular dependency, a devDependency (test-only), or @crossPackageRef\n' +
      'string refs / registry indirection for optional integrations. Templates are exempt.',
  );
  process.exit(1);
}

console.log(
  '✓ no-smrt-peer-deps: no @happyvertical/smrt-* peerDependencies (template scaffolds exempt).',
);
