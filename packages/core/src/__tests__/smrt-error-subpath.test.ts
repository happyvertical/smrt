/**
 * `./smrt-error` (#4100) publishes the one `SmrtError` class on a module with
 * no imports, for browser-safe code (smrt-reports' `./spec`) to extend without
 * reaching the root entry's registry. It must stay the same class the root
 * exports and stay import-free.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SmrtError as fromErrors, ValidationError } from '../errors.js';
import { SmrtError } from '../smrt-error.js';

describe('smrt-core/smrt-error', () => {
  it('is the class errors.ts (and so the root entry) exports', () => {
    expect(fromErrors).toBe(SmrtError);
    expect(ValidationError.requiredField('a', 'B')).toBeInstanceOf(SmrtError);
  });

  it('imports nothing', () => {
    const source = readFileSync(
      new URL('../smrt-error.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/^\s*(import|export\s[^;]*\sfrom)\s/m);
  });

  it('is published as a subpath', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, { import?: string }> };
    expect(pkg.exports['./smrt-error']?.import).toBe('./dist/smrt-error.js');
  });
});
