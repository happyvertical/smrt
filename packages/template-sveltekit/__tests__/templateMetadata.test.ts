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
  it('pins every directly used s-m-r-t package to 0.38.25', () => {
    const smrtDependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    for (const [name, version] of Object.entries(smrtDependencies)) {
      if (name.startsWith('@happyvertical/smrt-')) {
        expect(version, name).toBe('0.38.25');
      }
    }
  });

  it('ships the CLI directly and keeps browser data opt-in', () => {
    expect(packageJson.devDependencies['@happyvertical/smrt-cli']).toBe(
      '0.38.25',
    );
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
