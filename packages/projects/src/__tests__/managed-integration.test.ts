import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevelopmentRequestHistoryCollection } from '../collections/DevelopmentRequestHistories';
import { DevelopmentRequestCollection } from '../collections/DevelopmentRequests';
import { ProjectIntegrationAuditCollection } from '../collections/ProjectIntegrationAudits';
import {
  hashProjectIntegrationCredential,
  ProjectIntegrationCollection,
} from '../collections/ProjectIntegrations';
import { ManagedProjectClient } from '../managed-client';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const manifestPath = (() => {
  const candidates = [
    join(packageRoot, '.smrt', 'manifest.json'),
    join(packageRoot, 'dist', 'manifest.json'),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
})();

describe('managed project integrations', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('returns a credential once, stores only its hash, and audits rotation and revocation', async () => {
    const integrations = await ProjectIntegrationCollection.create({ db });
    const created = await integrations.provision({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      name: 'Managed app',
      capabilities: ['requests:create', 'requests:read-own'],
    });

    expect(created.credential).toMatch(/^smrt_pi_/);
    expect(created.integration.credentialHash).not.toContain(
      created.credential,
    );
    const persistedIntegrations = await withTenant(
      { tenantId: 'tenant-a' },
      () => integrations.list({ where: { tenantId: 'tenant-a' } }),
    );
    expect(persistedIntegrations[0]?.credentialHash).toBe(
      hashProjectIntegrationCredential(created.credential),
    );

    expect(await integrations.authenticate(created.credential)).toMatchObject({
      id: created.integration.id,
    });

    const rotated = await integrations.rotate(
      'tenant-a',
      created.integration.id as string,
    );
    expect(rotated.credential).not.toBe(created.credential);
    expect(await integrations.authenticate(created.credential)).toBeNull();
    expect(await integrations.authenticate(rotated.credential)).toMatchObject({
      id: created.integration.id,
    });

    await integrations.revoke('tenant-a', created.integration.id as string);
    expect(await integrations.authenticate(rotated.credential)).toBeNull();

    const audits = await ProjectIntegrationAuditCollection.create({ db });
    const events = await audits.list({
      where: { integrationId: created.integration.id as string },
      orderBy: 'createdAt ASC',
    });
    expect(events.map((event) => event.action)).toEqual([
      'created',
      'rotated',
      'revoked',
    ]);
  });

  it('limits managed clients to their capabilities, project, and stable requester', async () => {
    const integrations = await ProjectIntegrationCollection.create({ db });
    const requests = await DevelopmentRequestCollection.create({ db });
    const histories = await DevelopmentRequestHistoryCollection.create({ db });
    const first = await integrations.provision({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      name: 'App A',
      capabilities: ['requests:create', 'requests:read-own'],
    });
    const second = await integrations.provision({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      name: 'App B',
      capabilities: ['requests:create', 'requests:read-own'],
    });

    const client = await ManagedProjectClient.authenticate(first.credential, {
      db,
      requesterId: 'user-123',
    });
    const created = await client.createRequest({
      participantId: 'participant-optional',
      type: 'feature',
      description: 'Add dark mode',
      evidence: [
        { url: 'https://example.test/screenshot.png', label: 'Screenshot' },
      ],
      visibility: 'requester',
      origin: 'managed-app',
      discussion: 'Requested from settings',
    });
    const forgedScope = await client.createRequest({
      type: 'bug',
      description: 'Attempt to override authenticated scope',
      tenantId: 'tenant-forged',
      projectId: 'project-forged',
      integrationId: second.integration.id,
      requesterId: 'requester-forged',
    } as unknown as Parameters<typeof client.createRequest>[0]);

    expect(created).toMatchObject({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      integrationId: first.integration.id,
      requesterId: 'user-123',
      participantId: 'participant-optional',
      status: 'submitted',
    });
    expect(forgedScope).toMatchObject({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      integrationId: first.integration.id,
      requesterId: 'user-123',
    });
    expect((await client.listRequests()).map((item) => item.id)).toEqual([
      created.id,
      forgedScope.id,
    ]);

    const differentRequester = await ManagedProjectClient.authenticate(
      first.credential,
      { db, requesterId: 'different-user' },
    );
    expect(await differentRequester.listRequests()).toEqual([]);

    const otherClient = await ManagedProjectClient.authenticate(
      second.credential,
      {
        db,
        requesterId: 'user-123',
      },
    );
    expect(await otherClient.listRequests()).toEqual([]);

    const history = await histories.list({
      where: { requestId: created.id as string },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: '',
      toStatus: 'submitted',
      actorType: 'integration',
    });

    const persisted = await requests.get({ id: created.id as string });
    expect(persisted?.getEvidence()).toEqual([
      { url: 'https://example.test/screenshot.png', label: 'Screenshot' },
    ]);
  });

  it('rejects missing capabilities without leaking provider credentials', async () => {
    const integrations = await ProjectIntegrationCollection.create({ db });
    const provisioned = await integrations.provision({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      name: 'Read only',
      capabilities: ['requests:read-own'],
    });
    const client = await ManagedProjectClient.authenticate(
      provisioned.credential,
      {
        db,
        requesterId: 'u1',
      },
    );

    await expect(
      client.createRequest({
        type: 'bug',
        description: 'Broken',
      }),
    ).rejects.toThrow(/capability/i);
    expect(JSON.stringify(client)).not.toContain('GITHUB_TOKEN');
    expect(JSON.stringify(client)).not.toContain('credentialHash');
  });

  it('keeps integrations and requests tenant-scoped under active tenancy', async () => {
    enableTenancy();
    const integrations = await ProjectIntegrationCollection.create({ db });
    const requests = await DevelopmentRequestCollection.create({ db });
    const first = await integrations.provision({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      name: 'App A',
      capabilities: ['requests:create', 'requests:read-own'],
    });
    const second = await integrations.provision({
      tenantId: 'tenant-b',
      projectId: 'project-b',
      name: 'App B',
      capabilities: ['requests:create', 'requests:read-own'],
    });

    await requests.createManaged({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      integrationId: first.integration.id as string,
      requesterId: 'user-a',
      type: 'feature',
      description: 'Tenant A request',
    });
    await requests.createManaged({
      tenantId: 'tenant-b',
      projectId: 'project-b',
      integrationId: second.integration.id as string,
      requesterId: 'user-b',
      type: 'bug',
      description: 'Tenant B request',
    });

    const tenantAIntegrations = await withTenant({ tenantId: 'tenant-a' }, () =>
      integrations.list({ orderBy: 'name ASC' }),
    );
    const tenantBRequests = await withTenant({ tenantId: 'tenant-b' }, () =>
      requests.list({ orderBy: 'description ASC' }),
    );

    expect(tenantAIntegrations.map((row) => row.tenantId)).toEqual([
      'tenant-a',
    ]);
    expect(tenantBRequests.map((row) => row.description)).toEqual([
      'Tenant B request',
    ]);
  });

  it('scopes integration name conflicts by tenant and project', async () => {
    const integrations = await ProjectIntegrationCollection.create({ db });
    const first = await integrations.provision({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      name: 'Managed application',
      capabilities: ['requests:create'],
    });
    const otherTenant = await integrations.provision({
      tenantId: 'tenant-b',
      projectId: 'project-a',
      name: 'Managed application',
      capabilities: ['requests:read-own'],
    });
    const otherProject = await integrations.provision({
      tenantId: 'tenant-a',
      projectId: 'project-b',
      name: 'Managed application',
      capabilities: ['delivery:read'],
    });

    expect(
      new Set([
        first.integration.id,
        otherTenant.integration.id,
        otherProject.integration.id,
      ]).size,
    ).toBe(3);
    await expect(
      integrations.authenticate(first.credential),
    ).resolves.toMatchObject({ id: first.integration.id });
    await expect(
      integrations.authenticate(otherTenant.credential),
    ).resolves.toMatchObject({ id: otherTenant.integration.id });
    await expect(
      integrations.authenticate(otherProject.credential),
    ).resolves.toMatchObject({ id: otherProject.integration.id });
  });

  it('keeps generated metadata available while closing sensitive request surfaces', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const objects: Record<string, any> = manifest.objects;
    expect(
      objects['@happyvertical/smrt-projects:ProjectIntegration']
        ?.decoratorConfig,
    ).toMatchObject({
      conflictColumns: ['tenant_id', 'project_id', 'name'],
      api: { include: ['list', 'get'] },
      mcp: { include: ['list', 'get'] },
      cli: { include: ['list', 'get'] },
    });
    expect(
      objects['@happyvertical/smrt-projects:DevelopmentRequest']
        ?.decoratorConfig,
    ).toMatchObject({ api: false, mcp: false, cli: false });
    expect(
      objects['@happyvertical/smrt-projects:ProjectIntegrationAudit']
        ?.decoratorConfig,
    ).toMatchObject({ api: false, mcp: false, cli: false });
    expect(
      objects['@happyvertical/smrt-projects:DevelopmentRequestHistory']
        ?.decoratorConfig,
    ).toMatchObject({ api: false, mcp: false, cli: false });
  });
});
