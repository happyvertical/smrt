import { describe, expect, it, vi } from 'vitest';
import {
  createCollectionImportExport,
  ExportLimitError,
} from '../collection-adapter.js';
import {
  fieldsFromCollectionDefinition,
  humanizeFieldName,
} from '../fields.js';

const definition = {
  name: 'products',
  fields: {
    name: { type: 'text', required: true },
    sku: { type: 'text', required: true, default: 'NEW' },
    priceCents: { type: 'integer', description: 'Minor units' },
    rate: { type: 'decimal', nullable: true, required: true },
    active: { type: 'boolean' },
    launchedAt: { type: 'datetime', ui: { order: 1 } },
    ownerId: { type: 'foreignKey' },
    config: { type: 'json' },
    status: { type: 'text' },
    notes: { type: 'text', ui: { widget: 'textarea' } },
    tenantId: { type: 'foreignKey' },
    createdAt: { type: 'datetime' },
    _meta_type: { type: 'text' },
    internal: { type: 'text' },
  },
} as const;

describe('humanizeFieldName', () => {
  it('splits camel and snake case', () => {
    expect(humanizeFieldName('publishedAt')).toBe('Published At');
    expect(humanizeFieldName('price_cents')).toBe('Price cents');
  });
});

describe('fieldsFromCollectionDefinition', () => {
  const fields = fieldsFromCollectionDefinition(definition, {
    enums: { status: ['draft', 'live'] },
    unique: ['sku'],
    policy: {
      internal: { visibility: 'hidden' },
      active: {
        locked: true,
        hasDefault: true,
        defaultValue: true,
        label: 'Is active',
      },
      name: { label: 'Product name', help: 'Shown to buyers', order: 0 },
    },
  });
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

  it('skips system, storage and excluded fields', () => {
    expect(Object.keys(byName)).not.toContain('createdAt');
    expect(Object.keys(byName)).not.toContain('_meta_type');
  });

  it('exposes id as export-only and tenant fields as neither', () => {
    expect(byName.id).toMatchObject({ importable: false, exportable: true });
    expect(byName.tenantId).toMatchObject({
      importable: false,
      exportable: false,
    });
  });

  it('maps manifest types and hints', () => {
    expect(byName.priceCents).toMatchObject({
      type: 'integer',
      help: 'Minor units',
    });
    expect(byName.rate).toMatchObject({ type: 'decimal', required: false });
    expect(byName.ownerId.type).toBe('reference');
    expect(byName.config.type).toBe('json');
    expect(byName.notes.widget).toBe('textarea');
    expect(byName.status).toMatchObject({
      type: 'enum',
      options: ['draft', 'live'],
    });
  });

  it('treats a required field with a default as satisfied and keeps unique', () => {
    expect(byName.sku).toMatchObject({
      required: false,
      hasDefault: true,
      defaultValue: 'NEW',
      unique: true,
    });
    expect(byName.name.required).toBe(true);
  });

  it('applies policy: hidden is neither imported nor exported, locked is not importable but keeps its default', () => {
    expect(byName.internal).toMatchObject({
      importable: false,
      exportable: false,
    });
    expect(byName.active).toMatchObject({
      importable: false,
      exportable: true,
      hasDefault: true,
      defaultValue: true,
      label: 'Is active',
    });
    expect(byName.name).toMatchObject({
      label: 'Product name',
      help: 'Shown to buyers',
    });
  });

  it('orders by policy order, then ui order, then declaration, with id first', () => {
    const names = fields.map((f) => f.name);
    expect(names.slice(0, 3)).toEqual(['id', 'name', 'launchedAt']);
    expect(names.indexOf('sku')).toBeLessThan(names.indexOf('priceCents'));
  });
});

describe('createCollectionImportExport', () => {
  it('creates through the fetchers and unwraps error envelopes', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: '1' } })
      .mockResolvedValueOnce({ error: 'nope' });
    const io = createCollectionImportExport({
      definition,
      fetchers: { list: vi.fn(), create },
    });
    await expect(io.createRecord({ name: 'a' })).resolves.toEqual({ id: '1' });
    await expect(io.createRecord({ name: 'b' })).rejects.toThrow(/nope/);
  });

  it('pages through list until a short page', async () => {
    const list = vi.fn(async (params?: Record<string, unknown>) => {
      const offset = Number(params?.offset ?? 0);
      const total = 5;
      return {
        items: Array.from(
          { length: Math.max(0, Math.min(2, total - offset)) },
          (_, i) => ({
            id: String(offset + i),
          }),
        ),
      };
    });
    const io = createCollectionImportExport({
      definition,
      fetchers: { list, create: vi.fn() },
    });
    const rows = await io.loadRows({ pageSize: 2, query: { orderBy: 'name' } });
    expect(rows.map((r) => r.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(list).toHaveBeenCalledWith({ orderBy: 'name', limit: 2, offset: 4 });
  });

  it('refuses to silently truncate past maxRows', async () => {
    const list = vi.fn(async () => ({ items: [{ id: 'a' }, { id: 'b' }] }));
    const io = createCollectionImportExport({
      definition,
      fetchers: { list, create: vi.fn() },
    });
    await expect(
      io.loadRows({ pageSize: 2, maxRows: 3 }),
    ).rejects.toBeInstanceOf(ExportLimitError);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const io = createCollectionImportExport({
      definition,
      fetchers: { list: vi.fn(async () => ({ items: [] })), create: vi.fn() },
    });
    await expect(io.loadRows({ signal: controller.signal })).rejects.toThrow();
  });
});
