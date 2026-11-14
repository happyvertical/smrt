import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WRAPPER_DIRS,
  WRAPPER_FILES,
  WRAPPER_PACKAGE_PATHS,
  WRAPPER_SCRIPTS,
  WRAPPER_TOOLS,
} from './constants.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
) as {
  files: string[];
  exports: Record<string, unknown>;
};

/** What `npm pack` would put in the tarball (no scripts, no network, no file). */
function packedPaths(): string[] {
  const out = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '--silent'],
    {
      cwd: packageDir,
      encoding: 'utf8',
      env: { ...process.env, npm_config_loglevel: 'silent' },
    },
  );
  const [pack] = JSON.parse(out) as { files: { path: string }[] }[];
  return (pack?.files ?? []).map((file) => file.path);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('the published package carries the wrapper', () => {
  const paths = packedPaths();

  it('lists exactly the wrapper paths the builder copies in package.json files', () => {
    const listed = manifest.files
      .filter((entry) => entry.startsWith('wrapper/'))
      .map((entry) => entry.slice('wrapper/'.length))
      .sort();
    expect(listed).toEqual([...WRAPPER_PACKAGE_PATHS].sort());
  });

  it('contains every file the builder reads', () => {
    for (const file of [
      ...WRAPPER_FILES,
      ...WRAPPER_SCRIPTS,
      ...WRAPPER_TOOLS,
    ]) {
      expect(paths, file).toContain(`wrapper/${file}`);
    }
    for (const dir of WRAPPER_DIRS) {
      const root = join(packageDir, 'wrapper', dir);
      const sources = walk(root).map(
        (path) => `wrapper/${dir}/${path.slice(root.length + 1)}`,
      );
      expect(sources.length, dir).toBeGreaterThan(0);
      for (const source of sources) expect(paths, source).toContain(source);
    }
  });

  it('never ships build output, tests, signing tools or secret-looking files', () => {
    const wrapperPaths = paths.filter((path) => path.startsWith('wrapper/'));
    expect(wrapperPaths.length).toBeGreaterThan(10);
    for (const path of wrapperPaths) {
      expect(path).not.toMatch(/(^|\/)target\//);
      expect(path).not.toMatch(/(^|\/)tests\//);
      expect(path).not.toMatch(/\.test\.mjs$/);
      expect(path).not.toMatch(/signing-tools/);
      expect(path).not.toMatch(/(^|\/)(binaries|resources|gen)\//);
      expect(path).not.toMatch(/tauri\.release\.json$/);
    }
    for (const path of paths) {
      expect(path).not.toMatch(/(^|\/)\.env/);
      expect(path).not.toMatch(/\.(pem|key|p12|pfx|keychain)$/i);
      expect(path).not.toMatch(/(^|\/)\.npmrc$/);
      expect(path).not.toMatch(/(^|\/)(id_rsa|id_ed25519)/);
    }
  });

  it('ships the builder entry in the exports map', () => {
    expect(manifest.exports['./builder']).toEqual({
      types: './dist/builder.d.ts',
      import: './dist/builder.js',
    });
  });
});
