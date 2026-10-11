/**
 * Issue #3238: an STI row's `_meta_data` JSON must never shadow the row's real
 * columns. A `tenantId` (or `id`, `_meta_type`, ...) key inside the meta blob
 * used to replace the hydrated column value, so ownership checks saw a foreign
 * tenant and a later save could write it back into `tenant_id`.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, meta } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import {
  formatDataJs,
  isReservedMetaDataKey,
  sanitizeMetaData,
} from '../utils';

// Extra keys a `transformJSON()` override pushes into `_meta_data`, and
// whether it returns the blob as JSON text instead of an object.
let smuggle: Record<string, unknown> | undefined;
let stringifyMeta = false;

function smuggleInto(data: Record<string, unknown>): Record<string, unknown> {
  const metaData = data._meta_data as Record<string, unknown> | undefined;
  if (metaData && smuggle) Object.assign(metaData, smuggle);
  if (metaData && stringifyMeta) data._meta_data = JSON.stringify(metaData);
  return data;
}

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
    return smuggleInto(data);
  }
}

// A sibling that stores `caption` in `_meta_data`, while Issue3238Image owns
// a real `caption` column on the same table.
@smrt()
class Issue3238Video extends Issue3238Asset {
  @meta()
  caption: string = '';
}

// A second family whose PARENT declares a custom tenant field (`orgId`,
// marked below exactly as `@tenantId()` from smrt-tenancy does).
@smrt({ tableStrategy: 'sti', tableName: 'issue_3238_docs' })
class Issue3238Doc extends SmrtObject {
  @field()
  orgId: string = '';

  @field()
  title: string = '';
}

@smrt()
class Issue3238Memo extends Issue3238Doc {
  @meta()
  body: string = '';

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return smuggleInto(data);
  }
}

class Issue3238Memos extends SmrtCollection<Issue3238Memo> {
  static readonly _itemClass = Issue3238Memo;
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

  it('sanitizes the retained _meta_data blob in its own representation', () => {
    const forged = { width: 1, tenantId: FOREIGN, id: 'x', _meta_type: 'F' };
    const fromText = formatDataJs<Row>({
      id: 'r',
      _meta_data: JSON.stringify(forged),
    });
    expect(JSON.parse(fromText._meta_data as string)).toEqual({ width: 1 });

    const fromObject = formatDataJs<Row>({ id: 'r', _meta_data: forged });
    expect(fromObject._meta_data).toEqual({ width: 1 });
    expect(forged.tenantId).toBe(FOREIGN); // caller's object untouched

    const clean = JSON.stringify({ width: 1 });
    expect(sanitizeMetaData(clean)).toBe(clean);
    expect(sanitizeMetaData('not json')).toBe('not json');
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
    const orgField = ObjectRegistry.getFields('Issue3238Doc').get('orgId');
    if (!orgField) throw new Error('Issue3238Doc.orgId is not registered');
    orgField._meta = {
      ...(orgField._meta ?? {}),
      __tenancy: { isTenantIdField: true, mode: 'optional' },
    };
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'Issue3238Asset',
        'Issue3238Image',
        'Issue3238Video',
        'Issue3238Doc',
        'Issue3238Memo',
      ],
    });
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function readMeta(
    id: string,
    table = tableName,
  ): Promise<Record<string, unknown>> {
    const result = await db.query(
      `SELECT _meta_data FROM ${table} WHERE id = ?`,
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

  it('strips reserved keys when transformJSON returns _meta_data as JSON text', async () => {
    const image = new Issue3238Image({
      db,
      tenantId: OWNER,
      title: 'Logo',
      width: 640,
    });
    await image.initialize();
    smuggle = { tenantId: FOREIGN, id: 'forged', _meta_type: 'Forged' };
    stringifyMeta = true;
    try {
      await image.save();
    } finally {
      smuggle = undefined;
      stringifyMeta = false;
    }

    expect(await readMeta(image.id as string)).toEqual({ width: 640 });
  });

  it('reserves a custom tenant field inherited from the STI parent', async () => {
    const memo = new Issue3238Memo({
      db,
      orgId: OWNER,
      title: 'Memo',
      body: 'hello',
    });
    await memo.initialize();
    smuggle = { orgId: FOREIGN, org_id: FOREIGN };
    try {
      await memo.save();
    } finally {
      smuggle = undefined;
    }
    expect(await readMeta(memo.id as string, 'issue_3238_docs')).toEqual({
      body: 'hello',
    });

    // Collection hydration resolves the concrete class's fields; a row that
    // omits the real column must still not take the tenant from meta.
    const metaType = ObjectRegistry.getClass('Issue3238Memo')?.qualifiedName;
    expect(metaType).toBeTruthy();
    const memos = await Issue3238Memos.create({ db });
    const hydrationFields = await (
      memos as unknown as {
        resolveHydrationFields(
          row: Row,
          fallback: Row,
          isSTI: boolean,
          cache: Map<string, Row>,
        ): Promise<Record<string, { type?: string }>>;
      }
    ).resolveHydrationFields({ _meta_type: metaType }, {}, true, new Map());
    const projected = formatDataJs<Row>(
      {
        id: memo.id,
        _meta_type: metaType,
        _meta_data: { body: 'hello', orgId: FOREIGN },
      },
      hydrationFields,
    );
    expect(hydrationFields.orgId).toBeDefined();
    expect(projected.orgId).toBeUndefined();
    expect(projected.body).toBe('hello');
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
