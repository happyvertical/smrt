/**
 * #4936: `harden-smrt-class` suggests a same-named subclass with field
 * overrides, writes it only when asked, and has no path to a database.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harden, hardenSmrtClass } from './harden-smrt-class.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harden-4936-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An installed package whose manifest has the class. */
function installParent(
  fields: Record<string, { type: string; required?: boolean; _meta?: object }>,
) {
  const pkg = join(dir, 'node_modules', '@test4936', 'crm', 'dist');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'manifest.json'),
    JSON.stringify({
      objects: { '@test4936/crm:Customer': { className: 'Customer', fields } },
    }),
  );
}

const base = {
  className: 'Customer',
  importFrom: '@test4936/crm',
};

describe('harden-smrt-class suggestion', () => {
  it('returns a same-named subclass and writes nothing by default', () => {
    const result = harden({
      ...base,
      directory: dir,
      overrides: [
        { name: 'phone', type: 'text', required: true, maxLength: 20 },
      ],
    });
    expect(result.written).toBe(false);
    expect(result.source).toContain(
      "import { Customer as SmrtCustomer } from '@test4936/crm';",
    );
    expect(result.source).toContain(
      'export class Customer extends SmrtCustomer {',
    );
    expect(result.source).toContain(
      "@field({ required: true, maxLength: 20 })\n  override phone: string = '';",
    );
    expect(existsSync(join(dir, 'src'))).toBe(false);
  });

  it('is what the tool returns as JSON', async () => {
    const json = JSON.parse(
      await hardenSmrtClass({
        ...base,
        directory: dir,
        overrides: [{ name: 'phone', type: 'text' }],
      }),
    );
    expect(json.path).toBe(join('src', 'models', 'Customer.ts'));
    expect(json.next.join(' ')).toContain('smrt db:migrate');
  });

  it('reads the type and checks the name from the installed manifest', () => {
    installParent({ phone: { type: 'text' }, visits: { type: 'integer' } });
    const result = harden({
      ...base,
      directory: dir,
      overrides: [{ name: 'visits' }],
    });
    expect(result.source).toContain('override visits: number = 0;');
    expect(result.notes).toEqual([]);
    expect(() =>
      harden({
        ...base,
        directory: dir,
        overrides: [{ name: 'nope', type: 'text' }],
      }),
    ).toThrowError(/Customer has no field "nope"/);
  });

  it('refuses to loosen a field smrt needs, naming class and field', () => {
    installParent({
      state: {
        type: 'text',
        required: true,
        _meta: { requiredFor: 'workflow-state' },
      },
      note: { type: 'text', required: true },
    });
    expect(() =>
      harden({
        ...base,
        directory: dir,
        overrides: [{ name: 'state', required: false }],
      }),
    ).toThrowError(/Customer\.state cannot be made optional.*workflow-state/);
    // Any other field may go either way.
    expect(
      harden({
        ...base,
        directory: dir,
        overrides: [{ name: 'note', required: false }],
      }).source,
    ).toContain('required: false');
  });

  it('says so when it could not read the package, and needs a type then', () => {
    const result = harden({
      ...base,
      directory: dir,
      overrides: [{ name: 'phone', type: 'text' }],
    });
    expect(result.notes[0]).toContain('Could not read');
    expect(() =>
      harden({ ...base, directory: dir, overrides: [{ name: 'phone' }] }),
    ).toThrowError(/give a type/);
  });

  it('rejects names that are not names', () => {
    for (const overrides of [
      [{ name: 'a b', type: 'text' as const }],
      [
        { name: 'x', type: 'text' as const },
        { name: 'x', type: 'text' as const },
      ],
      [],
    ]) {
      expect(() => harden({ ...base, directory: dir, overrides })).toThrow();
    }
    expect(() =>
      harden({
        className: 'Bad Name',
        importFrom: '@test4936/crm',
        directory: dir,
        overrides: [{ name: 'x', type: 'text' }],
      }),
    ).toThrow();
    expect(() =>
      harden({
        className: 'Customer',
        importFrom: "x'; drop",
        directory: dir,
        overrides: [{ name: 'x', type: 'text' }],
      }),
    ).toThrow();
  });
});

describe('harden-smrt-class writing', () => {
  const args = () => ({
    ...base,
    directory: dir,
    write: true,
    overrides: [{ name: 'phone', type: 'text' as const }],
  });

  it('writes the file once and never overwrites', () => {
    const result = harden(args());
    expect(result.written).toBe(true);
    const file = join(dir, 'src', 'models', 'Customer.ts');
    expect(readFileSync(file, 'utf-8')).toBe(result.source);
    writeFileSync(file, '// mine\n');
    expect(() => harden(args())).toThrowError(/already exists/);
    expect(readFileSync(file, 'utf-8')).toBe('// mine\n');
  });

  it('keeps the file inside the project directory', () => {
    for (const outputPath of [
      '../escape.ts',
      '/tmp/escape.ts',
      'a/../../x.ts',
    ]) {
      expect(() => harden({ ...args(), outputPath })).toThrowError(
        /inside the project directory/,
      );
    }
  });
});

describe('harden-smrt-class and the database', () => {
  it('has no database client, no SQL, and no function that builds either', () => {
    const source = readFileSync(
      new URL('./harden-smrt-class.ts', import.meta.url),
      'utf-8',
    );
    const imports = [...source.matchAll(/^import[^;]*? from '([^']+)'/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(['node:fs', 'node:path']);
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const word of [
      /\bCREATE\b/,
      /\bALTER\b/,
      /\bDROP\b/,
      /\bINSERT\b/,
      /\bUPDATE\b/,
      /\bDELETE\b/,
      /\bgetDatabase\b/,
      /\.query\(/,
      /\bexecute\(/,
      /child_process/,
    ]) {
      expect(code, String(word)).not.toMatch(word);
    }
  });
});

describe('harden-smrt-class output is a subclass the build accepts', () => {
  it('scans as a same-named subclass of the package class with the field stated required', async () => {
    const result = harden({
      ...base,
      directory: dir,
      write: true,
      overrides: [{ name: 'phone', type: 'text', required: true }],
    });
    const scanner = new OxcScanner({
      cwd: dir,
      include: ['src/**/*.ts'],
      exclude: [],
    });
    const { resolved } = await scanner.scanAndResolve();
    const manifest = new ManifestAdapter().toManifest(
      resolved.filter((c) => c.hasSmartDecorator),
      { packageName: '@test4936/app', packageVersion: '1.0.0' },
    ) as {
      objects: Record<
        string,
        {
          className: string;
          extends?: string;
          extendsQualified?: string;
          fields: Record<
            string,
            {
              type: string;
              required?: boolean;
              _meta?: { __statedOptions?: string[] };
            }
          >;
        }
      >;
    };
    const objects = Object.values(manifest.objects);
    expect(objects).toHaveLength(1);
    const [customer] = objects;
    expect(customer.className).toBe('Customer');
    expect(customer.extendsQualified).toBe('@test4936/crm:Customer');
    expect(customer.fields.phone).toMatchObject({
      type: 'text',
      required: true,
    });
    expect(customer.fields.phone._meta?.__statedOptions).toContain('required');
    expect(result.written).toBe(true);
  });
});
