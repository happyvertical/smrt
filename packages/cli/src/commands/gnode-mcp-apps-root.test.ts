import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ source: {} as any, config: {} as any }));
vi.mock('../loaders/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../loaders/index.js')>()),
  resolveTemplate: async () => fixture.source,
  loadTemplate: async () => fixture.config,
}));
vi.mock('../utils/generator.js', () => ({
  generate: async (_source: any, _config: any, options: any) => {
    mkdirSync(options.outputDir, { recursive: true });
    writeFileSync(
      join(options.outputDir, 'package.json'),
      JSON.stringify({ name: options.name }),
    );
  },
}));

import { gnodeCommands } from './gnode.js';

const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it.each([
  'npm',
  'local',
  'git',
])('uses the real extracted overlay directory for %s', async (type) => {
  const p = mkdtempSync(join(tmpdir(), 'mcp-git-'));
  roots.push(p);
  const extracted = join(p, 'checkout');
  const subdir = join(extracted, 'nested');
  mkdirSync(join(subdir, 'mcp-apps-template/src'), { recursive: true });
  writeFileSync(
    join(subdir, 'mcp-apps-template/package.dependencies.json'),
    '{}',
  );
  fixture.source = {
    type,
    resolved: type === 'git' ? 'github:synthetic/repo/nested' : subdir,
    location: 'synthetic',
  };
  fixture.config = {
    name: 'synthetic',
    __tempDir: extracted,
    __templateRoot: subdir,
  };
  await gnodeCommands['gnode create'].handler(['sample'], {
    outputDir: join(p, 'app'),
    mcpApps: true,
  });
  expect(existsSync(join(p, 'app/mcp-apps/plugin.json'))).toBe(true);
  if (type === 'git') expect(existsSync(extracted)).toBe(false);
});
it('cleans a Git checkout when overlay generation fails', async () => {
  const p = mkdtempSync(join(tmpdir(), 'mcp-git-error-'));
  roots.push(p);
  const extracted = join(p, 'checkout');
  mkdirSync(extracted);
  fixture.source = {
    type: 'git',
    resolved: 'github:synthetic/repo',
    location: 'synthetic',
  };
  fixture.config = {
    name: 'synthetic',
    __tempDir: extracted,
    __templateRoot: extracted,
  };
  await expect(
    gnodeCommands['gnode create'].handler(['sample'], {
      outputDir: join(p, 'app'),
      mcpApps: true,
    }),
  ).rejects.toThrow();
  expect(existsSync(extracted)).toBe(false);
});

it.each([
  'bad_name',
  'a'.repeat(65),
])('rejects invalid plugin identity before generating %s', async (name) => {
  const p = mkdtempSync(join(tmpdir(), 'mcp-name-'));
  roots.push(p);
  await expect(
    gnodeCommands['gnode create'].handler([name], {
      outputDir: join(p, 'app'),
      mcpApps: true,
    }),
  ).rejects.toThrow();
  expect(existsSync(join(p, 'app'))).toBe(false);
});
