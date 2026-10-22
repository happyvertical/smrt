import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { describe, expect, it } from 'vitest';
import { presentedFilename } from './sources/common.js';
import { sourcesSuite } from './test-support/sources.js';

describe('presentedFilename (#4214)', () => {
  it('keeps a plain name and trims it', () => {
    expect(presentedFilename('  Acme March.pdf ')).toBe('Acme March.pdf');
  });
  it('removes control characters instead of failing the receipt', () => {
    expect(presentedFilename('Acme\u0000 March\n.pdf\u007f')).toBe(
      'Acme March.pdf',
    );
  });
  it('drops names that are not text, empty after cleaning, or too long', () => {
    expect(presentedFilename(undefined)).toBeUndefined();
    expect(presentedFilename(42)).toBeUndefined();
    expect(presentedFilename(' \t\r\n ')).toBeUndefined();
    expect(presentedFilename('a'.repeat(513))).toBeUndefined();
    expect(presentedFilename('a'.repeat(512))).toBe('a'.repeat(512));
  });
});

@smrt({ api: false, cli: false, mcp: false })
class SourceTestWorker extends SmrtObject {
  @backgroundEligible()
  async process(): Promise<void> {}
}
sourcesSuite('sqlite', 'SourceTestWorker');
