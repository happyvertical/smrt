import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { MessagingChannel, MessagingEndpointOptions } from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'messaging_endpoints',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'channel', 'label'],
})
export class MessagingEndpoint extends SmrtObject {
  @tenantId()
  tenantId = '';

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  profileId: string | null = null;

  @field({ required: true })
  label = '';

  @field({ required: true })
  channel: MessagingChannel = 'email';

  /** Provider-specific destination JSON. Hidden from generated read surfaces. */
  @field({ required: true, sensitive: true })
  address = '{}';

  isActive = true;
  verifiedAt: Date | null = null;
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: MessagingEndpointOptions = {}) {
    super(options as SmrtObjectOptions);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.label !== undefined) this.label = options.label;
    if (options.channel !== undefined) this.channel = options.channel;
    if (options.address !== undefined) this.address = options.address;
    if (options.isActive !== undefined) this.isActive = options.isActive;
    if (options.verifiedAt !== undefined) this.verifiedAt = options.verifiedAt;
    if (options.createdAt !== undefined) this.createdAt = options.createdAt;
    if (options.updatedAt !== undefined) this.updatedAt = options.updatedAt;
  }

  getAddress<T extends Record<string, unknown> = Record<string, unknown>>(): T {
    try {
      return JSON.parse(this.address) as T;
    } catch {
      return {} as T;
    }
  }

  setAddress(address: Record<string, unknown>): void {
    this.address = JSON.stringify(address);
  }

  getMaskedAddress(): string {
    const address = this.getAddress();
    const visible =
      address.email ??
      address.chatId ??
      address.to ??
      address.stream ??
      address.phoneNumber;
    if (typeof visible !== 'string' && typeof visible !== 'number')
      return '••••';
    const value = String(visible);
    if (value.includes('@')) {
      const [name, domain] = value.split('@');
      return `${name.slice(0, 2)}•••@${domain}`;
    }
    return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
  }
}
