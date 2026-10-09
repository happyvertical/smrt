/**
 * Browser reachability gate (#3621, epic #3622).
 *
 * Every model package root entry (every publishable package declaring
 * `@smrt()` objects, plus smrt-core) must build for a browser target over its
 * published-style `dist` exports without reaching Node-only modules (`node:`
 * built-ins, pg, express, cosmiconfig, jiti, ... — see
 * FORBIDDEN_NODE_ONLY_MODULES). Node-only code lives behind a subpath export
 * or a lazy import the browser graph never follows.
 *
 * Packages that still violate the rule are listed in
 * `src/browser-gate/expected-failures.ts` with their tracking issue. The gate
 * fails on an unexpected breakage AND on a stale entry (listed but passing),
 * so each fix PR deletes its own entry. Run `pnpm build` first; in CI turbo's
 * `test` task already depends on `^build`.
 *
 * Findings are attributed to the package that owns the fix (see
 * `attributeFindings`): a defect in smrt-core fails smrt-core, not every
 * package that depends on it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  attributeFindings,
  discoverModelPackages,
  evaluateRatchet,
  type Finding,
  formatOwned,
  type ModelPackage,
} from '../browser-gate/boundary.js';
import { buildPackageForBrowser } from '../browser-gate/build.js';
import { EXPECTED_BROWSER_FAILURES } from '../browser-gate/expected-failures.js';

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

describe('browser reachability of model package roots', () => {
  it('declares every model package as a workspace dependency', () => {
    // Turbo builds `dist` only for declared dependencies (`^build`) and
    // selects this package for changed-package CI runs through them, so the
    // discovered list and package.json must not drift apart.
    const manifest = JSON.parse(
      readFileSync(
        path.resolve(workspaceRoot, 'packages/bundle-gate/package.json'),
        'utf8',
      ),
    ) as { devDependencies: Record<string, string> };
    const missing = discoverModelPackages(workspaceRoot)
      .map((p) => p.name)
      .filter((name) => manifest.devDependencies[name] !== 'workspace:*');
    expect(
      missing,
      `add as "workspace:*" devDependencies of @happyvertical/smrt-bundle-gate: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('matches the expected-failures ratchet', async () => {
    const packages = discoverModelPackages(workspaceRoot);
    expect(packages.length).toBeGreaterThan(20);

    const unbuilt = packages.filter((p) => !existsSync(p.entry));
    expect(
      unbuilt.map((p) => p.name),
      'root entries missing; build the packages first (pnpm build)',
    ).toEqual([]);

    const raw = new Map<string, Finding[]>();
    for (const pkg of packages) {
      raw.set(pkg.name, await buildPackageForBrowser(pkg));
    }
    const owned = attributeFindings(packages, raw);

    const failing = new Set(
      packages.filter((p) => owned.get(p.name)?.length).map((p) => p.name),
    );
    const ratchet = evaluateRatchet(
      failing,
      packages.map((p) => p.name),
      EXPECTED_BROWSER_FAILURES,
    );

    const report = [...failing]
      .map((name) => {
        const expected = EXPECTED_BROWSER_FAILURES[name];
        const tag = expected ? `expected (${expected.issue})` : 'UNEXPECTED';
        // Chains are capped per package; the module list above them is complete.
        const detail = formatOwned(owned.get(name) ?? [], workspaceRoot, 5);
        return `${name} [${tag}]\n${detail}`;
      })
      .join('\n');
    console.info(
      `[browser-gate] ${packages.length} model packages, ${failing.size} failing\n${report}`,
    );

    const problems: string[] = [];
    if (ratchet.unexpected.length) {
      problems.push(
        `Unexpected browser breakage (fix the import chain above; only add a package to the list with a tracking issue): ${ratchet.unexpected.join(', ')}`,
      );
    }
    if (ratchet.stale.length) {
      problems.push(
        `Stale expected-failures entries (now passing; delete them from src/browser-gate/expected-failures.ts): ${ratchet.stale.join(', ')}`,
      );
    }
    if (ratchet.unknown.length) {
      problems.push(
        `Expected-failures entries that are not gated model packages: ${ratchet.unknown.join(', ')}`,
      );
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it("keeps Node-only modules out of core's own browser entry (#2838)", async () => {
    // The ratchet only compares which packages fail, so a core entry that is
    // listed for another reason (missing exports, #3614) would hide a new
    // pg/cosmiconfig/node: edge. Core's own module graph is held to zero.
    const core = discoverModelPackages(workspaceRoot).find(
      (p) => p.name === '@happyvertical/smrt-core',
    );
    expect(core, 'smrt-core is always gated').toBeDefined();
    const findings = await buildPackageForBrowser(core as ModelPackage);
    const reached = findings.filter((f) => f.kind === 'forbidden');
    expect(
      reached.map((f) => (f.kind === 'forbidden' ? f.module : '')),
      "core's browser entry reaches Node-only modules; route them through packages/core/src/host.ts or a lazy host lookup",
    ).toEqual([]);
  });
});
