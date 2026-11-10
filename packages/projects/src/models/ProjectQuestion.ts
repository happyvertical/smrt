import {
  field,
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ProjectContextReference,
  ProjectGovernanceActorType,
  ProjectGovernanceVisibility,
  ProjectQuestionOption,
  ProjectQuestionStatus,
} from '../project-governance-types.js';
import {
  parseContextReferences,
  parseQuestionOptions,
  serializeContextReferences,
  serializeQuestionOptions,
} from './project-governance-validation.js';

export interface ProjectQuestionOptions
  extends SmrtPolymorphicAssociationOptions {
  tenantId?: string;
  visibility?: ProjectGovernanceVisibility;
  prompt?: string;
  answer?: string;
  questionOptions?: ProjectQuestionOption[] | string;
  selectedOptionId?: string;
  status?: ProjectQuestionStatus;
  ownerType?: ProjectGovernanceActorType | '';
  ownerId?: string;
  contextReferences?: ProjectContextReference[] | string;
  revision?: number;
  answeredAt?: Date | null;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'project_questions',
  api: false,
  mcp: false,
  cli: false,
  indexes: [
    {
      name: 'project_questions_project_status_idx',
      columns: ['tenantId', 'metaType', 'metaId', 'status', 'createdAt'],
    },
    {
      name: 'project_questions_owner_status_idx',
      columns: ['tenantId', 'ownerType', 'ownerId', 'status'],
    },
  ],
})
export class ProjectQuestion extends SmrtPolymorphicAssociation {
  @tenantId()
  tenantId = '';

  @field({ required: true })
  prompt = '';

  answer = '';

  /** JSON authored choices; getOptions() includes implicit Other. */
  @field({ default: '[]' })
  questionOptions = '[]';

  @field({ default: '' })
  selectedOptionId = '';

  @field({ required: true })
  status: ProjectQuestionStatus = 'open';

  ownerType: ProjectGovernanceActorType | '' = '';

  ownerId = '';

  visibility: ProjectGovernanceVisibility = 'internal';

  /** JSON array; use getContextReferences()/setContextReferences(). */
  contextReferences = '[]';

  revision = 1;

  @field({ type: 'datetime', nullable: true })
  answeredAt: Date | null = null;

  constructor(options: ProjectQuestionOptions = {}) {
    super({ ...options, role: 'question' });
    if (options.visibility !== undefined) this.visibility = options.visibility;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.prompt !== undefined) this.prompt = options.prompt;
    if (options.answer !== undefined) this.answer = options.answer;
    if (options.questionOptions !== undefined)
      this.questionOptions = Array.isArray(options.questionOptions)
        ? serializeQuestionOptions(options.questionOptions)
        : options.questionOptions;
    if (options.selectedOptionId !== undefined)
      this.selectedOptionId = options.selectedOptionId;
    if (options.status !== undefined) this.status = options.status;
    if (options.ownerType !== undefined) this.ownerType = options.ownerType;
    if (options.ownerId !== undefined) this.ownerId = options.ownerId;
    if (options.contextReferences !== undefined) {
      this.contextReferences = Array.isArray(options.contextReferences)
        ? serializeContextReferences(options.contextReferences)
        : options.contextReferences;
    }
    if (options.revision !== undefined) this.revision = options.revision;
    if (options.answeredAt !== undefined) this.answeredAt = options.answeredAt;
  }

  getOptions(): ProjectQuestionOption[] {
    const options = parseQuestionOptions(this.questionOptions);
    return options.length ? [...options, { id: 'other', label: 'Other' }] : [];
  }

  setOptions(value: ProjectQuestionOption[]): void {
    this.questionOptions = serializeQuestionOptions(value);
  }

  getContextReferences(): ProjectContextReference[] {
    return parseContextReferences(this.contextReferences);
  }

  setContextReferences(value: ProjectContextReference[]): void {
    this.contextReferences = serializeContextReferences(value);
  }

  protected override async validateBeforeSave(): Promise<void> {
    this.questionOptions = serializeQuestionOptions(
      parseQuestionOptions(this.questionOptions),
    );
    if (typeof this.selectedOptionId !== 'string')
      throw new TypeError('Project question selected option id must be text.');
    if (
      this.selectedOptionId &&
      !this.getOptions().some((option) => option.id === this.selectedOptionId)
    )
      throw new TypeError('Project question answer must match an option id.');
    this.prompt = this.prompt.trim();
    this.answer = this.answer.trim();
    this.ownerId = this.ownerId.trim();
    if (!['internal', 'client'].includes(this.visibility))
      throw new TypeError('Invalid project governance visibility.');
    if (!this.prompt)
      throw new TypeError('Project question prompt is required.');
    if (!['open', 'answered', 'deferred', 'superseded'].includes(this.status))
      throw new TypeError('Invalid project question status.');
    if (this.ownerType && !['user', 'agent', 'system'].includes(this.ownerType))
      throw new TypeError('Invalid project question owner type.');
    if ((this.ownerType && !this.ownerId) || (!this.ownerType && this.ownerId))
      throw new TypeError(
        'Project question owner type and id must be set together.',
      );
    if (this.status === 'answered' && !this.answer)
      throw new TypeError('An answered project question requires an answer.');
    if (!Number.isSafeInteger(this.revision) || this.revision < 1)
      throw new TypeError(
        'Project question revision must be a positive integer.',
      );
    this.contextReferences = serializeContextReferences(
      parseContextReferences(this.contextReferences),
    );
    await super.validateBeforeSave();
  }
}
