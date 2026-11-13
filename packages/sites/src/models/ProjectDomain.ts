/**
 * ProjectDomain - Links a Domain to a project with a role.
 *
 * `projectId` is a qualified cross-package reference to
 * `@happyvertical/smrt-projects:Project`; this package does not depend on
 * smrt-projects (DAG, #1582).
 */

import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { DomainRole, ProjectDomainOptions } from '../types';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'project_domains',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['domain_id', 'project_id', 'role'],
})
export class ProjectDomain extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  /** FK to domains */
  @foreignKey('Domain')
  domainId: string = '';

  /** Project this hostname serves */
  @crossPackageRef('@happyvertical/smrt-projects:Project')
  projectId: string = '';

  /** production, staging, preview, mail, redirect, other */
  role: DomainRole = 'production';

  createdAt: Date = new Date();
  updatedAt: Date = new Date();

  constructor(options: ProjectDomainOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.domainId !== undefined) this.domainId = options.domainId;
    if (options.projectId !== undefined) this.projectId = options.projectId;
    if (options.role !== undefined) this.role = options.role;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }
}
