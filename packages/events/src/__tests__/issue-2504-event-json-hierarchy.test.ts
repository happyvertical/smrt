import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { Event, EventCollection } from '../index.js';

@smrt()
class Issue2504Meeting extends Event {}

class Issue2504MeetingCollection extends SmrtCollection<Issue2504Meeting> {
  static readonly _itemClass = Issue2504Meeting;
}

describe('Event hierarchy on the DuckDB-backed JSON adapter (#2504)', () => {
  let testDir: string | undefined;

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it('persists an STI child parentId and rehydrates it by _meta_type after reload', async () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-event-json-hierarchy-'));
    const db = await getDatabase({
      type: 'json',
      url: testDir,
      writeStrategy: 'immediate',
    });
    await getTestDatabase({
      db,
      classes: ['Event'],
      includeSystemTables: false,
    });
    const events = await EventCollection.create({ db });
    const meetings = await Issue2504MeetingCollection.create({ db });
    const root = await events.create({ name: 'Council session' });
    const child = await meetings.create({
      name: 'Public hearing',
      parentId: root.id,
    });

    const reloadedDb = await getDatabase({
      type: 'json',
      url: testDir,
      writeStrategy: 'immediate',
    });
    const reloadedEvents = await EventCollection.create({ db: reloadedDb });
    const reloaded = await reloadedEvents.list({});
    const reloadedChild = reloaded.find((event) => event.id === child.id);

    expect(reloadedChild).toBeInstanceOf(Issue2504Meeting);
    expect(reloadedChild?.parentId).toBe(root.id);
    expect((await reloadedChild?.getParent())?.id).toBe(root.id);

    const subtypeRows = await reloadedDb.query<{
      id: string;
      parent_id: string;
    }>('SELECT id, parent_id FROM events WHERE _meta_type = ?', [
      '@happyvertical/smrt-events:Issue2504Meeting',
    ]);
    expect(subtypeRows.rows).toEqual([
      expect.objectContaining({ id: child.id, parent_id: root.id }),
    ]);
  });
});
