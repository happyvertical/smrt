import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { ProjectIntegrationCollection } from '../collections/ProjectIntegrations.js';
import { ProjectCollection } from '../collections/Projects.js';
import { ProjectIntegration } from '../models/ProjectIntegration.js';
import { requireActiveIntegrationCapability } from './delivery-service.js';

/**
 * Browser-safe move intent emitted by a project-backed board.
 *
 * A SvelteKit action must obtain the authenticated ProjectIntegration through
 * a server-only path (normally ManagedProjectClient.authenticate()) and pass
 * it to ProjectBoardService. Browser payloads must never include integration
 * identifiers, capabilities, credentials, or provider clients.
 */
export interface ProjectBoardMoveIntent {
  projectId: string;
  itemId: string;
  status: string;
}

/** Pure data returned after a provider-backed project board move. */
export interface ProjectBoardMoveResult {
  projectId: string;
  itemId: string;
  previousStatus: string | null;
  status: string;
}

/**
 * Capability-checked server boundary for project-board mutations.
 *
 * This service intentionally exposes neither provider credentials nor the
 * provider client. It reloads the supplied server-derived integration before
 * every mutation, verifies its project binding and capability, validates the
 * requested item and status against the authoritative Project, then delegates
 * persistence to Project.updateItemStatus().
 */
export class ProjectBoardService {
  constructor(
    private readonly integrations: ProjectIntegrationCollection,
    private readonly projects: ProjectCollection,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
  ): Promise<ProjectBoardService> {
    const integrations = await ProjectIntegrationCollection.create(options);
    const projects = await ProjectCollection.create({
      ...options,
      db: integrations.db,
    });
    return new ProjectBoardService(integrations, projects);
  }

  async moveItem(
    integration: ProjectIntegration,
    input: ProjectBoardMoveIntent,
  ): Promise<ProjectBoardMoveResult> {
    const projectId = requiredInput(input.projectId, 'Project ID');
    const itemId = requiredInput(input.itemId, 'Project item ID');
    const status = requiredInput(input.status, 'Project status');
    const authorized = await this.requireAuthorizedIntegration(
      integration,
      projectId,
    );
    const project = await this.findProject(authorized.tenantId, projectId);
    if (!project) throw new Error('Project not found for this integration.');

    const statuses = await project.getStatuses();
    if (!statuses.some((candidate) => candidate.name === status)) {
      throw new Error(`Project status '${status}' is not available.`);
    }

    const item = (await project.listItems()).find(
      (candidate) => candidate.id === itemId,
    );
    if (!item) throw new Error('Project item not found.');

    // Reads can take long enough for a capability to be revoked. Revalidate
    // against canonical integration state immediately before the write.
    await this.requireAuthorizedIntegration(integration, projectId);
    await project.updateItemStatus(itemId, status);
    return {
      projectId,
      itemId,
      previousStatus: item.status ?? null,
      status,
    };
  }

  private async requireAuthorizedIntegration(
    integration: ProjectIntegration,
    projectId: string,
  ): Promise<ProjectIntegration> {
    if (!(integration instanceof ProjectIntegration)) {
      throw new Error(
        'Project board moves require an authenticated Project Integration.',
      );
    }
    const active = await requireActiveIntegrationCapability(
      this.integrations,
      integration,
      'projects:write',
    );
    if (active.projectId !== projectId) {
      throw new Error('Project is outside this Project Integration.');
    }
    return active;
  }

  private async findProject(tenantId: string, projectId: string) {
    const tenantProject = (
      await withTenant({ tenantId }, () =>
        this.projects.list({ where: { projectId, tenantId }, limit: 1 }),
      )
    )[0];
    if (tenantProject) return tenantProject;
    return (await this.projects.findGlobal()).find(
      (candidate) => candidate.projectId === projectId,
    );
  }
}

function requiredInput(value: string, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value;
}
