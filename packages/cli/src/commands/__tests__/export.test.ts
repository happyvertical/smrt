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

      return baseFields;
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
});
