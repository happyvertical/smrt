import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@happyvertical/smrt-core', () => ({ getTestDatabase: state.get }));

import { withScratchDatabase } from './helpers/postgres-scratch.js';

describe('owned PostgreSQL scratch cleanup role separation', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://fixture_runner@localhost:5432/test');
    vi.stubEnv(
      'SMRT_TEST_POSTGRES_ADMIN_URL',
      'postgres://fixture_admin@localhost:5432/control',
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });
  function fixture() {
    const setup: (() => Promise<void>)[] = [],
      teardown: (() => Promise<void>)[] = [];
    const runtime = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.startsWith('SELECT') ? [{ owner: 'fixture_runner' }] : [],
      })),
      close: vi.fn(async () => {}),
    };
    const control = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.startsWith('SELECT') ? [{ owner: 'fixture_runner' }] : [],
      })),
      close: vi.fn(async () => {}),
    };
    state.get.mockImplementation(async ({ url }: { url: string }) =>
      url.includes('fixture_admin') ? control : runtime,
    );
    const helper = withScratchDatabase(
      (fn) => {
        setup.push(fn);
      },
      (fn) => {
        teardown.push(fn);
      },
    );
    return { helper, runtime, control, setup, teardown };
  }
  it('uses the ordinary role for setup/tests and owner-verified administrator only for cleanup', async () => {
    const f = fixture();
    await f.setup[0]();
    const closed = vi.fn(async () => {});
    f.helper.track({ close: closed } as unknown as DatabaseInterface);
    await f.teardown[0]();
    expect(
      f.runtime.query.mock.calls.some(([sql]) =>
        sql.startsWith('CREATE DATABASE'),
      ),
    ).toBe(true);
    expect(
      f.runtime.query.mock.calls.some(([sql]) =>
        sql.startsWith('DROP DATABASE'),
      ),
    ).toBe(false);
    expect(
      f.control.query.mock.calls.some(([sql]) =>
        /^DROP DATABASE IF EXISTS smrt_messages_[a-f0-9]{16} WITH \(FORCE\)$/.test(
          sql,
        ),
      ),
    ).toBe(true);
    expect(
      f.control.query.mock.calls.some(([sql]) => sql.startsWith('CREATE')),
    ).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(f.control.close).toHaveBeenCalledTimes(1);
    expect(f.runtime.close).toHaveBeenCalledTimes(1);
  });
  it('settles every tracked handle and releases cleanup pools even when one close fails', async () => {
    const f = fixture();
    await f.setup[0]();
    const closed = vi.fn(async () => {});
    f.helper.track({
      close: async () => {
        throw new Error('fixture close failure');
      },
    } as unknown as DatabaseInterface);
    f.helper.track({ close: closed } as unknown as DatabaseInterface);
    await expect(f.teardown[0]()).rejects.toThrow('cleanup failed');
    expect(closed).toHaveBeenCalled();
    expect(f.control.close).toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalled();
  });
  it('refuses a different control-plane cluster or changed database owner', async () => {
    const f = fixture();
    await f.setup[0]();
    vi.stubEnv(
      'SMRT_TEST_POSTGRES_ADMIN_URL',
      'postgres://fixture_admin@other-host:5432/control',
    );
    await expect(f.teardown[0]()).rejects.toThrow('cleanup failed');
    expect(f.control.query).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalled();
    vi.stubEnv(
      'SMRT_TEST_POSTGRES_ADMIN_URL',
      'postgres://fixture_admin@localhost:5432/control',
    );
    const changed = fixture();
    await changed.setup[0]();
    changed.control.query.mockResolvedValue({
      rows: [{ owner: 'someone_else' }],
    });
    await expect(changed.teardown[0]()).rejects.toThrow('cleanup failed');
    expect(
      changed.control.query.mock.calls.some(([sql]) => sql.startsWith('DROP')),
    ).toBe(false);
  });
});
