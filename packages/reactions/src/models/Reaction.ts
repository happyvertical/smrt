import {
  crossPackageRef,
  field,
  SmrtPolymorphicAssociation,
  type SmrtPolymorphicAssociationOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ReactionKind } from '../types.js';
import { assertParticipationWrite } from '../write-authority.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'record_reactions',
  api: false,
  mcp: false,
  cli: false,
  hooks: { beforeDelete: 'assertWriteAuthority' },
  indexes: [
    {
      name: 'record_reactions_actor_kind',
      columns: ['tenantId', 'metaType', 'metaId', 'actorProfileId', 'kind'],
      unique: true,
    },
  ],
})
export class Reaction extends SmrtPolymorphicAssociation {
  @tenantId() tenantId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  actorProfileId = '';
  @field({ required: true }) kind: ReactionKind = 'like';
  constructor(
    options: SmrtPolymorphicAssociationOptions & {
      tenantId?: string;
      actorProfileId?: string;
      kind?: ReactionKind;
    } = {},
  ) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.actorProfileId !== undefined)
      this.actorProfileId = options.actorProfileId;
    if (options.kind !== undefined) this.kind = options.kind;
  }
  assertWriteAuthority(): void {
    assertParticipationWrite(this.db);
  }
  protected override async validateBeforeSave(): Promise<void> {
    assertParticipationWrite(this.db);
    await super.validateBeforeSave();
  }
}
