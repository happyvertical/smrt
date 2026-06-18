/**
 * i18n catalog guard.
 *
 * The catalog in `src/lib/i18n.ts` is the single source of UI strings routed
 * through `@happyvertical/smrt-svelte/i18n` (sweep S13 #1418). These tests
 * pin its shape: every entry is a `products.`-namespaced key that maps to
 * itself and registers a non-empty English default. This catches typos,
 * accidental empty values, and key/namespace drift at test time rather than
 * in a downstream consumer.
 */

import { getRegisteredDefault } from '@happyvertical/smrt-svelte/i18n';
import { describe, expect, it } from 'vitest';
import { M } from './lib/i18n.js';

describe('products i18n catalog', () => {
  const keys = Object.keys(M);

  it('namespaces every message under "products."', () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith('products.')).toBe(true);
    }
  });

  it('maps each key to itself (defineMessages identity contract)', () => {
    for (const key of keys) {
      expect((M as Record<string, string>)[key]).toBe(key);
    }
  });

  it('registers a non-empty English default for every key', () => {
    for (const key of keys) {
      const def = getRegisteredDefault(key);
      expect(def, `missing default for ${key}`).toBeTruthy();
      expect(typeof def).toBe('string');
      expect((def as string).length).toBeGreaterThan(0);
    }
  });
});
