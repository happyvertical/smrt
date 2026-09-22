/**
 * A second principal must not be able to observe another principal's session
 * id through `/_changes` or `/_events` (issue #2937).
 *
 * `Session`'s row **id is the bearer credential** — `createSession()` returns
 * it, it is the `sid` cookie value and the terminal-auth `accessToken`, and
 * `SessionService.loadSessionContext()` re-saves the row on every
 * authenticated request. The change feed records `{table, rowId, ...}` for
 * every observable table, and the generated feed routes authenticate the
 * caller but do not check permission per table, so a low-privilege station
 * could read `?tables=sessions` and replay an owner's id.
 *
 * The core-level unit coverage for the mechanism lives in
 * `packages/core/src/__tests__/issue-2937-change-feed-credential-tables.test.ts`.
 * This file is the end-to-end proof through the real `Session` model, the real
 * `SessionService` write path, and the real generated `_changes` route — the
 * exact shape the consumer reported.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANGE_FEED_TABLE,
  ensureChangeFeedTable,
  getChangesSince,
  isChangeFeedSensitiveTable,
  registerChangeFeedWriter,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionCollection } from '../collections/SessionCollection.js';
import { UserCollection } from '../collections/UserCollection.js';

const SESSIONS_TABLE = 'sessions';

/**
 * The generated REST handler with an auth middleware that admits every
 * principal — the route's only gate, and exactly the posture the consumer
 * reported: authenticated is all it takes.
 */
function createChangesHandler(
  db: DatabaseInterface,
): (req: Request) => Promise<Response> {
  const generator = new APIGenerator(
    {
      basePath: '/api',
      authMiddleware: () => async (req: Request) => req,
    },
    { db },
  );
  return generator.generateHandler();
}

describe('session ids never reach the change feed (issue #2937)', () => {
  let dbPath: string;
  let sessions: SessionCollection;
  let users: UserCollection;
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    dbPath = join(tmpdir(), `smrt-2937-session-feed-${Date.now()}.db`);
    const options = { db: { type: 'sqlite' as const, url: dbPath } };
    sessions = await SessionCollection.create(options);
    users = await UserCollection.create(options);
    db = sessions.db as DatabaseInterface;
    await ensureChangeFeedTable(db);
  });

  afterEach(async () => {
    // Close the handle before unlinking: an open SQLite handle can block the
    // delete and leave temp files behind.
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Best-effort cleanup; a leftover temp file must not fail the suite.
      }
    }
  });

  it('declares the sessions table credential-bearing', () => {
    // Both routes to the classification: the `@smrt({ sensitive: true })`
    // declaration on `Session` above, and core's baseline name list, which is
    // what holds in a process where this package never registered.
    expect(isChangeFeedSensitiveTable(SESSIONS_TABLE)).toBe(true);
  });

  it('writes no feed row when a session is created or its activity recorded', async () => {
    const owner = await users.create({ email: 'owner@example.com' });
    await owner.save();

    const session = await sessions.createSession({ userId: String(owner.id) });
    // The re-save every authenticated request performs.
    const loaded = await sessions.get(String(session.id));
    await loaded?.recordActivity();

    const rows = (await db.query(
      `SELECT COUNT(*) AS n FROM ${CHANGE_FEED_TABLE} WHERE table_name = ?`,
      SESSIONS_TABLE,
    )) as unknown as { rows?: { n: number }[] };
    const counted = Array.isArray(rows) ? rows : (rows.rows ?? []);
    expect(Number((counted[0] as { n?: unknown })?.n ?? 0)).toBe(0);
  });

  it("a second user cannot observe another user's session id through /_changes or /_events", async () => {
    const owner = await users.create({ email: 'owner2@example.com' });
    await owner.save();
    const station = await users.create({ email: 'station@example.com' });
    await station.save();

    const ownerSession = await sessions.createSession({
      userId: String(owner.id),
    });
    const stationSession = await sessions.createSession({
      userId: String(station.id),
    });
    const ownerSessionId = String(ownerSession.id);
    const stationSessionId = String(stationSession.id);
    expect(ownerSessionId).toBeTruthy();

    // The station is authenticated — the route's only gate — and asks for the
    // sessions table by name, exactly as the reported repro does.
    const handler = createChangesHandler(db);
    const response = await handler(
      new Request('http://localhost/api/_changes?since=0&tables=sessions'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      changes: { table: string; rowId: string | null }[];
    };
    expect(body.changes).toEqual([]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ownerSessionId);
    // Not even its own id: a route that confirmed the caller's session exists
    // would still be an oracle over the credential table.
    expect(serialized).not.toContain(stationSessionId);

    // An unfiltered sweep — the other half of the repro — must not surface
    // them either. This is also the `_events` catch-up read.
    const unfiltered = await getChangesSince(db, { since: 0 });
    const allRowIds = unfiltered.changes.map((change) => change.rowId);
    expect(allRowIds).not.toContain(ownerSessionId);
    expect(allRowIds).not.toContain(stationSessionId);
    expect(
      unfiltered.changes.some((change) => change.table === SESSIONS_TABLE),
    ).toBe(false);
  });
});
