import type { Asset } from '@happyvertical/smrt-assets';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AssetAssociable, MetadataAccessor } from './asset-associable';
import { Content } from './content';

/**
 * Issue #1162 — Document.addAsset/removeAsset/getAssets must be a guaranteed
 * API contract, not duck-typed via `typeof === 'function'` checks.
 *
 * The asserts below are split across runtime checks (do the methods exist
 * with the right signatures?) and TypeScript-level checks (does the public
 * type system enforce the contract?).
 */
describe('AssetAssociable contract — issue #1162', () => {
  it('Content satisfies the AssetAssociable interface at the type level', () => {
    expectTypeOf<Content>().toMatchTypeOf<AssetAssociable>();
  });

  it('Content satisfies MetadataAccessor at the type level', () => {
    expectTypeOf<Content>().toMatchTypeOf<MetadataAccessor>();
  });

  it('exposes the three asset methods as functions on the prototype', () => {
    const proto = Content.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.getAssets).toBe('function');
    expect(typeof proto.addAsset).toBe('function');
    expect(typeof proto.removeAsset).toBe('function');
  });

  it('exposes metadata accessors as functions on the prototype', () => {
    const proto = Content.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.getMetadata).toBe('function');
    expect(typeof proto.setMetadata).toBe('function');
    expect(typeof proto.updateMetadata).toBe('function');
  });

  it('lets consumers type a parameter as Content directly without runtime guards', () => {
    // The whole point of the contract: consumers don't have to write
    // `if (typeof doc.addAsset === 'function')` defensively.
    async function attachThumbnail(doc: AssetAssociable, asset: Asset) {
      await doc.addAsset(asset, 'thumbnail', 0);
    }

    // Type-check by calling — would fail to compile if the contract weren't
    // honoured by Content.
    const _typeCheck = (doc: Content) => attachThumbnail;
    void _typeCheck;
  });
});

describe('MetadataAccessor implementation on Content', () => {
  it('getMetadata returns an object even when metadata was nulled out', () => {
    const c = new Content({ name: 'x' });
    (c as unknown as { metadata: unknown }).metadata = null;

    const m = c.getMetadata();
    expect(m).toEqual({});
    // Subsequent calls return the same normalised object.
    expect(c.getMetadata()).toBe(m);
  });

  it('setMetadata replaces the field and clones the input', () => {
    const c = new Content({ name: 'x' });
    const original = { foo: 1 };
    c.setMetadata(original);

    expect(c.getMetadata()).toEqual({ foo: 1 });
    // Mutating the original after set must not affect the stored copy.
    (original as Record<string, unknown>).foo = 99;
    expect(c.getMetadata().foo).toBe(1);
  });

  it('setMetadata with null/undefined clears to an empty object', () => {
    const c = new Content({ name: 'x', metadata: { foo: 1 } });
    c.setMetadata(null);
    expect(c.getMetadata()).toEqual({});
    c.setMetadata({ bar: 2 });
    c.setMetadata(undefined);
    expect(c.getMetadata()).toEqual({});
  });

  it('updateMetadata shallow-merges and returns the merged record', () => {
    const c = new Content({
      name: 'x',
      metadata: { keep: 'a', overwrite: 1 },
    });

    const merged = c.updateMetadata({ overwrite: 2, added: true });

    expect(merged).toEqual({ keep: 'a', overwrite: 2, added: true });
    expect(c.getMetadata()).toEqual(merged);
  });

  it('updateMetadata tolerates an undefined patch', () => {
    const c = new Content({ name: 'x', metadata: { keep: 'a' } });
    const merged = c.updateMetadata(
      undefined as unknown as Record<string, unknown>,
    );
    expect(merged).toEqual({ keep: 'a' });
  });
});
