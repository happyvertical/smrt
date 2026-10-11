/**
 * Issue #3238: an STI row's `_meta_data` JSON must never shadow the row's real
 * columns. A `tenantId` (or `id`, `_meta_type`, ...) key inside the meta blob
 * used to replace the hydrated column value, so ownership checks saw a foreign
 * tenant and a later save could write it back into `tenant_id`.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field, meta } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { formatDataJs, isReservedMetaDataKey } from '../utils';

// Extra keys a `transformJSON()` override pushes into `_meta_data`.
let smuggle: Record<string, unknown> | undefined;

@smrt({ tableStrategy: 'sti', tableName: 'issue_3238_assets' })
class Issue3238Asset extends SmrtObject {
  @field()
  tenantId: string = '';

  @field()
  title: string = '';
}

@smrt()
class Issue3238Image extends Issue3238Asset {
  @meta()
  width: number = 0;

  @field()
  caption: string = '';

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const metaData = data._meta_data as Record<string, unknown> | undefined;
    if (metaData && smuggle) {
      Object.assign(metaData, smuggle);
    }
    return data;
  }
}

// A sibling that stores `caption` in `_meta_data`, while Issue3238Image owns
// a real `caption` column on the same table.
@smrt()
class Issue3238Video extends Issue3238Asset {
  @meta()
  caption: string = '';
}

const tableName = 'issue_3238_assets';
type Row = Record<string, unknown>;
const OWNER = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';

describe('Issue #3238: formatDataJs keeps declared columns over _meta_data', () => {
  it('does not let _meta_data overwrite tenant_id, id or _meta_type', () => {
    const row = {
      id: 'row-1',
      tenant_id: OWNER,
      title: 'Logo',
      _meta_type: '@happyvertical/smrt-core:Issue3238Image',
      _meta_data: JSON.stringify({
        width: 640,
        tenantId: FOREIGN,
        tenant_id: FOREIGN,
        id: 'forged',
        _meta_type: 'Forged',
        title: 'Forged title',
      }),
    };

    const result = formatDataJs<Row>(row);

    expect(result.tenantId).toBe(OWNER);
    expect(result.id).toBe('row-1');
    expect(result._meta_type).toBe('@happyvertical/smrt-core:Issue3238Image');
    expect(result.title).toBe('Logo');
    // Legitimate meta fields still hydrate.
    expect(result.width).toBe(640);
    expect('tenant_id' in result).toBe(false);
  });

  it('drops reserved meta keys even when the row has no such column', () => {
    const result = formatDataJs<Row>({
      id: 'row-2',
      _meta_data: { tenantId: FOREIGN, _meta_type: 'Forged', width: 1 },
    });
    expect(result.tenantId).toBeUndefined();
    expect(result._meta_type).toBeUndefined();
    expect(result.width).toBe(1);
  });

  it('lets a declared @meta field take precedence over a sibling column', () => {
    const fields = { caption: { type: 'meta' } };
    // The sibling's column is NULL or its DDL default ('') on this child's rows.
    for (const column of [null, '']) {
      const filled = formatDataJs<Row>(
        { id: 'v', caption: column, _meta_data: { caption: 'from meta' } },
        fields,
      );
      expect(filled.caption).toBe('from meta');
    }

    // Without a @meta declaration, the column wins (even when NULL).
    for (const declared of [undefined, { caption: { type: 'text' } }]) {
      const kept = formatDataJs<Row>(
        { id: 'v', caption: null, _meta_data: { caption: 'from meta' } },
        declared,
      );
      expect(kept.caption).toBeNull();
    }

    // A @meta declaration never unlocks a reserved key.
    const reserved = formatDataJs<Row>(
      { id: 'v', tenant_id: OWNER, _meta_data: { tenantId: FOREIGN } },
      { tenantId: { type: 'meta' } },
    );
    expect(reserved.tenantId).toBe(OWNER);
  });

  it('reserves tenancy-marked fields under their own names', () => {
    const fields = {
      orgId: { type: 'text', __tenancy: { isTenantIdField: true } },
    };
    expect(isReservedMetaDataKey('orgId', fields)).toBe(true);
    expect(isReservedMetaDataKey('org_id', fields)).toBe(true);
    expect(isReservedMetaDataKey('width', fields)).toBe(false);
    const result = formatDataJs<Row>(
      { id: 'r', org_id: OWNER, _meta_data: { orgId: FOREIGN } },
      fields,
    );
    expect(result.orgId).toBe(OWNER);
  });
});

describe('Issue #3238: STI save and load round-trip', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Issue3238Asset', 'Issue3238Image', 'Issue3238Video'],
    });
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function readMeta(id: string): Promise<Record<string, unknown>> {
    const result = await db.query(
      `SELECT _meta_data FROM ${tableName} WHERE id = ?`,
      [id],
    );
    const rows = (Array.isArray(result) ? result : result.rows) as Record<
      string,
      unknown
    >[];
    const raw = rows[0]?._meta_data;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as never);
  }

  it('strips id, tenantId and _meta_* keys from _meta_data on save', async () => {
    const image = new Issue3238Image({
      db,
      tenantId: OWNER,
      title: 'Logo',
      width: 640,
    });
    await image.initialize();
    smuggle = {
      tenantId: FOREIGN,
      tenant_id: FOREIGN,
      id: 'forged',
      _meta_type: 'Forged',
    };
    try {
      await image.save();
    } finally {
      smuggle = undefined;
    }

    const stored = await readMeta(image.id as string);
    expect(stored).toEqual({ width: 640 });
  });

  it('hydrates the column tenant even when a raw _meta_data carries another', async () => {
    const image = new Issue3238Image({
      db,
      tenantId: OWNER,
      title: 'Logo',
      width: 640,
    });
    await image.initialize();
    await image.save();

    // Simulate a row whose meta blob was written outside the framework.
    await db.query(`UPDATE ${tableName} SET _meta_data = ? WHERE id = ?`, [
      JSON.stringify({ width: 640, tenantId: FOREIGN, title: 'Forged' }),
      image.id,
    ]);

    const loaded = new Issue3238Image({ db });
    const result = await db.query(`SELECT * FROM ${tableName} WHERE id = ?`, [
      image.id,
    ]);
    const rows = (Array.isArray(result) ? result : result.rows) as Record<
      string,
      unknown
    >[];
    await loaded.loadDataFromDb(rows[0] as Record<string, unknown>);

    expect(loaded.tenantId).toBe(OWNER);
    expect(loaded.title).toBe('Logo');
    expect(loaded.width).toBe(640);
  });

  it('round-trips a sibling @meta field that shares a column name', async () => {
    const video = new Issue3238Video({
      db,
      tenantId: OWNER,
      title: 'Clip',
      caption: 'meta caption',
    });
    await video.initialize();
    await video.save();

    const result = await db.query(`SELECT * FROM ${tableName} WHERE id = ?`, [
      video.id,
    ]);
    const rows = (Array.isArray(result) ? result : result.rows) as Record<
      string,
      unknown
    >[];
    const loaded = new Issue3238Video({ db });
    await loaded.loadDataFromDb(rows[0] as Record<string, unknown>);
    expect(loaded.caption).toBe('meta caption');
  });
});
