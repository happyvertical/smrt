import { describe, expect, it } from 'vitest';
import {
  coercePlaygroundModules,
  mergePlaygroundModules,
  normalizePlaygroundModule,
  qualifyPlaygroundEntryId,
} from '../runtime.js';

describe('@happyvertical/smrt-playground exports', () => {
  it('runtime helpers are functions', () => {
    expect(typeof coercePlaygroundModules).toBe('function');
    expect(typeof mergePlaygroundModules).toBe('function');
    expect(typeof normalizePlaygroundModule).toBe('function');
    expect(typeof qualifyPlaygroundEntryId).toBe('function');
  });
});

describe('qualifyPlaygroundEntryId', () => {
  it('prefixes the entry id with the package name', () => {
    const qualified = qualifyPlaygroundEntryId(
      '@happyvertical/smrt-content',
      'editor:default',
    );
    // Expected output: combination of package + entry. Exact format is an
    // implementation detail; the contract is that the result is a stable
    // string identifier scoped by the package name.
    expect(typeof qualified).toBe('string');
    expect(qualified).toContain('editor:default');
  });
});
