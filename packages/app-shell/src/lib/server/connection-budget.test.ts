// The cloud profile's process-wide connection budget and what an owner is told
// when a database fails (#5464). WHAT THIS PROVES: the budget's accounting and
// refusal, that a failed open gives its connections back, and that a driver's
// text never reaches the owner. WHAT IT DOES NOT: a real server's connection
// limit (PostgreSQL is the on-demand workflow's); the "postgres" configs below
// point at a port nothing listens on, so no connection is ever made.
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConfig, PGliteClient } from '../../engine/db/index.ts';
import { EngineError } from '../../engine/index.ts';
import { addChangeCard, flushChecks } from './changes.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import {
  closeHost,
  configureShell,
  getDraftSlot,
  getHost,
  hostMetrics,
} from './host.ts';
import { HostLifecycle } from './host-lifecycle.ts';
import { HttpError } from './http.ts';
import { runAs } from './owner.ts';
import { GENERIC_OWNER_ERROR, ownerMessage } from './owner-errors.ts';

describe('HostLifecycle connection budget', () => {
  it('refuses at once when the budget is spent, and a release returns it', () => {
    const l = new HostLifecycle();
    l.configure({ maxAppConnections: 4 });
    const a = l.takeConnections(2);
    l.takeConnections(2);
    expect(l.connectionsInUse).toBe(4);
    expect(() => l.takeConnections(2)).toThrow(/no database connections left/);
    a();
    a(); // a second release changes nothing
    expect(l.connectionsInUse).toBe(2);
    expect(() => l.takeConnections(2)).not.toThrow();
  });

  it('derives the budget from maxOpenApps: a live and a draft worker per app', () => {
    const l = new HostLifecycle();
    l.configure({ maxOpenApps: 2 });
    for (let i = 0; i < 4; i++) l.takeConnections(2); // 2 apps x 2 workers
    expect(() => l.takeConnections(2)).toThrow(EngineError);
  });

  it('limits nothing without a policy or without any cap', () => {
    const l = new HostLifecycle();
    for (let i = 0; i < 50; i++) l.takeConnections(10);
    l.configure({ idleMs: 1000 });
    for (let i = 0; i < 50; i++) l.takeConnections(10);
  });

  it('refuses a bad value and forgets the count on reset', () => {
    const l = new HostLifecycle();
    expect(() => l.configure({ maxAppConnections: 0 })).toThrow(RangeError);
    l.configure({ maxAppConnections: 2 });
    const release = l.takeConnections(2);
    l.configure({ maxAppConnections: 2 });
    release(); // an old release must not push the new count below zero
    expect(l.connectionsInUse).toBe(0);
    l.takeConnections(2);
    expect(l.connectionsInUse).toBe(2);
  });
});

describe('ownerMessage', () => {
  it('keeps our own messages and hides a driver error, logging the detail', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(ownerMessage(new EngineError('no such model', 'not_found'))).toBe(
      'no such model',
    );
    expect(ownerMessage(new HttpError(400, 'bad input'))).toBe('bad input');
    const driver = new Error(
      'connect ECONNREFUSED db.internal.example:5432 as svc_app',
    );
    expect(ownerMessage(driver)).toBe(GENERIC_OWNER_ERROR);
    expect(ownerMessage(driver, 'it failed')).toBe('it failed');
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('db.internal.example'),
    );
    log.mockRestore();
  });
});

let h: CloudHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const NOWHERE = 'postgres://svc_app@db.internal.example:1/apps';
const unreachable = (max: number) => ({
  config: (schema: string): DatabaseConfig => ({
    kind: 'postgres',
    schema,
    connection: { url: NOWHERE, max },
  }),
  provision: async () => {},
});

describe('a hosted app on the budget', () => {
  it('is refused at once when its pool does not fit, and says so plainly', async () => {
    h = await openCloudShell({
      appDatabase: unreachable(2),
      lifecycle: { maxAppConnections: 1 },
    });
    const started = Date.now();
    await expect(runAs(h.a, () => getHost())).rejects.toThrow(
      /no database connections left/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hostMetrics().connections).toBe(0);
  });

  it('gives the connections back when the open fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h = await openCloudShell({
      appDatabase: unreachable(2),
      lifecycle: { maxAppConnections: 2 },
    });
    for (let i = 0; i < 2; i++) {
      // Not the budget's refusal: the open itself fails (nothing listens).
      const err = await runAs(h.a, () => getHost()).catch((e) => e);
      expect(String(err?.message)).not.toMatch(/no database connections left/);
      expect(hostMetrics().connections).toBe(0);
    }
    log.mockRestore();
  });
});

describe('a draft that cannot open', () => {
  it('tells the owner a fixed sentence and keeps the driver text in the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { PGlite } = await importPGlite();
    const pg = (await PGlite.create()) as PGliteClient;
    let broken = false;
    // The side schema's queries fail the way a lost connection does.
    const client = new Proxy(pg, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== 'function') return v;
        // PGlite keeps private fields: always call it on the instance itself.
        if (prop !== 'query' && prop !== 'exec') return v.bind(target);
        return (sql: string, ...rest: unknown[]) => {
          if (broken && `${sql}${JSON.stringify(rest)}`.includes('__d'))
            throw new Error(
              'connect ECONNREFUSED db.internal.example:5432 (user svc_app)',
            );
          return v.call(target, sql, ...rest);
        };
      },
    }) as PGliteClient;
    h = await openCloudShell({
      appDatabase: {
        config: (schema): DatabaseConfig => ({
          kind: 'pglite',
          schema,
          client,
        }),
        provision: async (schema) => {
          await pg.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        },
      },
    });
    await runAs(h.a, () =>
      addChangeCard({
        commands: [{ type: 'defineModel', name: 'Later', fields: {} } as never],
        source: 'api',
      }),
    );
    await flushChecks();
    await closeHost(); // a restart: the draft is adopted again
    broken = true;
    const slot = await runAs(h.a, () => getDraftSlot());
    await closeHost();
    expect(slot?.problem).toBeTruthy();
    expect(slot?.problem).not.toMatch(/db\.internal|svc_app|ECONNREFUSED/);
    expect(
      log.mock.calls.some((c) => String(c[1]).includes('db.internal.example')),
    ).toBe(true);
    log.mockRestore();
    await pg.close().catch(() => {});
  });
});
