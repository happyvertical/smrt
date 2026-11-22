/**
 * A module constant passed as a class decorator's whole argument is never
 * read: the scan fails and says to write the options inline. The base
 * scanner read it as an empty config, dropping what it stated.
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

describe('a module constant passed as a decorator whole argument', () => {
  it.each([
    ['smrt as model', '@model(OPTIONS)'],
    ['smrt', '@smrt(OPTIONS)'],
  ])('fails for the model decorator imported as %s, naming the fix', (binding, decorator) => {
    const { errors } = parse(
      `import { SmrtObject, ${binding} } from '@happyvertical/smrt-core';\nconst OPTIONS = { api: false };\n${decorator}\nexport class Account extends SmrtObject {}\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('OPTIONS');
    expect(errors[0]).toContain('write the options inline');
  });
});
