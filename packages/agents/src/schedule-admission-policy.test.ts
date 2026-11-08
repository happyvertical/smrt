import { GlobalInterceptors, getTestDatabase } from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSchedule, AgentScheduleCollection } from './schedule.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const policy = {
  version: 1 as const,
  requireIntegrity: true as const,
  queue: 'protected',
  keyId: 'old',
};
const dialects: ('sqlite' | 'duckdb' | 'postgres')[] = ['sqlite', 'duckdb'];
if (isPostgresAvailable()) dialects.push('postgres');
for (const type of dialects) {
  describe(`durable admission public saves (${type})`, () => {
    let db: DatabaseInterface;
    let admin: DatabaseInterface | undefined;
    let databaseName: string | undefined;
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close?.();
      if (admin && databaseName)
        await admin.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
      await admin?.close?.();
      admin = undefined;
      databaseName = undefined;
    });
    async function fixture() {
      if (type === 'postgres') {
        const baseUrl = process.env.DATABASE_URL ?? '';
        admin = await getTestDatabase({
          type,
          url: baseUrl,
          classes: [],
          includeSystemTables: false,
        });
        databaseName = `smrt_policy_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
        await admin.query(`CREATE DATABASE ${databaseName}`);
        const url = new URL(baseUrl);
        url.pathname = `/${databaseName}`;
        db = await getTestDatabase({
          type,
          url: url.toString(),
          classes: ['AgentSchedule'],
        });
      } else
        db = await getTestDatabase({
          type,
          url: ':memory:',
          classes: ['AgentSchedule'],
        });
      const schedules = await AgentScheduleCollection.create({ db });
      const row = await schedules.create({
        tenantId: tenant,
        slug: 'protected',
        agentType: 'Probe',
        cron: '* * * * *',
        enabled: false,
        methodArgs: { _scheduleAdmissionPolicy: policy },
      });
      await row.save();
      return { schedules, row };
    }
    it('rejects caller removal/change, preserves unrelated saves and sequential natural upserts', async () => {
      const { schedules, row } = await fixture();
      row.methodArgs = {};
      await expect(row.save()).rejects.toThrow(/explicit authorized/);
      row.methodArgs = { _scheduleAdmissionPolicy: policy, other: true };
      await row.save();
      const replacement = new AgentSchedule({
        db,
        tenantId: tenant,
        agentType: 'Probe',
        cron: '* * * * *',
      });
      await replacement.initialize();
      replacement.slug = 'protected';
      replacement.methodArgs = {};
      await expect(replacement.save()).rejects.toThrow(/explicit authorized/);
      replacement.methodArgs = {
        _scheduleAdmissionPolicy: policy,
        other: 'upsert',
      };
      await replacement.save();
      expect(replacement.id).toBe(row.id);
      expect((await schedules.get({ id: String(row.id) }))?.methodArgs).toEqual(
        replacement.methodArgs,
      );
    });
    it('requires explicit current authorization for rotation and preserves revision CAS', async () => {
      const { schedules, row } = await fixture();
      const stale = await schedules.get({ id: String(row.id) });
      if (!stale) throw new Error('Missing persisted schedule');
      const denied = vi.fn(async () => {
        throw new Error('revoked operator');
      });
      await expect(
        row.reconfigureAdmissionPolicy(
          { ...policy, keyId: 'new' },
          { authorize: denied },
        ),
      ).rejects.toThrow('revoked operator');
      expect(
        (await schedules.get({ id: String(row.id) }))?.methodArgs
          ._scheduleAdmissionPolicy,
      ).toEqual(policy);
      const authorize = vi.fn(async () => {});
      await row.reconfigureAdmissionPolicy(
        { ...policy, keyId: 'new' },
        { authorize },
      );
      expect(authorize).toHaveBeenCalledWith({
        scheduleId: row.id,
        tenantId: tenant,
        previousPolicy: policy,
        nextPolicy: { ...policy, keyId: 'new' },
      });
      await expect(
        stale.reconfigureAdmissionPolicy(null, { authorize }),
      ).rejects.toThrow();
      const current = await schedules.get({ id: String(row.id) });
      if (!current) throw new Error('Missing current schedule');
      expect(current.methodArgs._scheduleAdmissionPolicy).toEqual({
        ...policy,
        keyId: 'new',
      });
      await current.reconfigureAdmissionPolicy(null, { authorize });
      expect(
        (await schedules.get({ id: String(row.id) }))?.methodArgs,
      ).not.toHaveProperty('_scheduleAdmissionPolicy');
    });
    it('denies a real late natural collision and keeps guards isolated between instances', async () => {
      const { schedules } = await fixture();
      const pending = new AgentSchedule({
        db,
        tenantId: tenant,
        agentType: 'Probe',
        cron: '* * * * *',
      });
      await pending.initialize();
      pending.slug = 'late-collision';
      pending.methodArgs = {};
      let inserted = false;
      const interceptor = {
        name: `late-policy-fixture-${type}`,
        async beforeSave(instance: unknown) {
          if (instance !== pending || inserted) return;
          inserted = true;
          await schedules.create({
            tenantId: tenant,
            slug: 'late-collision',
            agentType: 'Probe',
            cron: '* * * * *',
            methodArgs: { _scheduleAdmissionPolicy: policy },
          });
        },
      };
      GlobalInterceptors.register(interceptor);
      try {
        await expect(pending.save()).rejects.toThrow();
      } finally {
        GlobalInterceptors.unregister(interceptor);
      }
      const rows = await schedules.list({ where: { slug: 'late-collision' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].methodArgs._scheduleAdmissionPolicy).toEqual(policy);
      // A different instance remains writable after the failed guarded save.
      const unrelated = await schedules.create({
        tenantId: tenant,
        slug: 'ordinary',
        agentType: 'Probe',
        cron: '* * * * *',
        methodArgs: { ordinary: true },
      });
      unrelated.methodArgs = { ordinary: 'updated' };
      await unrelated.save();
      expect(
        (await schedules.get({ id: String(unrelated.id) }))?.methodArgs,
      ).toEqual({ ordinary: 'updated' });
    });
    it('preserves unprotected sequential fresh-object natural upsert behavior', async () => {
      const { schedules } = await fixture();
      const first = await schedules.create({
        tenantId: tenant,
        slug: 'legacy',
        agentType: 'Probe',
        cron: '* * * * *',
        methodArgs: { value: 1 },
      });
      const second = new AgentSchedule({
        db,
        tenantId: tenant,
        agentType: 'Probe',
        cron: '* * * * *',
      });
      await second.initialize();
      second.slug = 'legacy';
      second.methodArgs = { value: 2 };
      await second.save();
      expect(second.id).toBe(first.id);
      expect(
        (await schedules.get({ id: String(first.id) }))?.methodArgs,
      ).toEqual({ value: 2 });
    });
    it('denies reconfiguration of a caller-mutated foreign tenant', async () => {
      const { row } = await fixture();
      row.tenantId = '22222222-2222-4222-8222-222222222222';
      const authorize = vi.fn(async () => {});
      await expect(
        row.reconfigureAdmissionPolicy(null, { authorize }),
      ).rejects.toThrow(/persisted schedule tenant/);
      expect(authorize).not.toHaveBeenCalled();
    });
  });
}
