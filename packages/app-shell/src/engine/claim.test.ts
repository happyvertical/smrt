// The claim's transaction wrapper (#5470) on a fake connection: what runs in
// every claim transaction, when the claim is lost, and the heartbeat. The
// real proof (`pg_locks` of a real session) is the server lane's
// (`store-in-swap.test.ts`, `postgres-claim-connection.test.ts`).
import { describe, expect, it } from 'vitest';
import { createClaim } from './db/claim.ts';
import { ClaimLostError, EngineError } from './index.ts';

/** A connection of one: records what each transaction ran. */
function fake() {
  const log: string[] = [];
  const raw = {
    transaction: async <T>(cb: (tx: any) => Promise<T>) => {
      log.push('begin');
      const tx = {
        query: async (sql: string, params?: unknown[]) => {
          log.push(sql.replace(/\s+/g, ' ').slice(0, 40));
          if (/set_config/.test(sql)) log.push(JSON.stringify(params));
          return { rows: [] };
        },
      };
      try {
        const out = await cb(tx);
        log.push('commit');
        return out;
      } catch (e) {
        log.push('rollback');
        throw e;
      }
    },
  };
  return { raw, log };
}

describe('the claim connection', () => {
  it('bounds and proves every transaction before the caller runs', async () => {
    const { raw, log } = fake();
    const claim = createClaim(
      raw,
      'app_x',
      { heartbeatMs: 0 },
      undefined,
      async () => {
        log.push('proof');
        return true;
      },
    );
    await claim.transaction(async () => {
      log.push('body');
    });
    expect(log.filter((l) => !l.startsWith('SELECT'))).toEqual([
      'begin',
      '["5000ms","10000ms","10000ms"]',
      'proof',
      'body',
      'commit',
    ]);
  });

  it('a failed proof loses the claim: nothing runs, onLost fires once, every later call refuses', async () => {
    const { raw, log } = fake();
    let held = true;
    const claim = createClaim(
      raw,
      'app_x',
      { heartbeatMs: 0 },
      undefined,
      async () => held,
    );
    const lost: Error[] = [];
    claim.onLost((e) => lost.push(e));
    await claim.transaction(async () => {});
    held = false;
    let ran = false;
    const err = await claim
      .transaction(async () => {
        ran = true;
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ClaimLostError);
    expect(err.code).toBe('stale_fence');
    expect(err.details).toMatchObject({ resource: 'claim' });
    expect(ran).toBe(false);
    expect(claim.lost).toBe(true);
    expect(lost).toHaveLength(1);
    held = true; // it never reacquires
    await expect(claim.transaction(async () => {})).rejects.toBeInstanceOf(
      ClaimLostError,
    );
    expect(lost).toHaveLength(1);
    expect(log.filter((l) => l === 'commit')).toHaveLength(1);
  });

  it('refuses a transaction opened inside another (one connection would deadlock)', async () => {
    const { raw } = fake();
    const claim = createClaim(
      raw,
      'app_x',
      { heartbeatMs: 0 },
      undefined,
      async () => true,
    );
    const err = await claim
      .transaction(async () => claim.transaction(async () => {}))
      .catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(String(err.message)).toMatch(/cannot open another/);
    expect(claim.lost).toBe(false);
    await claim.transaction(async () => {});
  });

  it('a connection error re-proves at once and loses the claim when the proof fails', async () => {
    const { raw } = fake();
    let held = true;
    const claim = createClaim(
      raw,
      'app_x',
      { heartbeatMs: 0 },
      undefined,
      async () => held,
    );
    await expect(
      claim.transaction(async () => {
        held = false;
        throw Object.assign(new Error('Connection terminated'), {
          code: '57P01',
        });
      }),
    ).rejects.toBeInstanceOf(ClaimLostError);
    expect(claim.lost).toBe(true);
    // A statement error that is not the connection leaves the claim alone.
    const ok = createClaim(
      raw,
      'app_x',
      { heartbeatMs: 0 },
      undefined,
      async () => true,
    );
    await expect(
      ok.transaction(async () => {
        throw new Error('syntax error');
      }),
    ).rejects.toThrow(/syntax/);
    expect(ok.lost).toBe(false);
  });

  it('the heartbeat proves the claim on its own and loses it when the proof fails', async () => {
    const { raw } = fake();
    let held = true;
    const claim = createClaim(
      raw,
      'app_x',
      { heartbeatMs: 10 },
      undefined,
      async () => held,
    );
    const lost = new Promise<Error>((resolve) => claim.onLost(resolve));
    await new Promise((r) => setTimeout(r, 40));
    expect(claim.lost).toBe(false);
    held = false;
    expect(await lost).toBeInstanceOf(ClaimLostError);
    await claim.release();
  });
});
