import {
  field,
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ProjectContextReference,
  ProjectDecisionOption,
  ProjectDecisionStatus,
  ProjectGovernanceActorType,
  ProjectGovernanceVisibility,
} from '../project-governance-types.js';
import {
  parseContextReferences,
  parseDecisionOptions,
  serializeContextReferences,
  serializeDecisionOptions,
} from './project-governance-validation.js';

export interface ProjectDecisionOptions
  extends SmrtPolymorphicAssociationOptions {
  tenantId?: string;
  visibility?: ProjectGovernanceVisibility;
  question?: string;
  decisionOptions?: ProjectDecisionOption[] | string;
  outcome?: string;
  rationale?: string;
  status?: ProjectDecisionStatus;
  ownerType?: ProjectGovernanceActorType | '';
  ownerId?: string;
  contextReferences?: ProjectContextReference[] | string;
  revision?: number;
  decidedAt?: Date | null;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'project_decisions',
  api: false,
  mcp: false,
  cli: false,
  indexes: [
    {
      name: 'project_decisions_project_status_idx',
      columns: ['tenantId', 'metaType', 'metaId', 'status', 'createdAt'],
    },
    {
      name: 'project_decisions_owner_status_idx',
      columns: ['tenantId', 'ownerType', 'ownerId', 'status'],
    },
  ],
})
export class ProjectDecision extends SmrtPolymorphicAssociation {
  @tenantId()
  tenantId = '';

  @field({ required: true })
  question = '';

  /** JSON array; use getOptions()/setOptions(). */
  decisionOptions = '[]';

  outcome = '';

  rationale = '';

  @field({ required: true })
  status: ProjectDecisionStatus = 'open';

  ownerType: ProjectGovernanceActorType | '' = '';

  ownerId = '';

  visibility: ProjectGovernanceVisibility = 'internal';

  /** JSON array; use getContextReferences()/setContextReferences(). */
  contextReferences = '[]';

  revision = 1;

  @field({ type: 'datetime', nullable: true })
  decidedAt: Date | null = null;

  constructor(options: ProjectDecisionOptions = {}) {
    super({ ...options, role: 'decision' });
    if (options.visibility !== undefined) this.visibility = options.visibility;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.question !== undefined) this.question = options.question;
    if (options.decisionOptions !== undefined) {
      this.decisionOptions = Array.isArray(options.decisionOptions)
        ? serializeDecisionOptions(options.decisionOptions)
        : options.decisionOptions;
    }
    if (options.outcome !== undefined) this.outcome = options.outcome;
    if (options.rationale !== undefined) this.rationale = options.rationale;
    if (options.status !== undefined) this.status = options.status;
    if (options.ownerType !== undefined) this.ownerType = options.ownerType;
    if (options.ownerId !== undefined) this.ownerId = options.ownerId;
    if (options.contextReferences !== undefined) {
      this.contextReferences = Array.isArray(options.contextReferences)
        ? serializeContextReferences(options.contextReferences)
        : options.contextReferences;
    }
    if (options.revision !== undefined) this.revision = options.revision;
    if (options.decidedAt !== undefined) this.decidedAt = options.decidedAt;
  }

  getOptions(): ProjectDecisionOption[] {
    return parseDecisionOptions(this.decisionOptions);
  }

  setOptions(value: ProjectDecisionOption[]): void {
    this.decisionOptions = serializeDecisionOptions(value);
  }

  getContextReferences(): ProjectContextReference[] {
    return parseContextReferences(this.contextReferences);
  }

  setContextReferences(value: ProjectContextReference[]): void {
    this.contextReferences = serializeContextReferences(value);
  }

  protected override async validateBeforeSave(): Promise<void> {
    this.question = this.question.trim();
    this.outcome = this.outcome.trim();
    this.rationale = this.rationale.trim();
    this.ownerId = this.ownerId.trim();
    if (!['internal', 'client'].includes(this.visibility))
      throw new TypeError('Invalid project governance visibility.');
    if (!this.question)
      throw new TypeError('Project decision question is required.');
    if (!['open', 'decided', 'deferred', 'superseded'].includes(this.status))
      throw new TypeError('Invalid project decision status.');
    if (this.ownerType && !['user', 'agent', 'system'].includes(this.ownerType))
      throw new TypeError('Invalid project decision owner type.');
    if ((this.ownerType && !this.ownerId) || (!this.ownerType && this.ownerId))
      throw new TypeError(
        'Project decision owner type and id must be set together.',
      );
    const options = parseDecisionOptions(this.decisionOptions);
    if (this.status === 'decided' && !this.outcome)
      throw new TypeError('A decided project decision requires an outcome.');
    if (
      this.status === 'decided' &&
      options.length > 0 &&
      !options.some((option) => option.id === this.outcome)
    )
      throw new TypeError('Project decision outcome must match an option id.');
    if (!Number.isSafeInteger(this.revision) || this.revision < 1)
      throw new TypeError(
        'Project decision revision must be a positive integer.',
      );
    this.decisionOptions = serializeDecisionOptions(options);
    this.contextReferences = serializeContextReferences(
      parseContextReferences(this.contextReferences),
    );
    await super.validateBeforeSave();
  }
}
