import { describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';

function scan(exports: string) {
  const result = parseSource(
    `
    import { smrt } from '@happyvertical/smrt-core';
    import { Customer as CustomerBase } from '@fixture/upstream';
    @smrt({})
    export class AppCustomer extends CustomerBase {}
    ${exports}
  `,
    '/app/src/customer.ts',
  );
  expect(result.errors).toEqual([]);
  const resolver = new InheritanceResolver();
  resolver.addClasses(result.classes);
  return new ManifestAdapter().toManifest(resolver.resolveAll(), {
    packageName: '@fixture/app',
  }).objects['@fixture/app:AppCustomer'];
}

describe('same-name replacement exports', () => {
  it('retains the public export separately from the source constructor name', () => {
    expect(scan('export { AppCustomer as Customer };')).toMatchObject({
      className: 'AppCustomer',
      exportName: 'Customer',
      extendsQualified: '@fixture/upstream:Customer',
    });
  });
  it.each([
    '',
    'export { AppCustomer as SpecialCustomer };',
    "export { AppCustomer as Customer } from './other';",
    'export type { AppCustomer as Customer };',
    'export { type AppCustomer as Customer };',
  ])('keeps other exports unchanged: %s', (exports) => {
    expect(scan(exports).exportName).toBe('AppCustomer');
  });
});
