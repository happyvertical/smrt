/**
 * A package's modules export each model only under its own class name: no
 * module puts another binding (a renamed class, a different class of that
 * name, another package's class) under a model's name. A dependent imports a
 * model by its name from the package, and generation confirms that name
 * against the package's manifest, so the binding behind it must be the model.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OxcScanner } from '../scanner.js';

const PACKAGE = '@fixture/vendor-events';
const CORE = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';`;
const EVENT = `${CORE}\n@smrt({ tableStrategy: 'sti' })\nexport class Event extends SmrtObject {\n  title = '';\n}\n`;
const RESTRICTED = `${CORE}\n@smrt({ api: false })\nexport class RestrictedEvent extends SmrtObject {\n  secret = '';\n}\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function scanPackage(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-provider-exports-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({
      name: PACKAGE,
      dependencies: { '@fixture/other': '*' },
    }),
    ...files,
  };
  for (const [path, source] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  const { results } = await new OxcScanner({
    cwd: root,
    include: ['src/**/*.ts'],
  }).scanAndResolve();
  return results.errors.filter((e) => e.severity === 'error');
}

describe('provider export names', () => {
  it("rejects a module that exports another class under a model's name", async () => {
    const errors = await scanPackage({
      'src/models/Event.ts': EVENT,
      'src/private.ts': RESTRICTED,
      'src/index.ts': `export { RestrictedEvent as Event } from './private';\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain('index.ts');
    expect(errors[0].message).toContain('exports `Event`');
    expect(errors[0].message).toContain('RestrictedEvent');
    expect(errors[0].message).toContain(
      'Export each model under its own class name',
    );
  });

  it('allows renaming to a name no model has', async () => {
    const errors = await scanPackage({
      'src/models/Event.ts': EVENT,
      'src/private.ts': RESTRICTED,
      'src/index.ts': `export { RestrictedEvent as SharedRestrictedEvent } from './private';\n`,
    });

    expect(errors).toEqual([]);
  });

  it("rejects another package's class re-exported under a model's name", async () => {
    const errors = await scanPackage({
      'src/models/Event.ts': EVENT,
      'src/compat.ts': `export { Event } from '@fixture/other';\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain('compat.ts');
    expect(errors[0].message).toContain(
      "re-exported from the package '@fixture/other'",
    );
  });

  it("rejects a barrel that exports a plain class under a model's name", async () => {
    const errors = await scanPackage({
      'src/models/Event.ts': EVENT,
      'src/legacy/Event.ts': `export class Event {\n  helperOnly = '';\n}\n`,
      'src/index.ts': `export { Event } from './legacy/Event';\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain(join('src', 'index.ts'));
    expect(errors[0].message).toContain('legacy');
  });

  it('accepts a barrel that re-exports the model itself, beside a helper that declares its own class of that name', async () => {
    const errors = await scanPackage({
      'src/models/Event.ts': EVENT,
      'src/models/index.ts': `export * from './Event';\n`,
      'src/index.ts': `export { Event } from './models';\n`,
      'src/pdf/Event.ts': `export class Event {\n  render() { return ''; }\n}\n`,
    });

    expect(errors).toEqual([]);
  });

  it('applies to an app scan: a file renaming a class to a model of the app', async () => {
    const errors = await scanPackage({
      'src/models/Event.ts': EVENT,
      'src/models/helpers.ts': `${CORE}\nclass Event {}\n@smrt()\nexport class Other extends SmrtObject {}\nexport { Other as Event };\nexport const keep = Event;\n`,
    });

    expect(errors.map((e) => e.message).join('\n')).toContain(
      'it is the class Other',
    );
  });
});
