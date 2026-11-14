/**
 * ProjectRepository - link record between a Project and a Repository (#4906).
 *
 * Many-to-many: a repository may serve several projects (smrt and the SDK
 * serve all of them) and a project may span several repositories. `role` says
 * how the repository serves that project. One row per (project, repository).
 */

import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ProjectRepositoryRole } from '../types';

export interface ProjectRepositoryOptions extends SmrtObjectOptions {
  projectId?: string;
  repositoryId?: string;
  role?: ProjectRepositoryRole;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'project_repositories',
  conflictColumns: ['project_id', 'repository_id'],
  api: false,
  mcp: false,
  cli: false,
})
export class ProjectRepository extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Project', { required: true })
  projectId = '';

  @foreignKey('Repository', { required: true })
  repositoryId = '';

  /** primary | shared-library | infrastructure */
  role: ProjectRepositoryRole = 'primary';

  constructor(options: ProjectRepositoryOptions = {}) {
    super(options);
    if (options.projectId !== undefined) this.projectId = options.projectId;
    if (options.repositoryId !== undefined)
      this.repositoryId = options.repositoryId;
    if (options.role !== undefined) this.role = options.role;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
