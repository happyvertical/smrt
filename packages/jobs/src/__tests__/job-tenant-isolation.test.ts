import {
  generateOpenAPISpec,
  getTestDatabase,
  MCPGenerator,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  isTenantScopedClass,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';

// Generated REST/MCP routes run with the tenant interceptor installed
// (the consuming app calls enableTenancy()). Reproduce that here with the
// default, most-secure rawQueryPolicy so the test also proves the runner's
// worker-internal raw queries keep their explicit cross-tenant opt-in.
beforeEach(() => {
  enableTenancy({ rawQueryPolicy: 'throw' });
});

afterEach(() => {
  disableTenancy();
  ObjectRegistry.clearCollectionCache?.();
});

/**
 * Regression for S5 audit #1402 (HIGH): SmrtJob / SmrtJobEvent are internal
 * operational queue tables. They were exposed for generated list/get over
 * api+mcp; even after being marked @TenantScoped, an `optional`-mode class
 * reached WITHOUT a tenant context (a tenant-less/admin principal, or any
 * non-SvelteKit surface) returns UNFILTERED rows — leaking every tenant's jobs.
 *
 * The fail-closed fix removes the generated read surface entirely (`api: false`
 * / `mcp: false`). Workers reach these tables through the collection directly,
 * never through generated routes. The class stays @TenantScoped as defense in
 * depth for the data model, so the collection's own reads still isolate by
 * tenant when a context IS present.
 */
describe('SmrtJob read-surface is fail-closed (no generated routes)', () => {
  it('does not generate any MCP tools for SmrtJob / SmrtJobEvent', async () => {
    const tools = await new MCPGenerator().generateTools();
    const jobTools = tools.filter(
      (tool) =>
        tool.name.startsWith('smrtjob_') ||
        tool.name.startsWith('smrtjobevent_'),
    );
    expect(jobTools).toEqual([]);
  });

  it('does not advertise SmrtJob / SmrtJobEvent paths in the OpenAPI spec', () => {
    const spec = generateOpenAPISpec();
    const paths = Object.keys(spec.paths ?? {});
    const jobPaths = paths.filter(
      (path) => path.includes('smrtjob') || path.includes('_smrt_job'),
    );
    expect(jobPaths).toEqual([]);
  });

  it('keeps both classes registered as tenant-scoped (defense in depth)', () => {
    expect(isTenantScopedClass('SmrtJob')).toBe(true);
    expect(isTenantScopedClass('SmrtJobEvent')).toBe(true);
  });

  it('list() only returns jobs for the active tenant', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await collection.create({
        objectType: 'Probe',
        method: 'run',
        args: {},
      });
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await collection.create({
        objectType: 'Probe',
        method: 'run',
        args: {},
      });
      await collection.create({
        objectType: 'Probe',
        method: 'run',
        args: {},
      });
    });

    const aJobs = await withTenant({ tenantId: 'tenant-a' }, async () =>
      collection.list({}),
    );
    const bJobs = await withTenant({ tenantId: 'tenant-b' }, async () =>
      collection.list({}),
    );

    expect(aJobs).toHaveLength(1);
    expect(aJobs.every((job) => job.tenantId === 'tenant-a')).toBe(true);
    expect(bJobs).toHaveLength(2);
    expect(bJobs.every((job) => job.tenantId === 'tenant-b')).toBe(true);
  });

  it('get() refuses to return another tenant job', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    const jobA = await withTenant({ tenantId: 'tenant-a' }, async () =>
      collection.create({ objectType: 'Probe', method: 'run', args: {} }),
    );

    // Reading tenant-a's job from tenant-b's context must not leak it.
    const leaked = await withTenant({ tenantId: 'tenant-b' }, async () =>
      collection.get({ id: jobA.id ?? '' }),
    );
    expect(leaked).toBeNull();

    // The owning tenant can still read it.
    const owned = await withTenant({ tenantId: 'tenant-a' }, async () =>
      collection.get({ id: jobA.id ?? '' }),
    );
    expect(owned?.id).toBe(jobA.id);
  });

  it('list() only returns job events for the active tenant', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await events.append({ jobId: 'job-a', message: 'a-event' });
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await events.append({ jobId: 'job-b', message: 'b-event' });
    });

    const aEvents = await withTenant({ tenantId: 'tenant-a' }, async () =>
      events.list({}),
    );
    const bEvents = await withTenant({ tenantId: 'tenant-b' }, async () =>
      events.list({}),
    );

    expect(aEvents).toHaveLength(1);
    expect(aEvents[0]?.tenantId).toBe('tenant-a');
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0]?.tenantId).toBe('tenant-b');
  });
});
