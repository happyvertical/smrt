/**
 * Test for issue #1580: `toPublicJSON()` must strip sensitive fields
 * RECURSIVELY, not just at the top level.
 * https://github.com/happyvertical/smrt/issues/1580
 *
 * `toPublicJSON()` previously stripped `@field({ sensitive: true })` values
 * only at the top level (+ the STI `_meta_data` object). If a serialized value
 * IS (or contains) a nested `SmrtObject` — e.g. surfaced by a `transformJSON()`
 * override — `JSON.stringify` would invoke that nested object's `toJSON()` (not
 * `toPublicJSON()`), leaking its secrets to REST / MCP / SvelteKit / AI
 * consumers. The fix walks the payload and reduces every nested `SmrtObject`
 * to its own public projection, with a cycle guard.
 *
 * These nested-object payloads are produced here via `transformJSON()` (the
 * documented customization hook) so the test exercises the exact latent path,
 * even though no current model embeds a `SmrtObject` in its serialization.
 */

import { describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

// Unique class names to avoid AST-scanner collisions (issue #543).
@smrt()
class Pub1580Nested extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', sensitive: true })
  childSecret: string = '';

  // Runtime-only back-reference, injected via transformJSON to build a cycle.
  back?: SmrtObject;

  constructor(options: any = {}) {
    super(options);
    if (options.label !== undefined) this.label = options.label;
    if (options.childSecret !== undefined)
      this.childSecret = options.childSecret;
    this.back = options.back;
  }

  protected transformJSON(data: any) {
    if (this.back) data.back = this.back;
    return data;
  }
}

@smrt()
class Pub1580Host extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text', sensitive: true })
  hostSecret: string = '';

  // Runtime-only holders injected into the payload via transformJSON.
  child?: SmrtObject;
  list: SmrtObject[] = [];
  blob?: Record<string, unknown>;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.hostSecret !== undefined) this.hostSecret = options.hostSecret;
    this.child = options.child;
    this.list = options.list ?? [];
    this.blob = options.blob;
  }

  protected transformJSON(data: any) {
    if (this.child) data.child = this.child;
    if (this.list.length) data.list = this.list;
    if (this.blob) data.blob = this.blob;
    return data;
  }
}

describe('Issue #1580: recursive toPublicJSON() sensitive-field strip', () => {
  it('strips a sensitive field on a nested SmrtObject held in a plain field', () => {
    const host = new Pub1580Host({
      name: 'h',
      hostSecret: 'sk-host',
      child: new Pub1580Nested({ label: 'c', childSecret: 'sk-child' }),
    });

    const pub = host.toPublicJSON();
    // Own sensitive field gone (existing behavior preserved).
    expect('hostSecret' in pub).toBe(false);
    // Nested object reduced to its public projection: non-sensitive kept...
    const child = pub.child as Record<string, unknown>;
    expect(child.label).toBe('c');
    // ...sensitive stripped.
    expect('childSecret' in child).toBe(false);
    // Belt-and-suspenders: the secret is nowhere in the serialized output.
    expect(JSON.stringify(pub)).not.toContain('sk-child');
    expect(JSON.stringify(pub)).not.toContain('sk-host');
  });

  it('strips sensitive fields on nested objects inside an array', () => {
    const host = new Pub1580Host({
      name: 'h',
      list: [
        new Pub1580Nested({ label: 'a', childSecret: 'sk-a' }),
        new Pub1580Nested({ label: 'b', childSecret: 'sk-b' }),
      ],
    });

    const pub = host.toPublicJSON();
    const list = pub.list as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('a');
    expect(list[1].label).toBe('b');
    expect('childSecret' in list[0]).toBe(false);
    expect('childSecret' in list[1]).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('sk-a');
    expect(JSON.stringify(pub)).not.toContain('sk-b');
  });

  it('strips sensitive fields on a nested object inside a plain JSON value', () => {
    const host = new Pub1580Host({
      name: 'h',
      blob: { inner: new Pub1580Nested({ label: 'd', childSecret: 'sk-d' }) },
    });

    const pub = host.toPublicJSON();
    const blob = pub.blob as Record<string, unknown>;
    const inner = blob.inner as Record<string, unknown>;
    expect(inner.label).toBe('d');
    expect('childSecret' in inner).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('sk-d');
  });

  it('does not infinite-loop on a circular reference and breaks the cycle', () => {
    const host = new Pub1580Host({ name: 'h', hostSecret: 'sk-host' });
    const child = new Pub1580Nested({ label: 'c', childSecret: 'sk-child' });
    host.child = child;
    child.back = host; // host -> child -> host

    let pub!: Record<string, unknown>;
    expect(() => {
      pub = host.toPublicJSON();
    }).not.toThrow();

    const projectedChild = pub.child as Record<string, unknown>;
    expect(projectedChild.label).toBe('c');
    expect('childSecret' in projectedChild).toBe(false);
    // The cycle back to `host` is dropped rather than recursed into.
    expect(projectedChild.back).toBeUndefined();
    // No secret survives anywhere.
    expect(JSON.stringify(pub)).not.toContain('sk-child');
    expect(JSON.stringify(pub)).not.toContain('sk-host');
  });

  it('leaves a plain object with no nested SmrtObject untouched in shape', () => {
    const host = new Pub1580Host({
      name: 'plain',
      blob: { a: 1, b: ['x', 'y'], c: { d: true } },
    });
    const pub = host.toPublicJSON();
    expect(pub.name).toBe('plain');
    expect(pub.blob).toEqual({ a: 1, b: ['x', 'y'], c: { d: true } });
  });
});
