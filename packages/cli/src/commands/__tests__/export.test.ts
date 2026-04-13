import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatProjectedRecords,
  getCommonFields,
  queryWithProjection,
} from '../export.js';

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: {
    getAllFields: vi.fn((typeName: string) => {
      const baseFields = new Map([
        ['id', { type: 'text', _meta: { __smrtSystemField: true } }],
        ['slug', { type: 'text', _meta: { __smrtSystemField: true } }],
        ['context', { type: 'text', _meta: { __smrtSystemField: true } }],
        [
          'created_at',
          { type: 'datetime', _meta: { __smrtSystemField: true } },
        ],
        [
          'updated_at',
          { type: 'datetime', _meta: { __smrtSystemField: true } },
        ],
        ['title', { type: 'string' }],
        ['body', { type: 'string' }],
        ['status', { type: 'string' }],
        ['publishDate', { type: 'date' }],
      ]);

      if (typeName === 'MeetingRecap' || typeName === 'MeetingAnnouncement') {
        baseFields.set('meetingId', { type: 'foreignKey' });
      }

      if (typeName === 'Council') {
        return new Map([
          ['id', { type: 'text', _meta: { __smrtSystemField: true } }],
          ['slug', { type: 'text', _meta: { __smrtSystemField: true } }],
          ['context', { type: 'text', _meta: { __smrtSystemField: true } }],
          ['tenantId', { type: 'foreignKey' }],
          ['organizationId', { type: 'foreignKey' }],
          ['name', { type: 'string' }],
          ['meetingsUrl', { type: 'string' }],
          ['timezone', { type: 'string' }],
          ['logoUrl', { type: 'string' }],
        ]);
      }

      return baseFields;
    }),
    getTableStrategy: vi.fn((typeName: string) =>
      typeName === 'Council' ? 'cti' : 'sti',
    ),
    getSchema: vi.fn((typeName: string) => {
      if (typeName === 'Council') {
        return {
          tableName: 'councils',
          columns: {
            id: { type: 'TEXT' },
            slug: { type: 'TEXT' },
            tenant_id: { type: 'TEXT' },
            organization_id: { type: 'TEXT' },
            name: { type: 'TEXT' },
            meetings_url: { type: 'TEXT' },
            timezone: { type: 'TEXT' },
            logo_url: { type: 'TEXT' },
          },
        };
      }

      return {
        tableName: 'contents',
        columns: {
          id: { type: 'TEXT' },
          slug: { type: 'TEXT' },
          _meta_type: { type: 'TEXT' },
          _meta_data: { type: 'JSON' },
          title: { type: 'TEXT' },
          body: { type: 'TEXT' },
          status: { type: 'TEXT' },
          publish_date: { type: 'DATE' },
        },
      };
    }),
  },
}));

describe('export command helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes query params as variadic database adapter arguments', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ title: 'Bridge update' }],
    });

    await queryWithProjection(
      { query },
      'contents',
      ['Article'],
      ['title'],
      { status: 'published' },
      'title',
      10,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM contents'),
      '%:Article',
      'published',
    );
  });

  it('uses inherited registry fields when computing shared export columns', async () => {
    const fields = await getCommonFields(
      ['MeetingRecap', 'MeetingAnnouncement'],
      { types: ['MeetingRecap', 'MeetingAnnouncement'] },
      true,
    );

    expect(fields).toEqual(
      expect.arrayContaining([
        'title',
        'body',
        'status',
        'publishDate',
        'meetingId',
        '_meta_type',
      ]),
    );
    expect(fields).not.toContain('context');
    expect(fields).not.toContain('created_at');
    expect(fields).not.toContain('updated_at');
  });

  it('does not inject STI meta columns into CTI exports', async () => {
    const fields = await getCommonFields(
      ['Council'],
      { types: ['Council'] },
      true,
    );

    expect(fields).toEqual(expect.arrayContaining(['id', 'slug', 'name']));
    expect(fields).not.toContain('_meta_type');
    expect(fields).not.toContain('_meta_data');
  });

  it('formats export records using requested field names', () => {
    const records = formatProjectedRecords(
      [
        {
          title: 'Bridge update',
          publish_date: '2026-03-20',
          metadata: '{"source":"admin"}',
        },
      ],
      [
        { field: 'title', column: 'title' },
        { field: 'publishDate', column: 'publish_date' },
        { field: 'metadata', column: 'metadata' },
      ],
    );

    expect(records).toEqual([
      {
        title: 'Bridge update',
        publishDate: '2026-03-20',
        metadata: { source: 'admin' },
      },
    ]);
  });

  it('rejects unsafe identifiers before building SQL', async () => {
    await expect(
      queryWithProjection(
        { query: vi.fn() },
        'contents; DROP TABLE contents',
        ['Article'],
        ['title'],
        {},
        'title',
        10,
      ),
    ).rejects.toThrow('Invalid table name');

    await expect(
      queryWithProjection(
        { query: vi.fn() },
        'contents',
        ['Article'],
        ['title'],
        { 'status; DELETE': 'published' },
        'title',
        10,
      ),
    ).rejects.toThrow('Invalid filter field');
  });

  it('fails loudly when the projected export query fails', async () => {
    const sourceError = new Error('column "video_url" does not exist');

    await expect(
      queryWithProjection(
        {
          query: vi.fn().mockRejectedValue(sourceError),
        },
        'contents',
        ['MeetingRecap'],
        ['title'],
        { status: 'published' },
        'publishDate',
      ),
    ).rejects.toThrow(
      'Export query failed for contents (columns: title): column "video_url" does not exist',
    );

    await expect(
      queryWithProjection(
        {
          query: vi.fn().mockRejectedValue(sourceError),
        },
        'contents',
        ['MeetingRecap'],
        ['title'],
        { status: 'published' },
        'publishDate',
      ),
    ).rejects.toMatchObject({ cause: sourceError });
  });

  it('does not apply STI filters when exporting CTI tables', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: 'council-1', slug: 'bentley', name: 'Bentley Council' }],
    });

    await queryWithProjection(
      { query },
      'councils',
      ['Council'],
      ['id', 'slug', 'name'],
      {},
      'name',
      10,
    );

    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining('_meta_type LIKE ?'),
    );
    expect(query.mock.calls[0]?.slice(1)).toEqual([]);
  });
});
