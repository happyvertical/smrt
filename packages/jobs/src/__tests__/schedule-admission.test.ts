import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHmacDurableJobPayloadSigner,
  type DurableJobPayloadSigner,
} from '../durable-payload-integrity.js';
import {
  getScheduleAdmissionPayload,
  verifyScheduleAdmission,
} from '../schedule-admission.js';
import {
  ScheduleRunner,
  type ScheduleRunnerConfig,
} from '../schedule-runner.js';
import { SmrtJob, SmrtJobCollection } from '../smrt-job.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const scheduleId = '33333333-3333-4333-8333-333333333333';
const signer = createHmacDurableJobPayloadSigner({
  keyId: 'old-key',
  key: 'synthetic-schedule-admission-key-old-32-bytes',
});

for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`schedule occurrence admission integrity (${type})`, () => {
    let db: DatabaseInterface;
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close?.();
    });
    async function fixture(
      occurrenceSigner: DurableJobPayloadSigner | null = signer,
    ) {
      db = await getTestDatabase({ type, url: ':memory:' });
      await SmrtJobCollection.create({ db });
      await db.query(`CREATE TABLE _smrt_agent_schedules (
        id ${type === 'duckdb' ? 'UUID' : 'TEXT'} PRIMARY KEY,
        tenant_id ${type === 'duckdb' ? 'UUID' : 'TEXT'}, agent_type TEXT,
        agent_id TEXT, agent_config TEXT, cron TEXT, timezone TEXT, method TEXT,
        method_args TEXT, timeout INTEGER, enabled BOOLEAN, status TEXT,
        next_run TEXT, running_count INTEGER, max_concurrent INTEGER, last_error TEXT)`);
      await db.query(
        `INSERT INTO _smrt_agent_schedules
        (id, tenant_id, agent_type, agent_config, cron, timezone, method, method_args,
         enabled, status, next_run, running_count, max_concurrent)
        VALUES (?, ?, 'Probe', ?, '* * * * *', 'UTC', 'run', ?, TRUE, 'active',
         '2026-01-01T00:00:00.000Z', 0, 1)`,
        scheduleId,
        tenant,
        JSON.stringify({ constructorConsent: { mode: 'synthetic' } }),
        JSON.stringify({
          staticConsent: {
            projectId: 'project-a',
            operatorId: 'operator-a',
            configuration: 'exact',
          },
        }),
      );
      const runner = new ScheduleRunner({
        occurrenceSigner,
      } as ScheduleRunnerConfig);
      await runner.initialize(db);
      return {
        runner,
        poll: () => (runner as unknown as { poll(): Promise<void> }).poll(),
      };
    }
    async function actualJob() {
      const jobs = await SmrtJobCollection.create({ db });
      const rows = await jobs.list({ limit: 10 });
      expect(rows).toHaveLength(1);
      return rows[0];
    }
    it('signs the actual persisted row inside admission and rejects copied consent or occurrence identity', async () => {
      const { runner, poll } = await fixture();
      let triggered = false;
      runner.on('schedule:triggered', () => {
        triggered = true;
      });
      await poll();
      expect(triggered).toBe(true);
      const job = await actualJob();
      expect(verifyScheduleAdmission(job, signer)).toBe(true);
      expect(getScheduleAdmissionPayload(job, signer.keyId)).toMatchObject({
        purpose: 'smrt.schedule-admission',
        version: 1,
        keyId: signer.keyId,
        jobId: job.id,
        tenantId: tenant,
        scheduleId,
        scheduledFor: '2026-01-01T00:00:00.000Z',
        queue: 'agents',
        objectType: 'Probe',
        objectId: null,
        method: 'run',
        args: {
          staticConsent: { projectId: 'project-a' },
          _agentConfig: { constructorConsent: { mode: 'synthetic' } },
        },
      });
      const snapshot = {
        id: job.id,
        tenantId: job.tenantId,
        queue: job.queue,
        objectType: job.objectType,
        objectId: job.objectId,
        method: job.method,
        args: JSON.parse(JSON.stringify(job.args)),
      };
      for (const changed of [
        { ...snapshot, id: '44444444-4444-4444-8444-444444444444' },
        { ...snapshot, tenantId: '22222222-2222-4222-8222-222222222222' },
        { ...snapshot, queue: 'other' },
        { ...snapshot, objectType: 'Other' },
        { ...snapshot, objectId: 'other-agent' },
        { ...snapshot, method: 'other' },
        {
          ...snapshot,
          args: { ...snapshot.args, _scheduledFor: '2025-01-01T00:00:00.000Z' },
        },
        {
          ...snapshot,
          args: { ...snapshot.args, _scheduleId: 'another-schedule' },
        },
        {
          ...snapshot,
          args: { ...snapshot.args, staticConsent: { projectId: 'project-b' } },
        },
        {
          ...snapshot,
          args: {
            ...snapshot.args,
            _agentConfig: { constructorConsent: { mode: 'changed' } },
          },
        },
        { ...snapshot, args: { ...snapshot.args, extra: true } },
        {
          ...snapshot,
          args: { ...snapshot.args, _scheduleAdmission: undefined },
        },
      ])
        expect(verifyScheduleAdmission(changed, signer)).toBe(false);
      expect(
        getScheduleAdmissionPayload(job, signer.keyId).args,
      ).not.toHaveProperty('_scheduleAdmission');
    });
    it('rolls back the inserted job and occurrence if signing fails, then retries the same due slot', async () => {
      let fail = true;
      const { poll } = await fixture({
        keyId: signer.keyId,
        verify: signer.verify,
        sign(payload) {
          if (fail) throw new Error('synthetic signing unavailable');
          return signer.sign(payload);
        },
      });
      await poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
      const row = (
        await db.query(
          'SELECT next_run, running_count, last_error FROM _smrt_agent_schedules',
        )
      ).rows[0];
      expect(row.next_run).toBe('2026-01-01T00:00:00.000Z');
      expect(Number(row.running_count)).toBe(0);
      expect(row.last_error).toContain('signing unavailable');
      fail = false;
      await poll();
      expect(verifyScheduleAdmission(await actualJob(), signer)).toBe(true);
    });
    it('signs and saves only inside the open admission transaction and exposes a signed row at the committed event', async () => {
      let depth = 0;
      let signed = 0;
      let saved = 0;
      const { runner, poll } = await fixture({
        keyId: signer.keyId,
        verify: signer.verify,
        sign(payload) {
          expect(depth).toBeGreaterThan(0);
          signed++;
          return signer.sign(payload);
        },
      });
      if (!db.transaction) throw new Error('transaction support required');
      const transact = db.transaction.bind(db);
      db.transaction = async (work) =>
        transact(async (tx) => {
          depth++;
          try {
            return await work(tx);
          } finally {
            depth--;
          }
        });
      const save = SmrtJob.prototype.save;
      vi.spyOn(SmrtJob.prototype, 'save').mockImplementation(async function (
        this: SmrtJob,
        options,
      ) {
        if (this.args._scheduleAdmission) {
          expect(depth).toBeGreaterThan(0);
          saved++;
        }
        return save.call(this, options);
      });
      let observed: Promise<void> | undefined;
      runner.on('schedule:triggered', () => {
        expect(depth).toBe(0);
        observed = actualJob().then((job) => {
          expect(verifyScheduleAdmission(job, signer)).toBe(true);
        });
      });
      await poll();
      expect(observed).toBeDefined();
      await observed;
      expect(signed).toBe(1);
      expect(saved).toBe(1);
    });
    it('rolls back an invalid signature or failed protected save without consuming the due slot', async () => {
      const { poll } = await fixture();
      const save = SmrtJob.prototype.save;
      vi.spyOn(SmrtJob.prototype, 'save').mockImplementation(async function (
        this: SmrtJob,
        options,
      ) {
        const result = await save.call(this, options);
        if (this.args._scheduleAdmission)
          throw new Error('synthetic protected save failure');
        return result;
      });
      await poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('SELECT next_run FROM _smrt_agent_schedules')).rows[0]
          .next_run,
      ).toBe('2026-01-01T00:00:00.000Z');
      vi.restoreAllMocks();
      const invalid = new ScheduleRunner({
        occurrenceSigner: {
          keyId: signer.keyId,
          verify: signer.verify,
          sign: () => ({
            version: 1,
            keyId: 'missing-key',
            signature: 'invalid',
          }),
        },
      });
      await invalid.initialize(db);
      await (invalid as unknown as { poll(): Promise<void> }).poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('SELECT next_run FROM _smrt_agent_schedules')).rows[0]
          .next_run,
      ).toBe('2026-01-01T00:00:00.000Z');
    });
    it('preserves exact signature through public retry and permits a retained old verification key only', async () => {
      const { poll } = await fixture();
      await poll();
      const job = await actualJob();
      const original = JSON.stringify(job.args._scheduleAdmission);
      await job.cancel();
      await job.retry();
      const retried = await actualJob();
      expect(JSON.stringify(retried.args._scheduleAdmission)).toBe(original);
      expect(verifyScheduleAdmission(retried, signer)).toBe(true);
      const current = createHmacDurableJobPayloadSigner({
        keyId: 'new-key',
        key: 'synthetic-schedule-admission-key-new-32-bytes',
      });
      const keyring: DurableJobPayloadSigner = {
        keyId: current.keyId,
        sign: current.sign,
        verify: (payload, integrity) =>
          integrity.keyId === signer.keyId
            ? signer.verify(payload, integrity)
            : current.verify(payload, integrity),
      };
      expect(verifyScheduleAdmission(retried, keyring)).toBe(true);
      expect(verifyScheduleAdmission(retried, current)).toBe(false);
    });
    it('preserves legacy unsigned behavior and rejects row-supplied admission metadata', async () => {
      const { poll } = await fixture(null);
      await poll();
      expect((await actualJob()).args).not.toHaveProperty('_scheduleAdmission');
      expect(verifyScheduleAdmission(await actualJob(), signer)).toBe(false);
      await db.query('DELETE FROM _smrt_jobs');
      await db.query(
        "UPDATE _smrt_agent_schedules SET next_run='2026-01-01T00:00:00.000Z', method_args=?",
        JSON.stringify({
          _scheduleAdmission: {
            version: 1,
            keyId: 'forged',
            signature: 'forged',
          },
        }),
      );
      await poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('SELECT last_error FROM _smrt_agent_schedules')).rows[0]
          .last_error,
      ).toContain('reserved _scheduleAdmission');
    });
  });
}

describe('pure occurrence signature envelope validation', () => {
  function job() {
    const row = {
      id: 'job-a',
      tenantId: 'tenant-a',
      queue: 'agents',
      objectType: 'Probe',
      objectId: null,
      method: 'run',
      args: {
        _scheduleId: 'schedule-a',
        _scheduledFor: '2026-01-01T00:00:00.000Z',
        consent: {
          z: 1,
          a: 'original',
          at: new Date('2026-01-01T00:00:00.000Z'),
        },
      } as Record<string, unknown>,
    };
    row.args._scheduleAdmission = signer.sign(
      getScheduleAdmissionPayload(row, signer.keyId),
    );
    return row;
  }
  it('verifies canonical persisted JSON while snapshotting every argument except the signature', () => {
    const row = job();
    const persisted = JSON.parse(JSON.stringify(row));
    persisted.args.consent = {
      a: 'original',
      at: '2026-01-01T00:00:00.000Z',
      z: 1,
    };
    expect(verifyScheduleAdmission(persisted, signer)).toBe(true);
    const global = {
      ...persisted,
      tenantId: null,
      args: { ...persisted.args },
    };
    global.args._scheduleAdmission = signer.sign(
      getScheduleAdmissionPayload(global, signer.keyId),
    );
    expect(verifyScheduleAdmission(global, signer)).toBe(true);
    const payload = getScheduleAdmissionPayload(row, signer.keyId);
    (row.args.consent as Record<string, unknown>).a = 'changed';
    expect(payload.args.consent).toMatchObject({ a: 'original' });
    expect(verifyScheduleAdmission(row, signer)).toBe(false);
    const proto = job();
    proto.args.metadata = JSON.parse('{"__proto__":{"scope":"original"}}');
    proto.args._scheduleAdmission = signer.sign(
      getScheduleAdmissionPayload(proto, signer.keyId),
    );
    expect(
      verifyScheduleAdmission(JSON.parse(JSON.stringify(proto)), signer),
    ).toBe(true);
    const ownPrototype = Object.getOwnPropertyDescriptor(
      proto.args.metadata,
      '__proto__',
    )?.value as { scope: string };
    ownPrototype.scope = 'changed';
    expect(verifyScheduleAdmission(proto, signer)).toBe(false);
  });
  it('rejects missing, unknown or malformed metadata and alternative purpose/version/key payloads', () => {
    const row = job();
    const integrity = row.args._scheduleAdmission as Record<string, unknown>;
    for (const value of [
      undefined,
      null,
      [],
      {},
      { ...integrity, version: 2 },
      { ...integrity, keyId: 'unknown' },
      { ...integrity, signature: null },
      { ...integrity, extra: 'unrecognized' },
    ]) {
      expect(
        verifyScheduleAdmission(
          { ...row, args: { ...row.args, _scheduleAdmission: value } },
          signer,
        ),
      ).toBe(false);
    }
    for (const changed of [
      null,
      'job',
      {},
      { ...row, tenantId: undefined },
      { ...row, objectId: undefined },
      { ...row, args: [] },
      { ...row, args: { ...row.args, _scheduleId: 1 } },
      { ...row, args: { ...row.args, _scheduledFor: '2026-01-01T00:00:00Z' } },
    ]) {
      expect(verifyScheduleAdmission(changed, signer)).toBe(false);
    }
    const payload = getScheduleAdmissionPayload(row, signer.keyId);
    for (const changed of [
      { ...payload, purpose: 'other.consent' },
      { ...payload, version: 2 },
      { ...payload, keyId: 'other' },
    ]) {
      expect(
        verifyScheduleAdmission(
          {
            ...row,
            args: { ...row.args, _scheduleAdmission: signer.sign(changed) },
          },
          signer,
        ),
      ).toBe(false);
    }
  });
  it('rejects malformed host signers before admission rather than silently disabling protection', () => {
    for (const occurrenceSigner of [
      {},
      { ...signer, keyId: '' },
      { ...signer, sign: undefined },
      { ...signer, verify: undefined },
    ]) {
      expect(
        () =>
          new ScheduleRunner({
            occurrenceSigner,
          } as unknown as ScheduleRunnerConfig),
      ).toThrow('occurrenceSigner');
    }
    expect(ScheduleRunner.capabilities.occurrenceIntegrity).toBe(true);
  });
});
