/**
 * The pure rules of the deferred-phase retry check (#5325): which session
 * settings a deferred statement names, how a recorded plan tag reads, and
 * how a pinned session is put back. No database: the session is a fake that
 * behaves as PostgreSQL does for the statements the restore sends.
 */
import { describe, expect, it } from 'vitest';
import {
  CONCURRENT_INDEX_PHASE1_MARKER,
  captureSessionBaseline,
  recordedPlan,
  restoreSessionBaseline,
  sessionSettingTargets,
} from '../deferred-retry.js';

describe('the settings a deferred statement names', () => {
  it.each([
    ["SET app.tenant = 'x'", ['app.tenant']],
    [`SET "app.tenant" = 'x'`, ['app.tenant']],
    [`SET LOCAL app."Tenant" TO 'x'`, ['app.tenant']],
    ["SET session.tenant = 'x'", ['session.tenant']],
    ['RESET app.tenant', ['app.tenant']],
    [`SELECT "set_config"('app.tenant', 'x', false)`, ['app.tenant']],
    ["SELECT pg_catalog.set_config('App.Tenant', 'x', false)", ['app.tenant']],
    ['SET search_path TO public', []],
    ['SET ROLE NONE', []],
    ['SET SESSION AUTHORIZATION DEFAULT', []],
    ['CREATE INDEX IF NOT EXISTS t_idx ON t (a)', []],
  ])('reads %s completely', (sql, expected) => {
    expect(sessionSettingTargets(sql)).toEqual(expected);
  });

  it.each([
    'RESET ALL',
    'DISCARD ALL',
    "SELECT set_config('app.' || 'tenant', 'x', false)",
    "SELECT set_config('app.'\n'tenant', 'x', false)",
    "SELECT set_config(current_user || '.x', 'y', false)",
    "SELECT set_config(E'app.tenant', 'x', false)",
    "SELECT set_config($$app.tenant$$, 'x', false)",
    "SELECT set_config(setting_name => 'app.tenant', new_value => 'x', is_local => false)",
    `SELECT "set_config"('app.' || 'x', 'y', false)`,
    "SELECT set_config(U&'app.tenant', 'x', false)",
    "SET app. = 'x'",
    'SET app.tenant FROM CURRENT',
    'RESET app.tenant extra',
    "SET 'app.tenant' = 'x'",
  ])('refuses %s, whose target is not read completely', (sql) => {
    expect(sessionSettingTargets(sql)).toBeNull();
  });
});

describe('the plan tag a phase-1 marker carries', () => {
  const digest = 'a'.repeat(64);

  it.each([
    ` [smrt: plan sha256:${digest}]`,
    ` [smrt: plan sha256:${digest}] [smrt: deferred not started]`,
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
    '',
  ])('reads damaged tag text as malformed: %j', (rest) => {
    expect(recordedPlan(`${CONCURRENT_INDEX_PHASE1_MARKER}${rest}`)).toEqual({
      kind: 'malformed',
    });
  });
});

/**
 * A session as PostgreSQL keeps it, for the statements the capture and the
 * restore send. `RESET ROLE` returns to the role configured at login.
 */
function fakeSession(start: {
  sessionUser: string;
  loginRole: string;
  role: string;
  ignoreSetRole?: boolean;
}) {
  const state = { ...start };
  const currentUser = () =>
    state.role === 'none' ? state.sessionUser : state.role;
  return {
    state,
    currentUser,
    async query(sql: string) {
      if (sql === 'RESET ROLE') state.role = state.loginRole;
      else if (/^SET ROLE /.test(sql)) {
        if (!state.ignoreSetRole)
          state.role =
            sql === 'SET ROLE NONE' ? 'none' : sql.slice(9).replaceAll('"', '');
      } else if (sql.includes("current_setting('role')"))
        return {
          rows: [
            {
              session_name: state.sessionUser,
              current_name: currentUser(),
              role_name: state.role,
            },
          ],
        };
      else if (sql.includes('session_user AS session_name'))
        return { rows: [{ session_name: state.sessionUser }] };
      return { rows: [] };
    },
  };
}

describe('putting the session back', () => {
  it('restores a handed-over role of none even when the login set a role', async () => {
    const session = fakeSession({
      sessionUser: 'admin',
      loginRole: 'login_role',
      role: 'none',
    });
    const baseline = await captureSessionBaseline(session);
    // A deferred statement changed the role.
    session.state.role = 'other_role';

    await restoreSessionBaseline(session, baseline);

    expect(session.state.role).toBe('none');
    expect(session.currentUser()).toBe('admin');
  });

  it('fails closed when the identity does not come back', async () => {
    const session = fakeSession({
      sessionUser: 'admin',
      loginRole: 'none',
      role: 'handed_role',
    });
    const baseline = await captureSessionBaseline(session);
    session.state.ignoreSetRole = true;

    await expect(restoreSessionBaseline(session, baseline)).rejects.toThrow(
      /could not be put back/,
    );
  });
});
