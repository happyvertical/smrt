import {
  field,
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ProjectGovernanceAction,
  ProjectGovernanceActorType,
  ProjectGovernanceRecordKind,
  ProjectQuestionAnswerSelection,
} from '../project-governance-types.js';

export interface ProjectGovernanceEventOptions
  extends SmrtPolymorphicAssociationOptions {
  tenantId?: string;
  recordKind?: ProjectGovernanceRecordKind;
  action?: ProjectGovernanceAction;
  actorType?: ProjectGovernanceActorType;
  actorId?: string;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
  value?: string;
  rationale?: string;
  answerSelection?: string;
  revision?: number;
  fromOwnerType?: ProjectGovernanceActorType | '';
  fromOwnerId?: string;
  toOwnerType?: ProjectGovernanceActorType | '';
  toOwnerId?: string;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'project_governance_events',
  hooks: { beforeDelete: 'beforeDelete' },
  api: false,
  mcp: false,
  cli: false,
  indexes: [
    {
      name: 'project_governance_events_record_idx',
      columns: ['tenantId', 'metaType', 'metaId', 'createdAt'],
    },
  ],
})
export class ProjectGovernanceEvent extends SmrtPolymorphicAssociation {
  @tenantId()
  tenantId = '';

  @field({ required: true })
  recordKind: ProjectGovernanceRecordKind = 'question';

  @field({ required: true })
  action: ProjectGovernanceAction = 'created';

  @field({ required: true })
  actorType: ProjectGovernanceActorType = 'system';

  @field({ required: true })
  actorId = '';

  fromStatus = '';

  @field({ required: true })
  toStatus = 'open';

  note = '';

  value = '';

  rationale = '';

  /** JSON answer snapshot; empty for events written before structured questions. */
  @field({ default: '' })
  answerSelection = '';

  revision = 1;

  fromOwnerType: ProjectGovernanceActorType | '' = '';
  fromOwnerId = '';
  toOwnerType: ProjectGovernanceActorType | '' = '';
  toOwnerId = '';

  constructor(options: ProjectGovernanceEventOptions = {}) {
    super({ ...options, role: 'history' });
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.recordKind !== undefined) this.recordKind = options.recordKind;
    if (options.action !== undefined) this.action = options.action;
    if (options.actorType !== undefined) this.actorType = options.actorType;
    if (options.actorId !== undefined) this.actorId = options.actorId;
    if (options.fromStatus !== undefined) this.fromStatus = options.fromStatus;
    if (options.toStatus !== undefined) this.toStatus = options.toStatus;
    if (options.note !== undefined) this.note = options.note;
    if (options.value !== undefined) this.value = options.value;
    if (options.answerSelection !== undefined)
      this.answerSelection = options.answerSelection;
    if (options.rationale !== undefined) this.rationale = options.rationale;
    if (options.revision !== undefined) this.revision = options.revision;
    if (options.fromOwnerType !== undefined)
      this.fromOwnerType = options.fromOwnerType;
    if (options.fromOwnerId !== undefined)
      this.fromOwnerId = options.fromOwnerId;
    if (options.toOwnerType !== undefined)
      this.toOwnerType = options.toOwnerType;
    if (options.toOwnerId !== undefined) this.toOwnerId = options.toOwnerId;
  }

  getAnswerSelection(): ProjectQuestionAnswerSelection | null {
    if (!this.answerSelection) return null;
    const value = JSON.parse(this.answerSelection);
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.answer !== 'string' ||
      !Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision < 1 ||
      (value.selectedOptionId !== undefined &&
        typeof value.selectedOptionId !== 'string') ||
      (value.optionLabel !== undefined &&
        typeof value.optionLabel !== 'string') ||
      (value.idempotencyKey !== undefined &&
        typeof value.idempotencyKey !== 'string')
    )
      throw new TypeError('Invalid project question answer snapshot.');
    return value;
  }

  async beforeDelete(): Promise<void> {
    throw new TypeError('Project governance history is append-only.');
  }

  protected override async validateBeforeSave(): Promise<void> {
    if (this.isPersisted)
      throw new TypeError('Project governance history is append-only.');
    this.getAnswerSelection();
    this.actorId = this.actorId.trim();
    if (!this.actorId)
      throw new TypeError('Project governance event actor id is required.');
    if (!Number.isSafeInteger(this.revision) || this.revision < 1)
      throw new TypeError(
        'Project governance event revision must be a positive integer.',
      );
    await super.validateBeforeSave();
  }
}
