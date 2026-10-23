import {
  crossPackageRef,
  field,
  foreignKey,
  type SmrtClassOptions,
  SmrtObject,
  smrt,
  ValidationError,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { assertParticipationWrite } from '../write-authority.js';
import { Poll } from './Poll.js';
export interface PollVoteOptions extends SmrtClassOptions {
  tenantId?: string;
  pollId?: string;
  optionId?: string;
  actorProfileId?: string;
  participationSnapshot?: string;
}
/** Append-only through PollService; no generated write API. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'poll_votes',
  api: false,
  mcp: false,
  cli: false,
  hooks: { beforeDelete: 'assertWriteAuthority' },
  indexes: [
    {
      name: 'poll_votes_actor',
      columns: ['tenantId', 'pollId', 'actorProfileId'],
      unique: true,
    },
  ],
})
export class PollVote extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey(Poll, {
    required: true,
    onUpdate: 'NO ACTION',
    onDelete: 'NO ACTION',
  })
  pollId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  actorProfileId = '';
  @field({ required: true, readonly: true }) optionId = '';
  @field({ type: 'text', required: true, readonly: true })
  participationSnapshot = '{}';
  constructor(options: PollVoteOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.pollId !== undefined) this.pollId = options.pollId;
    if (options.actorProfileId !== undefined)
      this.actorProfileId = options.actorProfileId;
    if (options.optionId !== undefined) this.optionId = options.optionId;
    if (options.participationSnapshot !== undefined)
      this.participationSnapshot = options.participationSnapshot;
  }
  assertWriteAuthority(): void {
    assertParticipationWrite(this.db);
  }
  protected override async validateBeforeSave(): Promise<void> {
    assertParticipationWrite(this.db);
    await super.validateBeforeSave();
    const evidence: unknown = JSON.parse(this.participationSnapshot);
    if (
      !evidence ||
      typeof evidence !== 'object' ||
      Array.isArray(evidence) ||
      Object.keys(evidence).length === 0
    )
      throw new TypeError(
        'Participation snapshot must be a nonempty JSON object.',
      );
    if (this.id) {
      const existing = await this.getCanonicalPersistedRow({ id: this.id });
      if (
        existing &&
        (existing.participation_snapshot !== this.participationSnapshot ||
          existing.option_id !== this.optionId ||
          existing.tenant_id !== this.tenantId ||
          existing.poll_id !== this.pollId ||
          existing.actor_profile_id !== this.actorProfileId)
      )
        throw new ValidationError(
          'Recorded votes are immutable.',
          'VALIDATION_IMMUTABLE_VOTE',
        );
    }
  }
}
