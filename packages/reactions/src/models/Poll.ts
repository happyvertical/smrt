import {
  field,
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
  smrt,
  ValidationError,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { PollOption, PollVisibility } from '../types.js';
import { assertParticipationWrite } from '../write-authority.js';
export interface PollOptions extends SmrtPolymorphicAssociationOptions {
  tenantId?: string;
  question?: string;
  optionsJson?: string;
  opensAt?: Date | null;
  closesAt?: Date | null;
  visibility?: PollVisibility;
  anonymousTally?: boolean;
  closed?: boolean;
}
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'record_polls',
  api: false,
  mcp: false,
  cli: false,
  hooks: { beforeDelete: 'assertWriteAuthority' },
  indexes: [
    {
      name: 'record_polls_target',
      columns: ['tenantId', 'metaType', 'metaId'],
    },
  ],
})
export class Poll extends SmrtPolymorphicAssociation {
  @tenantId() tenantId = '';
  @field({ required: true }) question = '';
  @field({ type: 'text', readonly: true }) optionsJson = '[]';
  @field({ type: 'datetime', nullable: true }) opensAt: Date | null = null;
  @field({ type: 'datetime', nullable: true }) closesAt: Date | null = null;
  @field() visibility: PollVisibility = 'always';
  @field() oneVotePerActor = true;
  @field() anonymousTally = true;
  @field() closed = false;
  constructor(options: PollOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.question !== undefined) this.question = options.question;
    if (options.optionsJson !== undefined)
      this.optionsJson = options.optionsJson;
    if (options.opensAt !== undefined) this.opensAt = options.opensAt;
    if (options.closesAt !== undefined) this.closesAt = options.closesAt;
    if (options.visibility !== undefined) this.visibility = options.visibility;
    if (options.anonymousTally !== undefined)
      this.anonymousTally = options.anonymousTally;
    if (options.closed !== undefined) this.closed = options.closed;
  }
  assertWriteAuthority(): void {
    assertParticipationWrite(this.db);
  }
  protected override async validateBeforeSave(): Promise<void> {
    assertParticipationWrite(this.db);
    await super.validateBeforeSave();
    this.pollOptions;
    if (this.id) {
      const existing = await this.getCanonicalPersistedRow({ id: this.id });
      if (
        existing &&
        (existing.options_json !== this.optionsJson ||
          existing.tenant_id !== this.tenantId ||
          existing.meta_type !== this.metaType ||
          existing.meta_id !== this.metaId)
      )
        throw new ValidationError(
          'Poll target and options are immutable.',
          'VALIDATION_IMMUTABLE_POLL',
        );
    }
  }
  get pollOptions(): PollOption[] {
    const parsed: unknown = JSON.parse(this.optionsJson);
    if (
      !Array.isArray(parsed) ||
      parsed.length < 2 ||
      parsed.length > 50 ||
      parsed.some(
        (o) =>
          !o ||
          typeof o.id !== 'string' ||
          !o.id.trim() ||
          typeof o.label !== 'string' ||
          !o.label.trim(),
      ) ||
      new Set(parsed.map((o) => o.id)).size !== parsed.length
    )
      throw new TypeError('Invalid poll options.');
    return parsed.map((o) => ({ id: o.id, label: o.label }));
  }
}
