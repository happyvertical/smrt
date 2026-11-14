import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Reuse the published-dist browser gate in plain Node, outside the ORM suite's
// source aliases, while keeping the regression in the owning package's suite.
describe('preferences browser import boundary', () => {
  it('keeps the root browser-safe when registering cookbook permissions', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const boundary = new URL(
      '../../../bundle-gate/src/browser-gate/boundary.ts',
      import.meta.url,
    ).href;
    const builder = new URL(
      '../../../bundle-gate/src/browser-gate/build.ts',
      import.meta.url,
    ).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { attributeFindings, discoverModelPackages } = await import(${JSON.stringify(boundary)});
      const { buildPackageForBrowser } = await import(${JSON.stringify(builder)});
      const packages = discoverModelPackages(${JSON.stringify(root)});
      const pkg = packages.find(entry => entry.name === '@happyvertical/smrt-preferences');
      if (!pkg) throw new Error('Preferences must be a gated model package');
      const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'));
      const roots = packages.filter(entry => entry === pkg || entry.name in manifest.dependencies);
      const raw = new Map();
      for (const entry of roots) raw.set(entry.name, await buildPackageForBrowser(entry));
      // Attribute dependency defects exactly as the repository ratchet does.
      console.log(JSON.stringify(attributeFindings(packages, raw).get(pkg.name)));
    `,
      ],
      { cwd: root },
    );
    expect(JSON.parse(stdout)).toEqual([]);
  });
});
