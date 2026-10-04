import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureMcpAppsConsumerRegistry,
  scaffoldMcpAppsPackage,
  validateMcpAppsPackage,
} from './mcp-apps-packaging.js';

const roots: string[] = [];
function root() {
  const p = mkdtempSync(join(tmpdir(), 'mcp-review-'));
  roots.push(p);
  return p;
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
  vi.restoreAllMocks();
});
describe('accepted publication regressions', () => {
  it('rejects closed official schema violations', () => {
    const p = root();
    scaffoldMcpAppsPackage(p, 'example');
    const file = join(p, 'plugin.json');
    const plugin = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(
      file,
      JSON.stringify({ ...plugin, name: 'bad_name', unknown: true }),
    );
    expect(validateMcpAppsPackage(p).valid).toBe(false);
  });
  it('checks every registry directive and accepts inline comments', () => {
    const p = root();
    // pnpm reads this fixture's .npmrc as project config when it has a package.
    writeFileSync(join(p, 'package.json'), '{"name":"mcp-review-fixture"}');
    writeFileSync(
      join(p, '.npmrc'),
      '@happyvertical:registry=https://npm.happyvertical.com/\n@happyvertical:registry=https://other.invalid/\n',
    );
    expect(() => configureMcpAppsConsumerRegistry(p)).toThrow();
    for (const comment of ['# comment', '; comment']) {
      writeFileSync(
        join(p, '.npmrc'),
        `@happyvertical:registry=https://npm.happyvertical.com/ ${comment}\n`,
      );
      expect(() => configureMcpAppsConsumerRegistry(p)).not.toThrow();
      expect(
        execFileSync('pnpm', ['config', 'get', '@happyvertical:registry'], {
          cwd: p,
          encoding: 'utf8',
        }).trim(),
      ).toBe('https://npm.happyvertical.com/');
    }
  });
  it('release producer detects and updates the optional dependency map', () => {
    const p = root();
    mkdirSync(join(p, 'scripts'));
    mkdirSync(join(p, 'packages/core'), { recursive: true });
    mkdirSync(join(p, 'packages/template-sveltekit/template'), {
      recursive: true,
    });
    mkdirSync(join(p, 'packages/template-sveltekit/mcp-apps-template'));
    cpSync(
      resolve('../../scripts/sync-template-versions.mjs'),
      join(p, 'scripts/sync-template-versions.mjs'),
    );
    writeFileSync(
      join(p, 'packages/core/package.json'),
      JSON.stringify({ version: '9.2.3' }),
    );
    writeFileSync(
      join(p, 'packages/template-sveltekit/template/package.json'),
      JSON.stringify({
        dependencies: { '@happyvertical/smrt-core': '^9.2.3' },
      }),
    );
    const f = join(
      p,
      'packages/template-sveltekit/mcp-apps-template/package.dependencies.json',
    );
    writeFileSync(
      f,
      JSON.stringify({ '@happyvertical/smrt-app-mcp': '^0.51.36' }),
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [join(p, 'scripts/sync-template-versions.mjs'), '--check'],
        { stdio: 'pipe' },
      ),
    ).toThrow();
    execFileSync(process.execPath, [
      join(p, 'scripts/sync-template-versions.mjs'),
    ]);
    expect(
      JSON.parse(readFileSync(f, 'utf8'))['@happyvertical/smrt-app-mcp'],
    ).toBe('^9.2.3');
    execFileSync(process.execPath, [
      join(p, 'scripts/sync-template-versions.mjs'),
      '--check',
    ]);
  });
  it.each([
    'bad_name',
    'a'.repeat(65),
    'double--hyphen',
    'trailing-',
  ])('rejects invalid official name %s before writing', (name) => {
    const p = root();
    expect(() => scaffoldMcpAppsPackage(join(p, 'new'), name)).toThrow();
    expect(() => readFileSync(join(p, 'new/plugin.json'))).toThrow();
  });
  it('accepts canonical optional schema fields and rejects transport/ref violations without leaking values', () => {
    const p = root();
    scaffoldMcpAppsPackage(p, 'valid.name-1');
    const f = join(p, 'plugin.json');
    const plugin = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(
      f,
      JSON.stringify({
        ...plugin,
        author: {
          name: 'Author',
          email: 'author@example.invalid',
          url: 'https://example.invalid',
        },
        homepage: 'https://example.invalid',
        repository: 'https://example.invalid/repo',
        license: 'MIT',
        keywords: ['test'],
        extensions: { 'org.example': { custom: true } },
      }),
    );
    const m = join(p, 'mcp.json');
    const mcp = JSON.parse(readFileSync(m, 'utf8'));
    mcp.mcpServers.smrt.headers = { 'X-Mode': 'test' };
    writeFileSync(m, JSON.stringify(mcp));
    expect(validateMcpAppsPackage(p).valid).toBe(true);
    for (const patch of [
      { unknown: 'sensitive-value' },
      { headers: { bad: 42 } },
      { command: 'not-http' },
    ]) {
      writeFileSync(
        m,
        JSON.stringify({
          ...mcp,
          mcpServers: { smrt: { ...mcp.mcpServers.smrt, ...patch } },
        }),
      );
      const result = validateMcpAppsPackage(p);
      expect(result.valid).toBe(false);
      expect(JSON.stringify(result)).not.toContain('sensitive-value');
    }
  });
  it.each([
    '@happyvertical:registry',
    '@happyvertical:registry =',
    '@happyvertical:registry=https://npm.happyvertical.com/ trailing',
    '@happyvertical:registry="https://npm.happyvertical.com/"',
  ])('rejects malformed registry declaration %s', (line) => {
    const p = root();
    writeFileSync(
      join(p, '.npmrc'),
      '@happyvertical:registry=https://npm.happyvertical.com/\n' + line + '\n',
    );
    expect(() => configureMcpAppsConsumerRegistry(p)).toThrow();
  });
});
