/**
 * #4441: which join keys compare as text. The end-to-end behaviour on each
 * dialect is in report-joins-dialects.optional.test.ts; this pins the type
 * lookup's precedence and its failure mode.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { columnTypeReader, compareAsText } from '../registry-columns.js';

const tables: Record<string, Record<string, { type: string }>> = {
  segments: {
    work_ref_id: { type: 'TEXT' },
    tenant_id: { type: 'UUID' },
    qty: { type: 'INTEGER' },
  },
  work_orders: { id: { type: 'UUID' }, rate: { type: 'REAL' } },
};

function stubRegistry(options: {
  merged?: 'ok' | 'throws';
  manifest?: Record<string, Record<string, { type: string }>>;
}) {
  vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation((name) =>
    name === 'Segment' ? 'segments' : 'work_orders',
  );
  vi.spyOn(ObjectRegistry, 'getTableStrategy').mockReturnValue('cti');
  vi.spyOn(ObjectRegistry, 'getSchema').mockImplementation((name) =>
    options.manifest?.[name]
      ? ({ columns: options.manifest[name] } as never)
      : undefined,
  );
  const merged = vi
    .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
    .mockImplementation(() => {
      if (options.merged === 'throws') {
        throw new Error('Cannot resolve foreign key Elsewhere.thing');
      }
      return Object.fromEntries(
        Object.entries(tables).map(([table, columns]) => [table, { columns }]),
      ) as never;
    });
  return merged;
}

const key = (className: string, column: string) => ({ className, column });

afterEach(() => vi.restoreAllMocks());

describe('join key types (#4441)', () => {
  it('casts only a TEXT/UUID pair', () => {
    stubRegistry({ merged: 'ok' });
    const types = columnTypeReader();
    expect(
      compareAsText(types, key('Segment', 'work_ref_id'), key('Wo', 'id')),
    ).toBe(true);
    // Same type, or a numeric mismatch, compares as it is.
    expect(
      compareAsText(types, key('Segment', 'tenant_id'), key('Wo', 'id')),
    ).toBe(false);
    expect(compareAsText(types, key('Segment', 'qty'), key('Wo', 'rate'))).toBe(
      false,
    );
    // An undescribed column is unknown: no cast, as before.
    expect(
      compareAsText(types, key('Segment', 'missing'), key('Wo', 'id')),
    ).toBe(false);
  });

  it('prefers the merged migration table over a stale manifest column', () => {
    // The manifest says UUID but the migrated column is TEXT (a runtime overlay).
    stubRegistry({
      merged: 'ok',
      manifest: { Segment: { work_ref_id: { type: 'UUID' } } },
    });
    expect(columnTypeReader()('Segment', 'work_ref_id')).toBe('TEXT');
  });

  it('assembles the merged tables once per reader', () => {
    const merged = stubRegistry({ merged: 'ok' });
    const types = columnTypeReader();
    types('Segment', 'work_ref_id');
    types('Wo', 'id');
    types('Segment', 'tenant_id');
    expect(merged).toHaveBeenCalledTimes(1);
  });

  it('falls back to the manifest when the registry cannot be assembled', () => {
    stubRegistry({
      merged: 'throws',
      manifest: {
        Segment: { work_ref_id: { type: 'TEXT' } },
        Wo: { id: { type: 'UUID' } },
      },
    });
    const types = columnTypeReader();
    expect(
      compareAsText(types, key('Segment', 'work_ref_id'), key('Wo', 'id')),
    ).toBe(true);
    // Neither source describes it: unknown, never a thrown build.
    expect(types('Segment', 'tenant_id')).toBeNull();
  });
});
