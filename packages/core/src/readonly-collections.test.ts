/**
 * Read-only set and map views (#5195): reading works as on a `Set` / `Map`,
 * and no mutator, built-in or own, changes them.
 */

import { describe, expect, it } from 'vitest';
import {
  ReadonlyMapView,
  ReadonlySetView,
  readonlySetOf,
} from './readonly-collections';

describe('ReadonlySetView', () => {
  it('reads like a set and passes itself to forEach', () => {
    const view = new ReadonlySetView(['b', 'a', 'a']);
    expect(view.size).toBe(2);
    expect(view.has('a')).toBe(true);
    expect(view.has('c')).toBe(false);
    expect([...view]).toEqual(['b', 'a']);
    expect([...view.keys()]).toEqual(['b', 'a']);
    expect([...view.values()]).toEqual(['b', 'a']);
    expect([...view.entries()]).toEqual([
      ['b', 'b'],
      ['a', 'a'],
    ]);
    const seen: Array<[string, string, unknown]> = [];
    view.forEach((value, key, collection) => {
      seen.push([value, key, collection]);
    });
    expect(seen).toEqual([
      ['b', 'b', view],
      ['a', 'a', view],
    ]);
  });

  it('answers set algebra with new plain sets', () => {
    const view = new ReadonlySetView(['a', 'b']);
    const other = new Set(['b', 'c']);
    const union = view.union(other);
    expect(union).toBeInstanceOf(Set);
    expect([...union].sort()).toEqual(['a', 'b', 'c']);
    expect([...view.intersection(other)]).toEqual(['b']);
    expect([...view.difference(other)]).toEqual(['a']);
    expect([...view.symmetricDifference(other)].sort()).toEqual(['a', 'c']);
    expect(view.isSubsetOf(new Set(['a', 'b', 'c']))).toBe(true);
    expect(view.isSupersetOf(new Set(['a']))).toBe(true);
    expect(view.isDisjointFrom(new Set(['z']))).toBe(true);
    union.add('d');
    expect(view.has('d')).toBe(false);
  });

  it('refuses every mutator, built-in or its own', () => {
    const view = new ReadonlySetView(['a']);
    const mutable = view as unknown as Set<string>;
    expect(() => mutable.add('b')).toThrow(TypeError);
    expect(() => mutable.delete('a')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect(() => Set.prototype.add.call(view, 'b')).toThrow(TypeError);
    expect(() => Set.prototype.delete.call(view, 'a')).toThrow(TypeError);
    expect(() => Set.prototype.clear.call(view)).toThrow(TypeError);
    expect(() => {
      (view as unknown as { has: unknown }).has = () => true;
    }).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(view, Set.prototype)).toThrow(TypeError);
    expect(() => {
      (ReadonlySetView.prototype as unknown as { has: unknown }).has = () =>
        true;
    }).toThrow(TypeError);
    expect([...view]).toEqual(['a']);
    expect(view).not.toBeInstanceOf(Set);
  });

  it('copies its source, so a later change to the source is not seen', () => {
    const source = new Set(['a']);
    const view = readonlySetOf(source);
    source.add('b');
    expect(view.has('b')).toBe(false);
    expect(readonlySetOf(view)).toBe(view);
  });
});

describe('ReadonlyMapView', () => {
  it('reads like a map and refuses every mutator', () => {
    const view = new ReadonlyMapView([
      ['a', 1],
      ['b', 2],
    ]);
    expect(view.size).toBe(2);
    expect(view.get('a')).toBe(1);
    expect(view.has('b')).toBe(true);
    expect([...view]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    const seen: unknown[] = [];
    view.forEach((_value, _key, map) => {
      seen.push(map);
    });
    expect(seen).toEqual([view, view]);
    const mutable = view as unknown as Map<string, number>;
    expect(() => mutable.set('c', 3)).toThrow(TypeError);
    expect(() => mutable.delete('a')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect(() => Map.prototype.set.call(view, 'c', 3)).toThrow(TypeError);
    expect(() => Map.prototype.clear.call(view)).toThrow(TypeError);
    expect(view.size).toBe(2);
    expect(view).not.toBeInstanceOf(Map);
  });
});
