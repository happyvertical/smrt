import { getTestDatabase } from '@happyvertical/smrt-core';
import { COOKBOOK_SCHEMA_URL } from '@happyvertical/smrt-core/cookbook';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectSpecificationService,
  ProjectSpecificationValidationError,
} from '../services/project-specification-service.js';

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  projectType: '@happyvertical/work:WorkspaceProject',
  projectId: '22222222-2222-4222-8222-222222222222',
};
const input = {
  ...scope,
  actor: {
    type: 'user' as const,
    id: '33333333-3333-4333-8333-333333333333',
    canManage: true,
  },
  title: 'Studio',
  expectedRevision: null,
  cookbook: {
    $schema: COOKBOOK_SCHEMA_URL,
    version: 1,
    recipes: [],
    features: [],
    policies: [],
    specs: 'Project requirements',
  },
};

describe('canonical project specification', () => {
  let db: DatabaseInterface;
  let service: ProjectSpecificationService;
  beforeEach(async () => {
    db = await getTestDatabase(
      process.env.SMRT_TEST_POSTGRES_URL
        ? { type: 'postgres', url: process.env.SMRT_TEST_POSTGRES_URL }
        : { type: 'sqlite', url: ':memory:' },
    );
    enableTenancy();
    service = await ProjectSpecificationService.create({ db });
  });
  afterEach(async () => {
    disableTenancy();
    if (process.env.SMRT_TEST_POSTGRES_URL)
      await db.query('DELETE FROM project_specifications');
    await db.close?.();
  });

  it('persists validated cookbook inside canonical specification and updates by revision', async () => {
    const created = await service.saveForProject(input);
    expect(created.getCookbook().specs).toBe('Project requirements');
    expect((await service.getForProject(scope))?.id).toBe(created.id);
    const updated = await service.saveForProject({
      ...input,
      title: 'Updated',
      expectedRevision: 1,
    });
    expect(updated).toMatchObject({ title: 'Updated', revision: 2 });
    await expect(
      service.saveForProject({ ...input, expectedRevision: 1 }),
    ).rejects.toThrow(/changed/i);
    await expect(service.saveForProject(input)).rejects.toThrow(/changed/i);
    expect((await service.getForProject(scope))?.revision).toBe(2);
  });

  it('rejects malformed and unknown-version cookbooks before persistence', async () => {
    for (const cookbook of [
      null,
      {},
      { ...input.cookbook, version: 99 },
      { ...input.cookbook, recipes: [3] },
    ]) {
      await expect(
        service.saveForProject({ ...input, cookbook }),
      ).rejects.toBeInstanceOf(ProjectSpecificationValidationError);
    }
    expect(await service.getForProject(scope)).toBeNull();
  });

  it('enforces active tenant and project scope and requires manager actor', async () => {
    await expect(
      service.saveForProject({
        ...input,
        actor: { ...input.actor, canManage: false },
      }),
    ).rejects.toThrow(/cannot change/i);
    await service.saveForProject(input);
    expect(
      await service.getForProject({
        ...scope,
        projectId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toBeNull();
    await expect(
      withTenant({ tenantId: scope.tenantId }, () =>
        service.getForProject({
          ...scope,
          tenantId: '55555555-5555-4555-8555-555555555555',
        }),
      ),
    ).rejects.toThrow(/tenant|isolation/i);
  });

  it('shares caller transaction rollback without opening an independent transaction', async () => {
    await expect(
      db.transaction!(async (tx) => {
        const bound = await ProjectSpecificationService.create({
          db: tx,
          transaction: 'caller',
        });
        await bound.saveForProject(input);
        throw new Error('rollback project creation');
      }),
    ).rejects.toThrow('rollback project creation');
    expect(await service.getForProject(scope)).toBeNull();
  });
});
