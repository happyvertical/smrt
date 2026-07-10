import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import templateConfig from '../template.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'template', 'package.json'), 'utf8'),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const itemSource = readFileSync(
  join(__dirname, '..', 'template', 'src', 'lib', 'objects', 'Item.ts'),
  'utf8',
);

describe('generated project metadata', () => {
  it('keeps every directly used s-m-r-t package on one release line', () => {
    const smrtDependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    const smrtVersions = Object.entries(smrtDependencies).filter(([name]) =>
      name.startsWith('@happyvertical/smrt-'),
    );
    const releaseRange = smrtVersions[0]?.[1];

    expect(releaseRange).toMatch(/^\^0\.\d+\.\d+$/);
    for (const [name, version] of smrtVersions) {
      expect(version, name).toBe(releaseRange);
    }
  });

  it('ships the CLI directly and keeps browser data opt-in', () => {
    expect(packageJson.devDependencies).toHaveProperty(
      '@happyvertical/smrt-cli',
    );
    expect(packageJson.dependencies['@happyvertical/smrt-cli']).toBeUndefined();
    expect(packageJson.dependencies['@happyvertical/smrt-web']).toBeUndefined();
  });

  it('keeps gnode metadata aligned with the generated package', () => {
    expect(templateConfig.dependencies).toEqual(packageJson.dependencies);
    expect(templateConfig.devDependencies).toEqual(packageJson.devDependencies);
  });

  it('uses the current migration command rather than deprecated db:setup', () => {
    expect(packageJson.scripts['db:migrate']).toContain('smrt db:migrate');
    expect(JSON.stringify(packageJson)).not.toContain('db:setup');
  });

  it('keeps scanner-visible CRUD actions literal in the decorator', () => {
    expect(itemSource.match(/include: \['list', 'get', 'create', 'update', 'delete'\]/g)).toHaveLength(3);
    expect(itemSource).not.toContain('...CRUD_ACTIONS');
  });

  it('registers an explicit Item collection for generated CLI commands', () => {
    expect(itemSource).toContain(
      'export class ItemCollection extends SmrtCollection<Item>',
    );
    expect(itemSource).toContain(
      "ObjectRegistry.registerCollection('Item', ItemCollection)",
    );
  });
});
