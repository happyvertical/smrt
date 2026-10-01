/**
 * Issue #3227: saving one STI class must not write `''` into the TEXT
 * columns another class in the hierarchy owns. Those columns stay NULL;
 * the class's own undefined TEXT fields keep their `''` serialization.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tableStrategy: 'sti', tableName: 'issue_3227_contents' })
class Issue3227Content extends SmrtObject {
  @field()
  title: string = '';
}

@smrt()
class Issue3227Recap extends Issue3227Content {
  @field()
  meetingName: string = '';

  @field()
  recapNote?: string;
}

@smrt()
class Issue3227Segment extends Issue3227Content {
  @field()
  scriptText: string = '';

  @field()
  providerLastEventAt?: string;
}

const tableName = 'issue_3227_contents';

async function readRow(
  db: DatabaseInterface,
  columns: string,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await db.query(
    `SELECT ${columns} FROM ${tableName} WHERE id = ?`,
    [id],
  );
  const rows = (Array.isArray(result) ? result : result.rows) as Record<
    string,
    unknown
  >[];
  return rows[0];
}

describe('Issue #3227: STI sibling TEXT columns stay NULL', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Issue3227Content', 'Issue3227Recap', 'Issue3227Segment'],
    });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('serializes sibling-only TEXT fields as null and own ones as empty text', () => {
    const recap = new Issue3227Recap({ db, title: 'Council recap' });
    const json = recap.toJSON() as Record<string, unknown>;

    expect(json.scriptText).toBeNull();
    expect(json.providerLastEventAt).toBeNull();
    expect(json.recapNote).toBe('');
    expect(json.meetingName).toBe('');
  });

  it('saves a new row with NULL in the sibling columns', async () => {
    const recap = new Issue3227Recap({
      db,
      title: 'Council recap',
      meetingName: 'Regular council',
    });
    await recap.initialize();
    await recap.save();

    const row = await readRow(
      db,
      'script_text, provider_last_event_at, recap_note, meeting_name',
      recap.id as string,
    );
    expect(row?.script_text).toBeNull();
    expect(row?.provider_last_event_at).toBeNull();
    expect(row?.recap_note).toBe('');
    expect(row?.meeting_name).toBe('Regular council');

    // The sibling class's own row still round-trips its values.
    const segment = new Issue3227Segment({
      db,
      title: 'Segment',
      scriptText: 'Hello',
      providerLastEventAt: '2026-09-30T00:00:00.000Z',
    });
    await segment.initialize();
    await segment.save();
    const segmentRow = await readRow(
      db,
      'script_text, provider_last_event_at, meeting_name',
      segment.id as string,
    );
    expect(segmentRow?.script_text).toBe('Hello');
    expect(segmentRow?.provider_last_event_at).toBe('2026-09-30T00:00:00.000Z');
    expect(segmentRow?.meeting_name).toBeNull();
  });
});
