/**
 * ProjectRepositoryCollection - links between projects and repositories (#4906).
 *
 * Helpers take the target collection so they read in the caller's tenant and
 * database scope.
 */

import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import type { Project } from '../models/Project';
import { ProjectRepository } from '../models/ProjectRepository';
import type { Repository } from '../models/Repository';
import { PROJECT_REPOSITORY_ROLES, type ProjectRepositoryRole } from '../types';
import type { ProjectCollection } from './Projects';
import type { RepositoryCollection } from './Repositories';

@smrt({ api: false, mcp: false, cli: false })
export class ProjectRepositoryCollection extends SmrtJunction<ProjectRepository> {
  static readonly _itemClass = ProjectRepository;
  protected leftField = 'projectId';
  protected rightField = 'repositoryId';
  protected sortField = null;
  protected positionField = null;

  /**
   * Link a repository to a project, or change the role of an existing link.
   * Keeps the link id stable and never duplicates a (project, repository) pair.
   */
  async link(
    projectId: string,
    repositoryId: string,
    role: ProjectRepositoryRole = 'primary',
  ): Promise<ProjectRepository> {
    if (!PROJECT_REPOSITORY_ROLES.includes(role)) {
      throw new Error(`Invalid project repository role: ${String(role)}`);
    }
    const [existing] = await this.list({
      where: { projectId, repositoryId },
      limit: 1,
    });
    if (existing) {
      if (existing.role !== role) {
        existing.role = role;
        await existing.save();
      }
      return existing;
    }
    return this.create({ projectId, repositoryId, role });
  }

  /** Remove the link between a project and a repository, if any. */
  async unlink(projectId: string, repositoryId: string): Promise<void> {
    await this.detach(projectId, repositoryId);
  }

  /** Repositories linked to a project, optionally only those with `role`. */
  async repositoriesOfProject(
    projectId: string,
    repositories: RepositoryCollection,
    role?: ProjectRepositoryRole,
  ): Promise<Repository[]> {
    const links = await this.byLeft(projectId, role ? { role } : {});
    return repositories.listByIds(links.map((l) => l.repositoryId));
  }

  /** Projects a repository is linked to, optionally only with `role`. */
  async projectsOfRepository(
    repositoryId: string,
    projects: ProjectCollection,
    role?: ProjectRepositoryRole,
  ): Promise<Project[]> {
    const links = await this.byRight(repositoryId, role ? { role } : {});
    return projects.listByIds(links.map((l) => l.projectId));
  }

  /** Repositories with no project link at all. */
  async unassignedRepositories(
    repositories: RepositoryCollection,
  ): Promise<Repository[]> {
    const linked = new Set(
      (await this.list({})).map((link) => link.repositoryId),
    );
    return (await repositories.list({})).filter(
      (repo) => !linked.has(repo.id as string),
    );
  }
}
