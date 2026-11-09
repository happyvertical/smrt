import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkOkfBundleFreshness,
  compareVersions,
  readFrontmatterScalar,
  stampPackageVersion,
} from './okf-bundle.js';

let root: string;

function installed(name: string, version: string, shipsPage = false): void {
  const dir = join(root, 'node_modules', '@happyvertical', name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@happyvertical/${name}`, version }),
  );
  if (shipsPage) writeFileSync(join(dir, 'dist', 'smrt-knowledge.okf.md'), 'x');
}

function bundle(stamped: string, exportedAt: string, name = 'smrt-jobs'): void {
  const dir = join(root, '.agents', 'smrt-knowledge');
  mkdirSync(join(dir, 'components'), { recursive: true });
  writeFileSync(
    join(dir, 'components', `${name}.md`),
    `---\ntype: "Component"\npackage_version: "${stamped}"\n---\n\n# page\n`,
  );
  writeFileSync(
    join(dir, 'bundle.json'),
    JSON.stringify({
      format: 'smrt-okf-bundle/1',
      exportedBy: 'smrt docs:agents',
      exportedAt,
      contentHash: 'sha256:x',
      packages: [
        {
          name: `@happyvertical/${name}`,
          version: stamped,
          concept: `/components/${name}.md`,
        },
      ],
      intents: ['background-work'],
    }),
  );
}

const NOW = new Date('2026-11-05T12:00:00Z');

describe('okf bundle frontmatter helpers', () => {
  it('reads and re-stamps package_version without touching other fields', () => {
    const quoted =
      '---\ntitle: "x"\npackage_version: "1.0.0"\nz: 1\n---\nbody 1.0.0\n';
    expect(readFrontmatterScalar(quoted, 'package_version')).toBe('1.0.0');
    expect(stampPackageVersion(quoted, '2.0.0')).toBe(
      '---\ntitle: "x"\npackage_version: "2.0.0"\nz: 1\n---\nbody 1.0.0\n',
    );
    const bare = '---\npackage_version: 1.0.0\n---\n';
    expect(stampPackageVersion(bare, '2.0.0')).toBe(
      '---\npackage_version: 2.0.0\n---\n',
    );
    const missing = '---\ntitle: x\n---\nbody';
    expect(readFrontmatterScalar(missing, 'package_version')).toBeUndefined();
    expect(stampPackageVersion(missing, '2.0.0')).toContain(
      'package_version: "2.0.0"',
    );
  });
});

describe('checkOkfBundleFreshness (#4689)', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'okf-bundle-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('yields nothing when no bundle was exported', () => {
    installed('smrt-jobs', '1.0.0', true);
    expect(checkOkfBundleFreshness(root, { now: NOW })).toEqual([]);
  });

  it('reports the age of a fresh bundle as info and raises no drift', () => {
    installed('smrt-jobs', '1.0.0', true);
    bundle('1.0.0', '2026-11-02T12:00:00Z');
    const issues = checkOkfBundleFreshness(root, { now: NOW });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'info',
      code: 'okf-bundle-age',
    });
    expect(issues[0].message).toContain('3 day(s) old');
  });

  it('warns when the bundle is older than the age limit', () => {
    installed('smrt-jobs', '1.0.0', true);
    bundle('1.0.0', '2026-01-01T00:00:00Z');
    const issues = checkOkfBundleFreshness(root, { now: NOW });
    expect(issues.map((issue) => issue.code)).toEqual(['okf-bundle-aged']);
    expect(issues[0].severity).toBe('warning');
  });

  it('flags the bundle after a dependency bump until docs:agents reruns', () => {
    installed('smrt-jobs', '1.1.0', true);
    bundle('1.0.0', '2026-11-04T12:00:00Z');
    const drift = checkOkfBundleFreshness(root, { now: NOW }).filter(
      (issue) => issue.code === 'stale-okf-bundle',
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain('stamped 1.0.0 but 1.1.0 is installed');
    expect(drift[0].packageName).toBe('@happyvertical/smrt-jobs');

    // docs:agents rerun re-stamps the page and manifest: drift clears.
    bundle('1.1.0', '2026-11-05T11:00:00Z');
    expect(
      checkOkfBundleFreshness(root, { now: NOW }).filter(
        (issue) => issue.code === 'stale-okf-bundle',
      ),
    ).toEqual([]);
  });

  it('flags a removed package and a newly installed package that ships a page', () => {
    bundle('1.0.0', '2026-11-04T12:00:00Z');
    installed('smrt-content', '1.0.0', true);
    const messages = checkOkfBundleFreshness(root, { now: NOW })
      .filter((issue) => issue.code === 'stale-okf-bundle')
      .map((issue) => issue.message);
    expect(messages).toHaveLength(2);
    expect(messages.join('\n')).toContain('no longer installed');
    expect(messages.join('\n')).toContain('smrt-content is installed');
  });

  it('flags an exported page that was deleted', () => {
    installed('smrt-jobs', '1.0.0', true);
    bundle('1.0.0', '2026-11-04T12:00:00Z');
    rmSync(
      join(root, '.agents', 'smrt-knowledge', 'components', 'smrt-jobs.md'),
    );
    const codes = checkOkfBundleFreshness(root, { now: NOW }).map(
      (issue) => issue.code,
    );
    expect(codes).toContain('stale-okf-bundle');
  });
});

describe('workspace install roots', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'okf-bundle-ws-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('orders semver with prereleases below their release', () => {
    const sorted = [
      '1.10.0',
      '1.2.0',
      '1.2.0-beta.2',
      '1.2.0-beta.10',
      '0.9.9',
    ].sort(compareVersions);
    expect(sorted).toEqual([
      '0.9.9',
      '1.2.0-beta.2',
      '1.2.0-beta.10',
      '1.2.0',
      '1.10.0',
    ]);
  });

  it('resolves the highest member version and member-only packages', () => {
    const member = join(root, 'apps', 'a');
    const dir = join(member, 'node_modules', '@happyvertical', 'smrt-jobs');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@happyvertical/smrt-jobs', version: '1.2.0' }),
    );
    writeFileSync(join(dir, 'dist', 'smrt-knowledge.okf.md'), 'x');
    bundle('1.2.0', '2026-11-04T12:00:00Z');

    const rootOnly = checkOkfBundleFreshness(root, { now: NOW }).filter(
      (issue) => issue.code === 'stale-okf-bundle',
    );
    expect(rootOnly).toHaveLength(1);

    const withMembers = checkOkfBundleFreshness(root, {
      now: NOW,
      installRoots: [root, member],
    }).filter((issue) => issue.code === 'stale-okf-bundle');
    expect(withMembers).toEqual([]);
  });
});
