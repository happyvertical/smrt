import {
  isUniqueViolationError,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { validateCookbook } from '@happyvertical/smrt-core/cookbook';
import {
  assertTenantReadAllowed,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { ProjectSpecificationCollection } from '../collections/ProjectSpecifications.js';
import type { ProjectSpecification } from '../models/ProjectSpecification.js';
import type {
  ProjectGovernanceActor,
  ProjectGovernanceScope,
} from '../project-governance-types.js';
import {
  ProjectGovernanceAuthorizationError,
  ProjectGovernanceConflictError,
} from './project-governance-service.js';

export class ProjectSpecificationValidationError extends TypeError {
  readonly code = 'INVALID_PROJECT_SPECIFICATION';
  readonly status = 400;
}

export interface ProjectSpecificationSaveInput extends ProjectGovernanceScope {
  /** null is create-only; an existing specification requires its current revision. */
  expectedRevision: number | null;
  actor: ProjectGovernanceActor;
  title: string;
  summary?: string;
  /** Validated and canonicalized by smrt-core/cookbook before persistence. */
  cookbook: unknown;
}

export interface ProjectSpecificationServiceOptions extends SmrtClassOptions {
  /** Explicit caller-owned transaction executor; never pass an ordinary connection here. */
  transaction?: 'caller';
}

/** Tenant/project isolation and optimistic writes for canonical specifications. */
export class ProjectSpecificationService {
  private constructor(
    private readonly collection: ProjectSpecificationCollection,
    private readonly callerTransaction: boolean,
  ) {}

  static async create(
    options: ProjectSpecificationServiceOptions = {},
  ): Promise<ProjectSpecificationService> {
    return new ProjectSpecificationService(
      await ProjectSpecificationCollection.create(options),
      options.transaction === 'caller',
    );
  }

  async getForProject(
    scope: ProjectGovernanceScope,
  ): Promise<ProjectSpecification | null> {
    validateScope(scope);
    return this.collection.getForProject(scope);
  }

  async saveForProject(
    input: ProjectSpecificationSaveInput,
  ): Promise<ProjectSpecification> {
    validateScope(input);
    if (
      !['user', 'agent', 'system'].includes(input.actor.type) ||
      !input.actor.id.trim()
    )
      throw new ProjectSpecificationValidationError(
        'A valid project specification actor is required.',
      );
    if (!input.actor.canManage) throw new ProjectGovernanceAuthorizationError();
    if (
      input.expectedRevision !== null &&
      (!Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1)
    )
      throw new ProjectSpecificationValidationError(
        'Expected revision must be null or a positive integer.',
      );
    if (typeof input.title !== 'string' || !input.title.trim())
      throw new ProjectSpecificationValidationError(
        'Project specification title is required.',
      );
    const validated = validateCookbook(input.cookbook);
    if (!validated.ok)
      throw new ProjectSpecificationValidationError(
        validated.errors.join('; '),
      );
    const work = async (db: ProjectSpecificationCollection['db']) => {
      const collection = await ProjectSpecificationCollection.create({ db });
      const table = `"${collection.tableName.replace(/"/g, '""')}"`;
      await db.query(
        `UPDATE ${table} SET revision = revision WHERE tenant_id = ? AND meta_type = ? AND meta_id = ?`,
        input.tenantId,
        input.projectType,
        input.projectId,
      );
      const current = await collection.getForProject(input);
      if ((current?.revision ?? null) !== input.expectedRevision)
        throw new ProjectGovernanceConflictError(
          'Project specification has changed.',
        );
      const values = {
        title: input.title,
        summary: input.summary ?? '',
        cookbook: JSON.stringify(validated.cookbook),
        actorType: input.actor.type,
        actorId: input.actor.id,
      };
      return withTenant({ tenantId: input.tenantId }, async () => {
        if (current) {
          Object.assign(current, values);
          current.revision += 1;
          await current.save();
          return current;
        }
        try {
          return await collection.create({
            ...values,
            tenantId: input.tenantId,
            metaType: input.projectType,
            metaId: input.projectId,
            _insertOnly: true,
          });
        } catch (error) {
          if (isUniqueViolationError(error))
            throw new ProjectGovernanceConflictError(
              'Project specification already exists.',
            );
          throw error;
        }
      });
    };
    if (this.callerTransaction) return work(this.collection.db);
    if (!this.collection.db.transaction)
      throw new Error('Project specification mutations require transactions.');
    return this.collection.db.transaction(work);
  }
}

function validateScope(scope: ProjectGovernanceScope): void {
  if (
    !scope.tenantId.trim() ||
    !scope.projectId.trim() ||
    !scope.projectType.includes(':')
  )
    throw new ProjectSpecificationValidationError(
      'Tenant, qualified project type, and project id are required.',
    );
  assertTenantReadAllowed(scope.tenantId, 'ProjectSpecificationService');
}
