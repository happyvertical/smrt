import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  AGGREGATE_CAP,
  assertPaidRelease,
  LIVE_LEDGER,
  workspaceBuildReceipt,
} from './release.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-build-'));
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
  );
  for (const name of ['ingestion', 'core', 'content']) {
    const dir = join(root, 'packages', name);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist/index.js'), 'export const version = 1;');
    writeFileSync(join(dir, 'dist/public.js'), 'export const publicValue = 1;');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: `@test/${name}`,
        type: 'module',
        exports: { '.': './dist/index.js', './public': './dist/public.js' },
        dependencies:
          name === 'ingestion'
            ? { '@test/content': 'workspace:*' }
            : name === 'content'
              ? { '@test/core': 'workspace:*' }
              : {},
      }),
    );
  }
  for (const [from, to] of [
    ['ingestion', 'content'],
    ['content', 'core'],
  ]) {
    const dir = join(root, 'packages', from, 'node_modules/@test');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(root, 'packages', to), join(dir, to), 'dir');
  }
  return root;
}
function frozen(builtTreeSha256: string, gitHead: string) {
  return {
    gitHead,
    workingTreeClean: true,
    profileStatus: 'frozen-awaiting-release',
    builtTreeSha256,
    ...Object.fromEntries(
      [
        'profileSha256',
        'protocolSha256',
        'manifestSha256',
        'feedbackManifestSha256',
        'sourceTreeSha256',
      ].map((k) => [k, 'a'.repeat(64)]),
    ),
  };
}
test('dependency public build mutation at unchanged Git HEAD denies release before provider or reservation', () => {
  const root = fixture();
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  try {
    const before = workspaceBuildReceipt(root);
    const snapshot = frozen(before.sha256, gitHead);
    const release = {
      ...snapshot,
      allowPaidCalls: true,
      aggregateCapNanoUSD: AGGREGATE_CAP,
      ledgerPath: LIVE_LEDGER,
      startingChargedNanoUSD: 0,
      startingCalls: 0,
    };
    expect(assertPaidRelease(release, snapshot)).toBeTruthy();
    const path = join(root, 'packages/core/dist/public.js');
    const bytes = readFileSync(path);
    writeFileSync(
      path,
      Buffer.concat([
        bytes,
        Buffer.from('\n// changed ignored transitive public export'),
      ]),
    );
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(gitHead);
    const provider = vi.fn(),
      reserve = vi.fn();
    expect(() => {
      assertPaidRelease(
        release,
        frozen(workspaceBuildReceipt(root).sha256, gitHead),
      );
      reserve();
      provider();
    }).toThrow('artifact mismatch');
    expect(reserve).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test.each([
  'missing-export',
  'wrong-workspace-link',
  'symlink-build',
  'unexpected-export',
] as const)('workspace build receipt fails closed for %s', (kind) => {
  const root = fixture();
  try {
    if (kind === 'missing-export')
      rmSync(join(root, 'packages/core/dist/public.js'));
    if (kind === 'wrong-workspace-link') {
      const link = join(root, 'packages/content/node_modules/@test/core');
      rmSync(link);
      symlinkSync(join(root, 'packages/ingestion'), link, 'dir');
    }
    if (kind === 'symlink-build') {
      rmSync(join(root, 'packages/core/dist'), { recursive: true });
      symlinkSync(
        join(root, 'packages/content/dist'),
        join(root, 'packages/core/dist'),
        'dir',
      );
    }
    if (kind === 'unexpected-export') {
      const path = join(root, 'packages/core/package.json');
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      pkg.exports['./escape'] = '../content/dist/index.js';
      writeFileSync(path, JSON.stringify(pkg));
    }
    expect(() => workspaceBuildReceipt(root)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
