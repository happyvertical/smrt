import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// These packages have no verify:pack script. Match the publish validator's
// real pnpm-pack boundary, including ordinary lifecycle hooks, rather than
// counting only packages that expose a convenience verification script.
for (const directory of ['template-sveltekit', 'template-site-static-json']) {
  test(`real pnpm pack validates ${directory} scaffold resources and runtime exports`, () => {
    const output = mkdtempSync(join(tmpdir(), 'smrt-template-pack-'));
    try {
      const packageDir = join(repoRoot, 'packages', directory);
      const packed = spawnSync('pnpm', ['pack', '--pack-destination', output], {
        cwd: packageDir,
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.equal(packed.status, 0, `${packed.error ?? ''}\n${packed.stdout}${packed.stderr}`);
      const tarballs = readdirSync(output).filter((file) => file.endsWith('.tgz'));
      assert.equal(tarballs.length, 1);
      const verified = spawnSync(process.execPath, [
        join(repoRoot, 'scripts/verify-package-types-exports.js'),
        packageDir,
        '--tarball',
        join(output, tarballs[0]),
      ], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
      assert.equal(verified.status, 0, `${verified.error ?? ''}\n${verified.stdout}${verified.stderr}`);
      assert.match(verified.stdout, /Verified packed exports/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
}
