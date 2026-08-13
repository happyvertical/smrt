import { getProject } from '@happyvertical/projects';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectIntegrationCollection } from '../collections/ProjectIntegrations.js';
import { ProjectCollection } from '../collections/Projects.js';
import { ManagedProjectClient } from '../managed-client.js';
import type { ProjectIntegration } from '../models/ProjectIntegration.js';
import { ProjectBoardService } from '../services/project-board-service.js';

vi.mock('@happyvertical/projects', () => ({ getProject: vi.fn() }));

const TENANT_ID = 'tenant-project-board';
const PROJECT_ID = 'provider-project-1';
const TOKEN_KEY = 'SMRT_PROJECT_BOARD_TEST_TOKEN';
const GLOBAL_TOKEN_KEY = 'SMRT_PROJECT_BOARD_GLOBAL_TEST_TOKEN';

describe('ProjectBoardService (#2317)', () => {
  let db: DatabaseInterface;
  let savedToken: string | undefined;
  let savedGlobalToken: string | undefined;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    savedToken = process.env[TOKEN_KEY];
    savedGlobalToken = process.env[GLOBAL_TOKEN_KEY];
    process.env[TOKEN_KEY] = 'test-provider-token';
    process.env[GLOBAL_TOKEN_KEY] = 'global-provider-token';
    vi.mocked(getProject).mockReset();
  });

  afterEach(async () => {
    if (savedToken === undefined) delete process.env[TOKEN_KEY];
    else process.env[TOKEN_KEY] = savedToken;
    if (savedGlobalToken === undefined) delete process.env[GLOBAL_TOKEN_KEY];
    else process.env[GLOBAL_TOKEN_KEY] = savedGlobalToken;
    vi.restoreAllMocks();
    await db.close?.();
  });

  async function authorize(capabilities: string[]) {
    const integrations = await ProjectIntegrationCollection.create({ db });
    return integrations.provision({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'Project board browser',
      capabilities,
    });
  }

  async function seedProject(
    options: {
      tenantId?: string | null;
      title?: string;
      tokenConfigKey?: string;
      providerType?: 'github' | 'jira' | 'linear' | 'zenhub';
    } = {},
  ) {
    const projects = await ProjectCollection.create({ db });
    const tenantId =
      options.tenantId === undefined ? TENANT_ID : options.tenantId;
    const createProject = () =>
      projects.create({
        tenantId,
        projectId: PROJECT_ID,
        title: options.title ?? 'Project board',
        tokenConfigKey: options.tokenConfigKey ?? TOKEN_KEY,
        providerType: options.providerType ?? 'github',
        statuses: [{ name: 'Backlog' }, { name: 'In progress' }],
      });
    const project = tenantId
      ? await withTenant({ tenantId }, createProject)
      : await createProject();
    if (tenantId) await withTenant({ tenantId }, () => project.save());
    else await project.save();
    return project;
  }

  function provider(items: Array<{ id: string; status?: string | null }>) {
    return {
      listItems: vi.fn(async () => items),
      updateItemStatus: vi.fn(async () => {}),
    };
  }

  it('moves a validated item through the authenticated managed client', async () => {
    const { credential } = await authorize(['projects:write']);
    await seedProject();
    const client = provider([{ id: 'item-1', status: 'Backlog' }]);
    vi.mocked(getProject).mockResolvedValue(client as never);
    const managed = await ManagedProjectClient.authenticate(credential, {
      db,
      requesterId: 'board-user-1',
    });

    await expect(
      managed.moveProjectBoardItem({
        projectId: PROJECT_ID,
        itemId: 'item-1',
        status: 'In progress',
      }),
    ).resolves.toEqual({
      projectId: PROJECT_ID,
      itemId: 'item-1',
      previousStatus: 'Backlog',
      status: 'In progress',
    });
    expect(client.updateItemStatus).toHaveBeenCalledWith(
      'item-1',
      'In progress',
    );
  });

  it('rejects a forged browser selector instead of treating it as authorization', async () => {
    const { integration } = await authorize(['projects:write']);
    const service = await ProjectBoardService.create({ db });

    await expect(
      service.moveItem(
        {
          id: integration.id,
          tenantId: integration.tenantId,
        } as ProjectIntegration,
        {
          projectId: PROJECT_ID,
          itemId: 'item-1',
          status: 'In progress',
        },
      ),
    ).rejects.toThrow('require an authenticated Project Integration');
    expect(getProject).not.toHaveBeenCalled();
  });

  it('denies an integration without the additive board-write capability', async () => {
    const { integration } = await authorize(['delivery:read']);
    await seedProject();
    const service = await ProjectBoardService.create({ db });

    await expect(
      service.moveItem(integration, {
        projectId: PROJECT_ID,
        itemId: 'item-1',
        status: 'In progress',
      }),
    ).rejects.toThrow("lacks capability 'projects:write'");
    expect(getProject).not.toHaveBeenCalled();
  });

  it('rejects statuses not present on the authoritative project', async () => {
    const { integration } = await authorize(['projects:write']);
    await seedProject();
    const service = await ProjectBoardService.create({ db });

    await expect(
      service.moveItem(integration, {
        projectId: PROJECT_ID,
        itemId: 'item-1',
        status: 'Not a project status',
      }),
    ).rejects.toThrow(
      "Project status 'Not a project status' is not available.",
    );
    expect(getProject).not.toHaveBeenCalled();
  });

  it('rejects an item that is absent from the authoritative project', async () => {
    const { integration } = await authorize(['projects:write']);
    await seedProject();
    const client = provider([]);
    vi.mocked(getProject).mockResolvedValue(client as never);
    const service = await ProjectBoardService.create({ db });

    await expect(
      service.moveItem(integration, {
        projectId: PROJECT_ID,
        itemId: 'missing-item',
        status: 'In progress',
      }),
    ).rejects.toThrow('Project item not found.');
    expect(client.updateItemStatus).not.toHaveBeenCalled();
  });

  it('propagates provider failures after validation so callers can refresh state', async () => {
    const { integration } = await authorize(['projects:write']);
    await seedProject();
    const client = provider([{ id: 'item-1', status: 'Backlog' }]);
    client.updateItemStatus.mockRejectedValueOnce(
      new Error('Provider mutation failed'),
    );
    vi.mocked(getProject).mockResolvedValue(client as never);
    const service = await ProjectBoardService.create({ db });

    await expect(
      service.moveItem(integration, {
        projectId: PROJECT_ID,
        itemId: 'item-1',
        status: 'In progress',
      }),
    ).rejects.toThrow('Provider mutation failed');
  });

  it('uses the tenant project before a global project with the same provider ID', async () => {
    const { integration } = await authorize(['projects:write']);
    await seedProject({
      tenantId: null,
      title: 'Global board',
      tokenConfigKey: GLOBAL_TOKEN_KEY,
      providerType: 'linear',
    });
    await seedProject({ title: 'Tenant board' });
    const tenantClient = provider([{ id: 'item-1', status: 'Backlog' }]);
    const globalClient = provider([{ id: 'item-1', status: 'Backlog' }]);
    vi.mocked(getProject).mockImplementation(async (options: any) =>
      options.type === 'github'
        ? (tenantClient as never)
        : (globalClient as never),
    );
    const service = await ProjectBoardService.create({ db });

    await service.moveItem(integration, {
      projectId: PROJECT_ID,
      itemId: 'item-1',
      status: 'In progress',
    });
    expect(tenantClient.updateItemStatus).toHaveBeenCalledOnce();
    expect(globalClient.updateItemStatus).not.toHaveBeenCalled();
  });

  it('rechecks active capability after reads and before provider mutation', async () => {
    const { integration } = await authorize(['projects:write']);
    await seedProject();
    const integrations = await ProjectIntegrationCollection.create({ db });
    const client = provider([{ id: 'item-1', status: 'Backlog' }]);
    client.listItems.mockImplementationOnce(async () => {
      await integrations.revoke(TENANT_ID, integration.id as string);
      return [{ id: 'item-1', status: 'Backlog' }];
    });
    vi.mocked(getProject).mockResolvedValue(client as never);
    const service = await ProjectBoardService.create({ db });

    await expect(
      service.moveItem(integration, {
        projectId: PROJECT_ID,
        itemId: 'item-1',
        status: 'In progress',
      }),
    ).rejects.toThrow('Project Integration is revoked.');
    expect(client.updateItemStatus).not.toHaveBeenCalled();
  });
});
