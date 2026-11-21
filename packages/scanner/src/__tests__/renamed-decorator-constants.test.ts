/**
 * A decorator imported under another name is never trusted as a read-only
 * SMRT call, so a module constant passed to it is reported rather than read.
 * The base scanner read such a constant as an empty config, dropping what it
 * stated; a decorator imported under its own name reads it.
 */

import { describe, expect, it } from 'vitest';
import { parseSource } from '../oxc-parser.js';

const parse = (source: string) => {
  const result = parseSource(source, '/fixture/Account.ts');
  return {
    errors: result.errors.map((error) => error.message),
    config: result.classes[0]?.decoratorConfig,
  };
};

describe('a module constant passed to a decorator', () => {
  it('fails for the model decorator imported under another name, naming the fix', () => {
    const { errors } = parse(
      `import { SmrtObject, smrt as model } from '@happyvertical/smrt-core';\nconst OPTIONS = { api: false };\n@model(OPTIONS)\nexport class Account extends SmrtObject {}\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('OPTIONS');
    expect(errors[0]).toContain('`@model()`');
    expect(errors[0]).toContain('under its own name (`smrt`)');
    expect(errors[0]).toContain('inline');
  });

  it('reads it for the model decorator imported under its own name', () => {
    const { errors, config } = parse(
      `import { SmrtObject, smrt } from '@happyvertical/smrt-core';\nconst OPTIONS = { api: false };\n@smrt(OPTIONS)\nexport class Account extends SmrtObject {}\n`,
    );
    expect(errors).toEqual([]);
    expect(config).toEqual({ api: false });
  });
});
