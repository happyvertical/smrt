/**
 * AccountingMapping — one reference from a commerce record to the accounting
 * provider's record, scoped by tenant, provider, realm and environment (#5137).
 *
 * Replaces the flat `Invoice.customerExternalId` and the hand-built
 * `FrozenQuickBooksTaxMapping`. Realm and environment are part of the key, so a
 * different company or sandbox/production switch never reuses a mapping.
 *
 * Commands live in `accounting-mapping.ts`. See `agents/accounting-mapping.md`.
 *
 * @packageDocumentation
 */

import {
  field,
  type SmrtDeleteOptions,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  AccountingConnectionEnvironment,
  AccountingConnectionProvider,
} from './AccountingConnection.js';

/**
 * What a mapping links.
 *
 * - `customer`: commerce `Customer` id to provider customer id.
 * - `tax_code`: commerce `TaxCode` id (`none` for untaxed lines) to provider TaxCode.
 * - `tax_component`: commerce `TaxComponent` id to provider tax rate.
 * - `item`: `default`, or `sku:<sku>`, to provider product/service item.
 * - `deposit_account`: `default` to the provider clearing/deposit account.
 */
export type AccountingMappingKind =
  | 'customer'
  | 'tax_code'
  | 'tax_component'
  | 'item'
  | 'deposit_account';

/**
 * `active` mappings are used; `invalidated` ones belong to a company or
 * environment the tenant left and are kept for history, never used.
 */
export type AccountingMappingStatus = 'active' | 'invalidated';

/** Constructor options for {@link AccountingMapping}. */
export interface AccountingMappingOptions extends SmrtObjectOptions {
  tenantId?: string;
  provider?: AccountingConnectionProvider;
  realmId?: string;
  environment?: AccountingConnectionEnvironment;
  kind?: AccountingMappingKind;
  localId?: string;
  externalId?: string;
}

const KINDS: readonly AccountingMappingKind[] = [
  'customer',
  'tax_code',
  'tax_component',
  'item',
  'deposit_account',
];

const commandWriteInProgress = new WeakSet<AccountingMapping>();

/** @internal Run a write owned by the accounting-mapping commands. */
export async function writeAccountingMapping<T>(
  mapping: AccountingMapping,
  write: () => Promise<T>,
): Promise<T> {
  commandWriteInProgress.add(mapping);
  try {
    return await write();
  } finally {
    commandWriteInProgress.delete(mapping);
  }
}

/**
 * A mapping of one local record to one provider record.
 *
 * Unique on `(tenantId, provider, realmId, environment, kind, localId)`; the
 * generated surface is read-only and every write goes through the commands.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'accounting_mappings',
  indexes: [
    {
      name: 'accounting_mappings_scope_kind_local',
      columns: [
        'tenantId',
        'provider',
        'realmId',
        'environment',
        'kind',
        'localId',
      ],
      unique: true,
    },
  ],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'], skipApiCheck: true },
})
export class AccountingMapping extends SmrtObject {
  /** Tenant that owns the mapping. */
  @tenantId()
  tenantId: string = '';

  /** Accounting provider. */
  provider: AccountingConnectionProvider = 'quickbooks';

  /** Provider company the reference belongs to. */
  realmId: string = '';

  /** Provider mode the reference belongs to. */
  environment: AccountingConnectionEnvironment = 'sandbox';

  /** What is mapped; see {@link AccountingMappingKind}. */
  kind: AccountingMappingKind = 'customer';

  /** Local key: a record id, `none`, `default` or `sku:<sku>` by kind. */
  localId: string = '';

  /** The provider's id for the record. */
  externalId: string = '';

  /** Provider display name captured when the mapping was confirmed. */
  externalName: string = '';

  /**
   * Kind-specific extras (JSON). For `tax_code`: `taxComponents`, the ordered
   * provider tax rates with their compound flags, needed for compound tax.
   */
  @field({ type: 'text' })
  detailsJson: string = '';

  /** Whether the mapping may be used; see {@link AccountingMappingStatus}. */
  status: AccountingMappingStatus = 'active';

  /** Who confirmed the mapping (an opaque user reference), if known. */
  confirmedBy: string = '';

  /** When the mapping was last confirmed. */
  @field({ type: 'datetime', nullable: true })
  confirmedAt: Date | null = null;

  /** When the mapping was invalidated. */
  @field({ type: 'datetime', nullable: true })
  invalidatedAt: Date | null = null;

  constructor(options: AccountingMappingOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.realmId !== undefined) this.realmId = options.realmId;
    if (options.environment !== undefined)
      this.environment = options.environment;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.localId !== undefined) this.localId = options.localId;
    if (options.externalId !== undefined) this.externalId = options.externalId;
  }

  /** Refuses writes outside the commands and any change of scope or key. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!commandWriteInProgress.has(this))
      throw new Error(
        'AccountingMapping is written only by the accounting-mapping commands',
      );
    if (!this.tenantId) throw new Error('AccountingMapping requires a tenant');
    if (!this.realmId) throw new Error('AccountingMapping requires a realmId');
    if (!KINDS.includes(this.kind))
      throw new Error('AccountingMapping kind is invalid');
    if (!this.localId) throw new Error('AccountingMapping requires a localId');
    if (!this.externalId)
      throw new Error('AccountingMapping requires an externalId');
    if (this.status !== 'active' && this.status !== 'invalidated')
      throw new Error('AccountingMapping status is invalid');
    if (this.id) {
      const prior = await this.getCanonicalPersistedRow({ id: this.id });
      if (prior) {
        const identity: Array<[string, unknown, unknown]> = [
          ['tenantId', prior.tenant_id, this.tenantId],
          ['provider', prior.provider, this.provider],
          ['realmId', prior.realm_id, this.realmId],
          ['environment', prior.environment, this.environment],
          ['kind', prior.kind, this.kind],
          ['localId', prior.local_id, this.localId],
        ];
        for (const [name, before, after] of identity)
          if (String(before ?? '') !== String(after))
            throw new Error(`AccountingMapping ${name} cannot change`);
      }
    }
    return super.save(options);
  }

  /** Deleted only by `removeAccountingMapping`. */
  override async delete(options?: SmrtDeleteOptions): Promise<void> {
    if (!commandWriteInProgress.has(this))
      throw new Error(
        'AccountingMapping is deleted only by removeAccountingMapping',
      );
    return super.delete(options);
  }
}

export default AccountingMapping;
