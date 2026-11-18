/**
 * Accounting mapping commands and customer resolution (#5137).
 *
 * Mapping records are scoped by tenant, provider, realm and environment. They
 * give the sync functions what an app would otherwise hand-roll: the provider
 * customer id, and the {@link FrozenQuickBooksTaxMapping} (item, tax code and
 * tax-rate references per line and component). A caller passes only the tenant
 * and invoice; the realm and environment come from the tenant's
 * {@link AccountingConnection}.
 *
 * Customer resolution never silently creates a duplicate: use the mapping,
 * else find in the provider, else (only when nothing matches) create. An
 * ambiguous match is returned for an operator to confirm.
 *
 * See `agents/accounting-mapping.md`.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { AccountingConnectionCollection } from './collections/AccountingConnectionCollection.js';
import {
  AccountingMappingCollection,
  type AccountingMappingScope,
} from './collections/AccountingMappingCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import type { QuickBooksFrozenInvoiceMapping } from './invoice-accounting-sync.js';
import {
  type AccountingMapping,
  type AccountingMappingKind,
  writeAccountingMapping,
} from './models/AccountingMapping.js';

export type { AccountingMappingScope } from './collections/AccountingMappingCollection.js';

/** Why a mapping command refused. */
export type AccountingMappingErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_CONNECTED'
  | 'MAPPING_INCOMPLETE'
  | 'CUSTOMER_NEEDS_CONFIRMATION'
  | 'CUSTOMER_NOT_A_CANDIDATE';

/** A required mapping that is missing. */
export interface MissingAccountingMapping {
  readonly kind: AccountingMappingKind;
  readonly localId: string;
}

/** Typed refusal from an accounting-mapping command. */
export class AccountingMappingError extends Error {
  readonly code: AccountingMappingErrorCode;
  readonly missing: readonly MissingAccountingMapping[];

  constructor(
    code: AccountingMappingErrorCode,
    message: string,
    missing: readonly MissingAccountingMapping[] = [],
  ) {
    super(message);
    this.name = 'AccountingMappingError';
    this.code = code;
    this.missing = missing;
  }
}

const KINDS: readonly AccountingMappingKind[] = [
  'customer',
  'tax_code',
  'tax_component',
  'item',
  'deposit_account',
];

/** Ordered provider tax rates of a `tax_code` mapping, for compound tax. */
export interface AccountingTaxCodeDetails {
  readonly taxComponents?: readonly {
    readonly taxRateRef: string;
    readonly compound: boolean;
  }[];
}

function invalid(message: string): AccountingMappingError {
  return new AccountingMappingError('INVALID_INPUT', message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value)
    throw invalid(`${label} must be a nonempty trimmed string`);
  return value;
}

function checkScope(scope: AccountingMappingScope): void {
  text(scope.tenantId, 'Tenant id');
  text(scope.realmId, 'Realm id');
  if (scope.provider !== 'quickbooks') throw invalid('Unsupported provider');
  if (scope.environment !== 'sandbox' && scope.environment !== 'production')
    throw invalid('Environment must be sandbox or production');
}

function mappings(db: DatabaseInterface) {
  return AccountingMappingCollection.create({ db });
}

/**
 * The scope of the tenant's connected company. A tenant that is not connected
 * (or must reconnect) has no scope: its mappings are not used.
 */
export async function getAccountingMappingScope(
  deps: { db: DatabaseInterface },
  tenantId: string,
): Promise<AccountingMappingScope> {
  const connection = await withTenant({ tenantId }, async () =>
    (
      await AccountingConnectionCollection.create({ db: deps.db })
    ).findForTenant({
      tenantId,
      provider: 'quickbooks',
    }),
  );
  if (!connection || connection.status !== 'connected')
    throw new AccountingMappingError(
      'NOT_CONNECTED',
      'The tenant has no connected accounting company',
    );
  return {
    tenantId,
    provider: 'quickbooks',
    realmId: connection.realmId,
    environment: connection.environment,
  };
}

/** Input of {@link setAccountingMapping}. */
export interface SetAccountingMappingInput {
  readonly kind: AccountingMappingKind;
  readonly localId: string;
  readonly externalId: string;
  readonly externalName?: string;
  /** For `tax_code`: the ordered provider tax rates (compound tax). */
  readonly details?: AccountingTaxCodeDetails;
  readonly confirmedBy?: string;
  readonly now?: Date;
}

/**
 * Create or replace the mapping for one local key in a scope. Reactivates an
 * invalidated mapping with the new reference.
 */
export async function setAccountingMapping(
  deps: { db: DatabaseInterface },
  scope: AccountingMappingScope,
  input: SetAccountingMappingInput,
): Promise<AccountingMapping> {
  checkScope(scope);
  if (!KINDS.includes(input.kind)) throw invalid('Unknown mapping kind');
  const localId = text(input.localId, 'Local id');
  const externalId = text(input.externalId, 'Provider id');
  const detailsJson = input.details ? JSON.stringify(input.details) : '';
  return withTenant({ tenantId: scope.tenantId }, async () => {
    const collection = await mappings(deps.db);
    const at = input.now ?? new Date();
    const existing = await collection.findByKey(scope, input.kind, localId);
    const row =
      existing ??
      (await collection.build({ ...scope, kind: input.kind, localId }));
    row.externalId = externalId;
    row.externalName = input.externalName ?? '';
    row.detailsJson = detailsJson;
    row.status = 'active';
    row.confirmedBy = input.confirmedBy ?? '';
    row.confirmedAt = at;
    row.invalidatedAt = null;
    return writeAccountingMapping(row, () => row.save());
  });
}

/** Remove one mapping (an operator unlinking a record). */
export async function removeAccountingMapping(
  deps: { db: DatabaseInterface },
  scope: AccountingMappingScope,
  kind: AccountingMappingKind,
  localId: string,
): Promise<boolean> {
  checkScope(scope);
  return withTenant({ tenantId: scope.tenantId }, async () => {
    const row = await (await mappings(deps.db)).findByKey(scope, kind, localId);
    if (!row) return false;
    await writeAccountingMapping(row, () => row.delete());
    return true;
  });
}

/** The active mappings in a scope, optionally of one kind. */
export async function listAccountingMappings(
  deps: { db: DatabaseInterface },
  scope: AccountingMappingScope,
  kind?: AccountingMappingKind,
): Promise<AccountingMapping[]> {
  checkScope(scope);
  return withTenant({ tenantId: scope.tenantId }, async () =>
    (await mappings(deps.db)).listActive(scope, kind),
  );
}

/** The active provider id for one local key, or `null`. */
export async function getAccountingMapping(
  deps: { db: DatabaseInterface },
  scope: AccountingMappingScope,
  kind: AccountingMappingKind,
  localId: string,
): Promise<AccountingMapping | null> {
  checkScope(scope);
  return withTenant({ tenantId: scope.tenantId }, async () => {
    const row = await (await mappings(deps.db)).findByKey(scope, kind, localId);
    return row?.status === 'active' ? row : null;
  });
}

/**
 * Mark a tenant's active mappings that do not belong to `keep` as invalidated.
 * Called when the connection is rebound to another company or environment; the
 * rows stay for history but are never used (lookups are also scope-keyed).
 */
export async function invalidateAccountingMappingsOutside(
  deps: { db: DatabaseInterface },
  keep: AccountingMappingScope,
  at: Date = new Date(),
): Promise<number> {
  checkScope(keep);
  await withTenant({ tenantId: keep.tenantId }, () => mappings(deps.db)); // ensure table
  const result = await deps.db.query(
    `UPDATE accounting_mappings
        SET status = 'invalidated', invalidated_at = ?
      WHERE tenant_id = ? AND provider = ? AND status = 'active'
        AND (realm_id != ? OR environment != ?)
      RETURNING id`,
    at.toISOString(),
    keep.tenantId,
    keep.provider,
    keep.realmId,
    keep.environment,
  );
  return result.rows.length;
}

// ---------------------------------------------------------------------------
// Frozen invoice mapping
// ---------------------------------------------------------------------------

/** Input of {@link buildFrozenInvoiceMapping}. */
export interface BuildFrozenInvoiceMappingInput {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  /** The frozen invoice or credit note to map. */
  readonly invoiceId: string;
}

/**
 * Build the sync mapping for one invoice or credit note from the tenant's
 * mapping records, in the company and environment of its connection, so sync
 * callers pass only the tenant and document. Throws `MAPPING_INCOMPLETE`
 * listing every missing mapping (never a guess), so a UI can ask for them all.
 *
 * Sets `customerRef` from the customer mapping; the sync uses it instead of the
 * flat, unscoped `Invoice.customerExternalId`.
 */
export async function buildFrozenInvoiceMapping(
  input: BuildFrozenInvoiceMappingInput,
): Promise<QuickBooksFrozenInvoiceMapping> {
  const scope = await getAccountingMappingScope(input, input.tenantId);
  return withTenant({ tenantId: input.tenantId }, async () => {
    const invoice = await (
      await InvoiceCollection.create({ db: input.db })
    ).get({ id: input.invoiceId }, { cache: false });
    if (!invoice || invoice.tenantId !== input.tenantId)
      throw invalid('Invoice not found for the tenant');
    const lines = await (
      await InvoiceLineItemCollection.create({ db: input.db })
    ).findByInvoice(input.invoiceId);
    const active = new Map<string, AccountingMapping>();
    for (const row of await (await mappings(input.db)).listActive(scope))
      active.set(`${row.kind}\u0000${row.localId}`, row);
    const find = (kind: AccountingMappingKind, localId: string) =>
      active.get(`${kind}\u0000${localId}`);
    const missing = new Map<string, MissingAccountingMapping>();
    const need = (kind: AccountingMappingKind, localId: string) =>
      missing.set(`${kind}\u0000${localId}`, { kind, localId });

    const customer = invoice.customerId
      ? find('customer', invoice.customerId)
      : undefined;
    if (!customer) need('customer', invoice.customerId || '(none)');

    const lineMappings: Record<
      string,
      {
        itemRef: string;
        taxCodeRef: string;
        taxComponents?: { taxRateRef: string; compound: boolean }[];
      }
    > = {};
    const componentMappings: Record<string, { quickbooksTaxRateRef: string }> =
      {};
    for (const line of lines) {
      const item =
        (line.sku ? find('item', `sku:${line.sku}`) : undefined) ??
        find('item', 'default');
      if (!item) need('item', line.sku ? `sku:${line.sku}` : 'default');
      const taxLocal = line.taxCodeId || 'none';
      const taxCode = find('tax_code', taxLocal);
      if (!taxCode) need('tax_code', taxLocal);
      const details = taxCode?.detailsJson
        ? (JSON.parse(taxCode.detailsJson) as AccountingTaxCodeDetails)
        : undefined;
      for (const component of line.taxComponents) {
        const mapped = find('tax_component', component.taxComponentId);
        if (!mapped) need('tax_component', component.taxComponentId);
        else
          componentMappings[component.taxComponentId] = {
            quickbooksTaxRateRef: mapped.externalId,
          };
      }
      if (item && taxCode)
        lineMappings[String(line.id)] = {
          itemRef: item.externalId,
          taxCodeRef: taxCode.externalId,
          ...(details?.taxComponents
            ? { taxComponents: details.taxComponents.map((c) => ({ ...c })) }
            : {}),
        };
    }
    if (missing.size > 0)
      throw new AccountingMappingError(
        'MAPPING_INCOMPLETE',
        `Accounting mapping is incomplete: ${missing.size} missing`,
        [...missing.values()],
      );
    return {
      realmId: scope.realmId,
      environment: scope.environment,
      lines: lineMappings,
      components: componentMappings,
      customerRef: (customer as AccountingMapping).externalId,
    };
  });
}

// ---------------------------------------------------------------------------
// Customer resolution
// ---------------------------------------------------------------------------

/** A provider customer that may be the commerce customer. */
export interface AccountingCustomerCandidate {
  readonly externalId: string;
  readonly name: string;
  readonly email?: string;
}

/**
 * The provider's customer lookup and creation (happyvertical/sdk#1539: customer
 * find and find-or-create). The host adapts the SDK to this port; smrt tests use
 * fakes.
 */
export interface AccountingCustomerDirectory {
  /** Customers matching the name or email, any number. */
  find(query: {
    readonly name: string;
    readonly email?: string;
  }): Promise<readonly AccountingCustomerCandidate[]>;
  /**
   * Create the customer. `requestId` is stable per (customer, realm,
   * environment) so a retry cannot create a second one.
   */
  create(input: {
    readonly name: string;
    readonly email?: string;
    readonly requestId: string;
  }): Promise<{ readonly externalId: string }>;
}

/** The commerce customer as the provider should see it. */
export interface AccountingCustomerFacts {
  readonly customerId: string;
  readonly name: string;
  readonly email?: string;
}

/** Outcome of {@link resolveAccountingCustomer}. */
export type AccountingCustomerResolution =
  | {
      readonly status: 'mapped';
      readonly externalId: string;
      /** `mapping` was already there; `found` linked a single exact match; `created` made a new one. */
      readonly source: 'mapping' | 'found' | 'created';
    }
  | {
      readonly status: 'needs_confirmation';
      /** Operator must pick one, or explicitly choose to create a new customer. */
      readonly candidates: readonly AccountingCustomerCandidate[];
    };

function sameText(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function customerRequestId(
  scope: AccountingMappingScope,
  customerId: string,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'customer',
        scope.provider,
        scope.realmId,
        scope.environment,
        customerId,
      ]),
    )
    .digest('hex');
  return `smrt_cust_${digest.slice(0, 32)}`;
}

/** Input of {@link resolveAccountingCustomer}. */
export interface ResolveAccountingCustomerInput {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  readonly customer: AccountingCustomerFacts;
  readonly directory: AccountingCustomerDirectory;
  readonly confirmedBy?: string;
}

/**
 * Resolve the provider customer for a commerce customer, in the tenant's
 * connected company.
 *
 * 1. An active mapping wins (no provider call).
 * 2. Otherwise look the customer up. Exactly one match with the same email
 *    (or, without an email, the same name) is linked and recorded.
 * 3. Several matches, or a single match that agrees on neither email nor name,
 *    return `needs_confirmation` and change nothing.
 * 4. No match creates the customer (stable request id) and records it.
 *
 * Never silently creates a duplicate: the lookup always precedes a create, and
 * an ambiguous lookup stops. Confirm with {@link confirmAccountingCustomer}.
 */
export async function resolveAccountingCustomer(
  input: ResolveAccountingCustomerInput,
): Promise<AccountingCustomerResolution> {
  const scope = await getAccountingMappingScope(input, input.tenantId);
  const facts = input.customer;
  text(facts.customerId, 'Customer id');
  text(facts.name, 'Customer name');
  const existing = await getAccountingMapping(
    input,
    scope,
    'customer',
    facts.customerId,
  );
  if (existing)
    return {
      status: 'mapped',
      externalId: existing.externalId,
      source: 'mapping',
    };

  const candidates = await input.directory.find({
    name: facts.name,
    ...(facts.email ? { email: facts.email } : {}),
  });
  if (candidates.length === 0) {
    const created = await input.directory.create({
      name: facts.name,
      ...(facts.email ? { email: facts.email } : {}),
      requestId: customerRequestId(scope, facts.customerId),
    });
    await setAccountingMapping(input, scope, {
      kind: 'customer',
      localId: facts.customerId,
      externalId: created.externalId,
      externalName: facts.name,
      confirmedBy: input.confirmedBy,
    });
    return {
      status: 'mapped',
      externalId: created.externalId,
      source: 'created',
    };
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const agrees =
    only &&
    (facts.email
      ? sameText(only.email, facts.email)
      : sameText(only.name, facts.name));
  if (only && agrees) {
    await setAccountingMapping(input, scope, {
      kind: 'customer',
      localId: facts.customerId,
      externalId: only.externalId,
      externalName: only.name,
      confirmedBy: input.confirmedBy,
    });
    return { status: 'mapped', externalId: only.externalId, source: 'found' };
  }
  return { status: 'needs_confirmation', candidates };
}

/** Input of {@link confirmAccountingCustomer}. */
export interface ConfirmAccountingCustomerInput
  extends ResolveAccountingCustomerInput {
  /**
   * The operator's decision: link this provider customer (it must still be
   * among the provider's matches), or `'create'` a new one on purpose.
   */
  readonly choice: { readonly externalId: string } | 'create';
}

/** Record an operator's decision on an ambiguous customer match. */
export async function confirmAccountingCustomer(
  input: ConfirmAccountingCustomerInput,
): Promise<Extract<AccountingCustomerResolution, { status: 'mapped' }>> {
  const scope = await getAccountingMappingScope(input, input.tenantId);
  const facts = input.customer;
  if (input.choice === 'create') {
    const created = await input.directory.create({
      name: facts.name,
      ...(facts.email ? { email: facts.email } : {}),
      requestId: customerRequestId(scope, facts.customerId),
    });
    await setAccountingMapping(input, scope, {
      kind: 'customer',
      localId: facts.customerId,
      externalId: created.externalId,
      externalName: facts.name,
      confirmedBy: input.confirmedBy,
    });
    return {
      status: 'mapped',
      externalId: created.externalId,
      source: 'created',
    };
  }
  const chosen = text(input.choice.externalId, 'Provider customer id');
  const candidates = await input.directory.find({
    name: facts.name,
    ...(facts.email ? { email: facts.email } : {}),
  });
  const match = candidates.find((c) => c.externalId === chosen);
  if (!match)
    throw new AccountingMappingError(
      'CUSTOMER_NOT_A_CANDIDATE',
      'The chosen provider customer is not among the provider matches',
    );
  await setAccountingMapping(input, scope, {
    kind: 'customer',
    localId: facts.customerId,
    externalId: match.externalId,
    externalName: match.name,
    confirmedBy: input.confirmedBy,
  });
  return { status: 'mapped', externalId: match.externalId, source: 'found' };
}
