import { describe, expect, it, vi } from 'vitest';
import { formatProjectedRecords, queryWithProjection } from '../export.js';

describe('export command helpers', () => {
  it('passes query params as a single array to the database adapter', async () => {
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
      ['%:Article', 'published'],
    );
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
});
