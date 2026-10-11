import { randomUUID } from 'node:crypto';
import { getTestDatabase, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

@smrt()
class PortableJobTenantProbe extends SmrtObject {
  async captureTenant(): Promise<string | null> {
    return getTenantId() ?? null;
  }
}

const tenants = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  null,
];
const dialects = process.env.DATABASE_URL
  ? (['sqlite', 'duckdb', 'postgres'] as const)
  : (['sqlite', 'duckdb'] as const);

for (const type of dialects) {
  describe(`portable job tenancy (${type})`, () => {
    let db: DatabaseInterface;
    let pgAdmin: DatabaseInterface | undefined;
    let pgName = '';
    beforeEach(async () => {
      let url = ':memory:';
      if (type === 'postgres') {
        pgAdmin = await getTestDatabase({
          type,
          url: process.env.DATABASE_URL,
          classes: [],
          includeSystemTables: false,
        });
        pgName = `job_tenant_${randomUUID().replaceAll('-', '')}`;
        await pgAdmin.query(`CREATE DATABASE ${pgName}`);
        const target = new URL(process.env.DATABASE_URL ?? '');
        target.pathname = `/${pgName}`;
        url = target.toString();
      }
      db = await getTestDatabase({
        type,
        url,
        classes: [
          'SmrtJob',
          'SmrtJobEvent',
          'SmrtWorker',
          'PortableJobTenantProbe',
        ],
      });
    });
    afterEach(async () => {
      await db?.close?.();
      if (pgAdmin) {
        await pgAdmin.query(`DROP DATABASE ${pgName} WITH (FORCE)`);
        await pgAdmin.close?.();
        pgAdmin = undefined;
      }
    });
    async function enqueue() {
      const jobs = await SmrtJobCollection.create({ db });
      for (const tenantId of tenants) {
        await jobs.enqueueJob({
          tenantId,
          queue: 'portable-tenancy',
          objectType: 'PortableJobTenantProbe',
          method: 'captureTenant',
        });
      }
      return jobs;
    }
    it('claims canonical tenant UUID strings and preserves global null', async () => {
      const jobs = await enqueue();
      const claimed = await jobs.claimReady({
        workerId: randomUUID(),
        queues: ['portable-tenancy'],
        limit: 3,
      });
      expect(claimed).toHaveLength(3);
      expect(claimed.map((job) => job.tenantId)).toEqual(
        expect.arrayContaining(tenants),
      );
    });
    it('executes each tenant and global job in its captured context', async () => {
      await enqueue();
      const results: unknown[] = [];
      const failures: unknown[] = [];
      const runner = new TaskRunner({
        queues: ['portable-tenancy'],
        concurrency: 1,
        pollInterval: 10,
        retention: false,
      });
      runner.on('job:completed', (_job, result) => results.push(result));
      runner.on('job:failed', (_job, error) => failures.push(error));
      runner.on('runner:error', (error) => failures.push(error));
      try {
        await runner.initialize(db);
        await runner.start();
        await vi.waitFor(
          () => {
            expect(failures).toEqual([]);
            expect(results).toHaveLength(3);
          },
          { timeout: 10000 },
        );
        expect(results).toEqual(
          expect.arrayContaining(tenants.map((result) => ({ result }))),
        );
      } finally {
        await runner.stop();
      }
    });
  });
}
