/**
 * Test for issue #1565: `@field({ readPermission })` omits individual fields
 * from public/read serialization unless the caller holds the required
 * permission slug.
 */

import { describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

@smrt()
class ReadPermission1565Child extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', readPermission: 'children.read.internal' })
  internalNote: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.label !== undefined) this.label = options.label;
    if (options.internalNote !== undefined)
      this.internalNote = options.internalNote;
  }
}

@smrt()
class ReadPermission1565Product extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'decimal', readPermission: 'products.read.internal' })
  wholesalePrice: number = 0.0;

  @field({
    type: 'text',
    readPermission: 'products.read.internal',
    sensitive: true,
  })
  sensitiveInternalCode: string = '';

  child?: ReadPermission1565Child;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.wholesalePrice !== undefined)
      this.wholesalePrice = options.wholesalePrice;
    if (options.sensitiveInternalCode !== undefined)
      this.sensitiveInternalCode = options.sensitiveInternalCode;
    this.child = options.child;
  }

  protected transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (this.child) data.child = this.child;
    return data;
  }
}

describe('Issue #1565: readPermission field serialization', () => {
  it('omits read-permission fields by default', () => {
    const product = new ReadPermission1565Product({
      name: 'Widget',
      wholesalePrice: 12.5,
    });

    const publicJson = product.toPublicJSON();

    expect(publicJson.name).toBe('Widget');
    expect('wholesalePrice' in publicJson).toBe(false);
  });

  it('includes read-permission fields when the caller has the slug', () => {
    const product = new ReadPermission1565Product({
      name: 'Widget',
      wholesalePrice: 12.5,
    });

    const publicJson = product.toPublicJSON({
      permissions: ['products.read.internal'],
    });

    expect(publicJson.wholesalePrice).toBe(12.5);
  });

  it('keeps sensitive fields hidden even when the read permission is present', () => {
    const product = new ReadPermission1565Product({
      name: 'Widget',
      sensitiveInternalCode: 'never-return',
    });

    const publicJson = product.toPublicJSON({
      permissions: ['products.read.internal'],
    });

    expect('sensitiveInternalCode' in publicJson).toBe(false);
    expect(JSON.stringify(publicJson)).not.toContain('never-return');
  });

  it('passes the permission set into nested SmrtObject projections', () => {
    const product = new ReadPermission1565Product({
      name: 'Widget',
      child: new ReadPermission1565Child({
        label: 'Child',
        internalNote: 'child-note',
      }),
    });

    const withoutPermission = product.toPublicJSON();
    expect(
      'internalNote' in (withoutPermission.child as Record<string, unknown>),
    ).toBe(false);

    const withPermission = product.toPublicJSON({
      permissions: new Set(['children.read.internal']),
    });
    expect((withPermission.child as Record<string, unknown>).internalNote).toBe(
      'child-note',
    );
  });
});
