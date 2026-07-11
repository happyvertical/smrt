/**
 * SupportChannelBinding — marks a transport container (a chat room, an email
 * account) as a Managed Support intake channel. Inbound activity on a bound
 * container creates-or-joins Support Cases; unbound containers are never
 * touched, so ordinary chat rooms and mailboxes stay out of the support
 * system.
 *
 * Bindings are configuration (operator-managed), so unlike the case-side
 * models they expose full generated CRUD.
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  parseJsonField,
  parseStringArrayField,
  type SupportBindingKind,
  type SupportChannelKind,
} from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_channel_bindings',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['target_type', 'target_id'],
})
export class SupportChannelBinding extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Operator-facing binding name (inherited `name` is the display label). */
  name: string = '';

  @field({ type: 'text' })
  bindingKind: SupportBindingKind = 'chat_room';

  /** Channel kind interactions from this binding are recorded as. */
  @field({ type: 'text' })
  channelKind: SupportChannelKind = 'chat';

  /**
   * Qualified class of the bound container, e.g.
   * `@happyvertical/smrt-chat:ChatRoom` or
   * `@happyvertical/smrt-messages:EmailAccount`.
   */
  @field({ type: 'text' })
  targetType: string = '';

  /** Id of the bound container row. */
  @field({ type: 'text' })
  targetId: string = '';

  /**
   * Default Client for cases created from this binding (e.g. a dedicated
   * client support room). When null, intake resolves the client from the
   * interaction author (chat) or sender lookup (email).
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  clientProfileId: string | null = null;

  /** Default app-defined Project reference for cases from this binding. */
  @field({ type: 'text', nullable: true })
  projectId: string | null = null;

  /** Managed Support Plan applied to cases created from this binding. */
  @foreignKey('SupportPlan')
  planId: string | null = null;

  @field({ type: 'boolean' })
  enabled: boolean = true;

  /**
   * Addresses belonging to the provider side of an email binding — inbound
   * sync skips messages sent FROM these (they are our own outbound mail).
   * JSON array of e-mail addresses, matched case-insensitively.
   */
  @field({ type: 'text' })
  selfAddresses: string = '[]';

  @field({ type: 'text' })
  metadata: string = '{}';

  getSelfAddresses(): string[] {
    return parseStringArrayField(this.selfAddresses).map((address) =>
      address.toLowerCase(),
    );
  }

  setSelfAddresses(addresses: string[]): void {
    this.selfAddresses = JSON.stringify(addresses ?? []);
  }

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }
}

export class SupportChannelBindingCollection extends SmrtCollection<SupportChannelBinding> {
  static readonly _itemClass = SupportChannelBinding;

  /** Find the enabled binding for a transport container, if any. */
  async findForTarget(
    targetType: string,
    targetId: string,
  ): Promise<SupportChannelBinding | null> {
    const matches = await this.list({
      where: { targetType, targetId, enabled: true },
      limit: 1,
    });
    return matches[0] ?? null;
  }
}

export default SupportChannelBinding;
