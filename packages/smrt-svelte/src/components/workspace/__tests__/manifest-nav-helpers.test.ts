/**
 * Unit tests for manifest-nav string helpers (coverage uplift, S6 gate).
 */
import { describe, expect, it } from 'vitest';
import { pluralizeClassName } from '../manifest-nav';

describe('pluralizeClassName', () => {
  it('pluralizes consonant+y → ies', () => {
    expect(pluralizeClassName('Category')).toBe('Categories');
  });

  it('pluralizes s/x/z/ch/sh → es', () => {
    expect(pluralizeClassName('Box')).toBe('Boxes');
    expect(pluralizeClassName('Dish')).toBe('Dishes');
  });

  it('adds plain s otherwise', () => {
    expect(pluralizeClassName('User')).toBe('Users');
  });

  it('passes through already-plural names', () => {
    expect(pluralizeClassName('Categories')).toBe('Categories');
    expect(pluralizeClassName('Users')).toBe('Users');
  });

  it('returns empty input unchanged', () => {
    expect(pluralizeClassName('')).toBe('');
  });
});
