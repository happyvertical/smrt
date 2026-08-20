import { describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../index.js';

describe('system-table bootstrap public surface (#2429)', () => {
  it('exports the canonical provisioning boundary from smrt-core', () => {
    expect(ensureSystemTables).toBeTypeOf('function');
  });
});
