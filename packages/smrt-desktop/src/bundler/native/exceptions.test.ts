import { describe, expect, it } from 'vitest';
import { matchesException } from './exceptions.js';

describe('matchesException', () => {
  const cases: [string, string, boolean][] = [
    ['a/b.node', 'a/b.node', true],
    ['a/b.node', 'a/c.node', false],
    ['a/*.node', 'a/b.node', true],
    ['a/*.node', 'a/b/c.node', false],
    ['a/**/c.node', 'a/c.node', true],
    ['a/**/c.node', 'a/x/y/c.node', true],
    ['a/**/c.node', 'b/x/c.node', false],
    ['**/prebuilds/*/*.node', 'n/p/prebuilds/linux-x64/x.node', true],
    ['**/prebuilds/*/*.node', 'prebuilds/linux-x64/x.node', true],
    ['a/*b*c*', 'a/xxbxxcxx', true],
    ['a/*b*c*', 'a/xxcxxbxx', false],
    ['a/**/**/x', 'a/x', true],
    ['a/b', 'a/b/c', false],
    ['a/b/c', 'a/b', false],
  ];
  it.each(cases)('%s vs %s -> %s', (pattern, path, expected) => {
    expect(matchesException(pattern, path)).toBe(expected);
  });

  it('is linear enough for adversarial patterns', () => {
    const pattern = `${'**/'.repeat(30)}x.node`;
    const path = `${'a/'.repeat(200)}y.node`;
    const start = Date.now();
    expect(matchesException(pattern, path)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
    const star = `${'*a'.repeat(30)}c`;
    expect(matchesException(`x/${star}`, `x/${'a'.repeat(5000)}b`)).toBe(false);
  });
});
