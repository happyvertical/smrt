/**
 * Tests for the mcp-advisor validate-smrt-object tool.
 *
 * This handler reads a source file from disk and runs regex-based structural
 * checks. We write representative source files to a temp dir and assert the
 * ValidationResult (errors, className, hasDecorator, fieldCount, strict-mode
 * warnings) plus the read-failure error path.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateSmrtObject } from './validate-smrt-object.js';

describe('mcp-advisor: validateSmrtObject', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'advisor-validate-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, content: string): Promise<string> {
    const filePath = join(dir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  it('validates a well-formed SmrtObject as valid', async () => {
    const filePath = await write(
      'good.ts',
      `import { SmrtObject, smrt } from '@have/smrt';

@smrt()
export class Product extends SmrtObject {
  name = field({ required: true });

  constructor(options = {}) {
    super(options);
  }
}
`,
    );

    const result = await validateSmrtObject({ filePath });
    expect(result.valid).toBe(true);
    expect(result.errors.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(result.className).toBe('Product');
    expect(result.hasDecorator).toBe(true);
    expect(result.hasRequiredMethods).toBe(true);
    expect(result.fieldCount).toBeGreaterThan(0);
  });

  it('flags a missing decorator, missing base class and missing import', async () => {
    const filePath = await write(
      'bad.ts',
      `export class Orphan {
  someMethod() {}
}
`,
    );

    const result = await validateSmrtObject({ filePath });
    expect(result.valid).toBe(false);
    const messages = result.errors.map((e) => e.message);
    expect(messages).toContain('Missing @smrt() decorator');
    expect(messages).toContain(
      'Class must extend SmrtObject or SmrtCollection',
    );
    expect(messages).toContain('Missing import from @smrt/core');
    expect(result.hasDecorator).toBe(false);
  });

  it('errors when a constructor omits super()', async () => {
    const filePath = await write(
      'no-super.ts',
      `import { SmrtObject, smrt } from '@have/smrt';

@smrt()
export class Thing extends SmrtObject {
  value = field();
  constructor(options = {}) {
    this.value = options.value;
  }
}
`,
    );

    const result = await validateSmrtObject({ filePath });
    const messages = result.errors.map((e) => e.message);
    expect(messages).toContain('Constructor must call super()');
    expect(result.valid).toBe(false);
  });

  it('requires _itemClass on a SmrtCollection', async () => {
    const filePath = await write(
      'collection-missing-itemclass.ts',
      `import { SmrtCollection, smrt } from '@have/smrt';

@smrt()
export class ThingCollection extends SmrtCollection {
}
`,
    );

    const result = await validateSmrtObject({ filePath });
    const messages = result.errors.map((e) => e.message);
    expect(messages).toContain(
      'SmrtCollection must define static readonly _itemClass',
    );
  });

  it('accepts a SmrtCollection that declares _itemClass', async () => {
    const filePath = await write(
      'collection-good.ts',
      `import { SmrtCollection, smrt } from '@have/smrt';

@smrt()
export class ThingCollection extends SmrtCollection {
  static readonly _itemClass = Thing;
}
`,
    );

    const result = await validateSmrtObject({ filePath });
    expect(result.valid).toBe(true);
    expect(
      result.errors.some(
        (e) =>
          e.message === 'SmrtCollection must define static readonly _itemClass',
      ),
    ).toBe(false);
  });

  it('warns about a missing constructor and no fields (non-strict)', async () => {
    const filePath = await write(
      'sparse.ts',
      `import { SmrtObject, smrt } from '@have/smrt';

@smrt()
export class Sparse extends SmrtObject {
}
`,
    );

    const result = await validateSmrtObject({ filePath });
    const warnings = result.errors.filter((e) => e.type === 'warning');
    const warningMessages = warnings.map((w) => w.message);
    expect(warningMessages).toContain('No constructor found');
    expect(warningMessages).toContain('No field definitions found');
    // Warnings alone do not make it invalid.
    expect(result.valid).toBe(true);
  });

  it('adds JSDoc and typing warnings in strict mode', async () => {
    const filePath = await write(
      'strict.ts',
      `import { SmrtObject, smrt } from '@have/smrt';

@smrt()
export class StrictTarget extends SmrtObject {
  name = field({ required: true });
  constructor(options = {}) {
    super(options);
  }
}
`,
    );

    const result = await validateSmrtObject({ filePath, strictMode: true });
    const warningMessages = result.errors
      .filter((e) => e.type === 'warning')
      .map((w) => w.message);
    expect(warningMessages).toContain('Missing JSDoc documentation');
    expect(warningMessages).toContain(
      'Properties should have explicit TypeScript types',
    );
  });

  it('returns a structured error when the file cannot be read', async () => {
    const result = await validateSmrtObject({
      filePath: join(dir, 'does-not-exist.ts'),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('error');
    expect(result.errors[0].message).toMatch(/ENOENT|no such file/i);
  });
});
