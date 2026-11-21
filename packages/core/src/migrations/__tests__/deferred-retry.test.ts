/**
 * The pure rules of the deferred-phase retry check (#5325): which deferred
 * statements change session state, how a recorded plan tag reads, and how a
 * pinned session is put back. No database: the session is a fake that
 * behaves as PostgreSQL does for the statements the restore sends.
 */
import { describe, expect, it } from 'vitest';
import {
  CONCURRENT_INDEX_PHASE1_MARKER,
  captureSessionBaseline,
  changesSessionState,
  deferredNotStarted,
  phaseOneMessage,
  recordedPlan,
  restoreSessionBaseline,
} from '../deferred-retry.js';

describe('whether a deferred statement changes session state', () => {
  it.each([
    "SET app.tenant = 'x'",
    "SET LOCAL app.tenant TO 'x'",
    'SET search_path TO public',
    'SET ROLE other_role',
    'SET SESSION AUTHORIZATION DEFAULT',
    'set statement_timeout = 0',
    'RESET app.tenant',
    'RESET ALL',
    'DISCARD ALL',
    "SELECT set_config('app.tenant', 'x', false)",
    `SELECT "set_config"('app.tenant', 'x', false)`,
    "SELECT pg_catalog.set_config('app.tenant', 'x', false)",
    "SELECT * FROM set_config('app.tenant', 'x', false)",
    "SELECT 1 FROM child JOIN parent ON set_config('app.tenant', 'x', false) = 'x'",
    "CREATE INDEX child_tag_idx ON child (tag); SET app.tenant = 'x'",
    "SELECT 'unterminated",
  ])('refuses %s', (sql) => {
    expect(changesSessionState(sql)).toBe(true);
  });

  it.each([
    'CREATE INDEX IF NOT EXISTS t_idx ON t (a)',
    'CREATE INDEX set_config_idx ON set_config (name)',
    'CREATE UNIQUE INDEX set_config_uq ON public.set_config (name)',
    'CREATE INDEX set_config_only_idx ON ONLY set_config (name)',
    'ALTER TABLE set_config VALIDATE CONSTRAINT set_config_fk',
    "INSERT INTO set_config (name) VALUES ('x')",
    'ALTER TABLE child ADD FOREIGN KEY (pid) REFERENCES set_config (id)',
    "UPDATE child SET tag = 'x'",
    'ALTER TABLE child SET (fillfactor = 70)',
  ])('accepts %s, which changes no session state', (sql) => {
    expect(changesSessionState(sql)).toBe(false);
  });
});

describe('the plan tag a phase-1 marker carries', () => {
  const digest = 'a'.repeat(64);

  it.each([
    ` [smrt: plan sha256:${digest}]`,
    ` [smrt: plan sha256:${digest}] [smrt: deferred not started]`,
    ` [smrt: plan sha256:${digest}] | canceling statement due to lock timeout`,
    ` [smrt: plan sha256:${digest}] [smrt: deferred not started] | pending`,
  ])('reads a whole digest: %s', (rest) => {
    expect(recordedPlan(`${CONCURRENT_INDEX_PHASE1_MARKER}${rest}`)).toEqual({
      kind: 'digest',
      digest,
    });
  });

  it.each([
    ' Concurrent index build pending: the non-index half of this migration committed.',
    ' canceling statement due to lock timeout',
  ])('reads an older record as having no plan: %s', (rest) => {
    expect(recordedPlan(`${CONCURRENT_INDEX_PHASE1_MARKER}${rest}`)).toEqual({
      kind: 'absent',
    });
  });

  it.each([
    `  [smrt: plan sha256:${digest}]`,
    ` [smrt plan sha256:${digest}]`,
    ` [SMRT: plan sha256:${digest}]`,
    ` smrt: plan sha256:${digest}`,
    ` [smrt: plan sha256:${digest.slice(8)}]`,
    `\t[smrt: plan sha256:${digest}]`,
    ` [smrt: plan sha256:${digest}] [smrt: deferred not started]x`,
    ` [smrt: plan sha256:${digest}]x`,
    '',
  ])('reads damaged tag text as malformed: %j', (rest) => {
    expect(recordedPlan(`${CONCURRENT_INDEX_PHASE1_MARKER}${rest}`)).toEqual({
      kind: 'malformed',
    });
  });
});

describe('the not-started bit', () => {
  const digest = 'b'.repeat(64);

  it('is read from the tracker tags only', () => {
    expect(deferredNotStarted(phaseOneMessage(digest, true, 'pending'))).toBe(
      true,
    );
    expect(deferredNotStarted(phaseOneMessage(digest, false, 'pending'))).toBe(
      false,
    );
  });

  it('is never read from diagnostic text that begins with its tag', () => {
    const message = phaseOneMessage(
      digest,
      false,
      '[smrt: deferred not started] raised by a statement',
    );

    expect(deferredNotStarted(message)).toBe(false);
    expect(recordedPlan(message)).toEqual({ kind: 'digest', digest });
  });
});

/**
 * A session as PostgreSQL keeps it, for the statements the capture and the
 * restore send.
 */
function fakeSession(start: {
  lockTimeout: { setting: string; source: string };
  searchPath: string;
}) {
  const state = {
    lockTimeout: { ...start.lockTimeout },
    searchPath: start.searchPath,
    resets: [] as string[],
  };
  return {
    state,
    async query(sql: string, ...vars: unknown[]) {
      if (sql.includes('FROM pg_catalog.pg_settings'))
        return {
          rows: [
            { name: 'lock_timeout', ...state.lockTimeout },
            { name: 'statement_timeout', setting: '0', source: 'default' },
          ],
        };
      if (sql.includes('session_user AS session_name'))
        return {
          rows: [
            {
              session_name: 'admin',
              current_name: 'admin',
              search_path: state.searchPath,
            },
          ],
        };
      if (sql.startsWith('RESET ')) state.resets.push(sql.slice(6));
      else if (sql.includes('set_config') && vars[0] === 'lock_timeout')
        state.lockTimeout = { setting: String(vars[1]), source: 'session' };
      return { rows: [] };
    },
  };
}

describe('putting the session back', () => {
  it('puts back only the timeouts the tracker set', async () => {
    const session = fakeSession({
      lockTimeout: { setting: '7000', source: 'session' },
      searchPath: 'app, public',
    });
    const baseline = await captureSessionBaseline(session);
    // The tracker's own timeout.
    session.state.lockTimeout = { setting: '5000', source: 'session' };

    await restoreSessionBaseline(session, baseline);

    expect(session.state.lockTimeout.setting).toBe('7000');
    expect(session.state.resets).toEqual(['statement_timeout']);
  });

  it('fails closed when the search path changed', async () => {
    const session = fakeSession({
      lockTimeout: { setting: '0', source: 'default' },
      searchPath: 'app, public',
    });
    const baseline = await captureSessionBaseline(session);
    session.state.searchPath = 'other, public';

    await expect(restoreSessionBaseline(session, baseline)).rejects.toThrow(
      /not as it was handed over/,
    );
  });
});
