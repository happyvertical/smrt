import { describe, expect, it } from 'vitest';
import {
  calculateLevel,
  generateUniqueSlug,
  hasCircularReference,
  sanitizeSlug,
  Tag,
  TagAlias,
  TagAliasCollection,
  TagCollection,
  validateSlug,
} from '../index.js';

describe('@happyvertical/smrt-tags exports', () => {
  it('exports Tag and TagAlias model classes', () => {
    expect(typeof Tag).toBe('function');
    expect(typeof TagAlias).toBe('function');
  });

  it('exports TagCollection and TagAliasCollection', () => {
    expect(typeof TagCollection).toBe('function');
    expect(typeof TagAliasCollection).toBe('function');
  });

  it('exports slug utilities', () => {
    expect(typeof sanitizeSlug).toBe('function');
    expect(typeof validateSlug).toBe('function');
    expect(typeof generateUniqueSlug).toBe('function');
    expect(typeof calculateLevel).toBe('function');
    expect(typeof hasCircularReference).toBe('function');
  });
});

describe('sanitizeSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(sanitizeSlug('Hello World')).toBe('hello-world');
  });

  it('strips non-ASCII and non-alphanumeric characters', () => {
    // Implementation drops non-[a-z0-9-] including diacritics. Latinizing
    // accented characters is intentionally not done.
    expect(sanitizeSlug('Café au lait!')).toBe('caf-au-lait');
  });

  it('collapses repeated hyphens', () => {
    expect(sanitizeSlug('foo  --  bar')).toBe('foo-bar');
  });
});

describe('validateSlug', () => {
  it('accepts lowercase alphanumeric and hyphens', () => {
    expect(validateSlug('foo-bar-123')).toBe(true);
  });

  it('rejects uppercase and spaces', () => {
    expect(validateSlug('Foo Bar')).toBe(false);
  });
});
