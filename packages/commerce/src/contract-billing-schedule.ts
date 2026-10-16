/** Approved contract billing capacity; construction authorization belongs to the host. */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ContractCollection } from './collections/ContractCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import {
  DOCUMENT_MONEY_WRITE,
  lockDocumentMoneyParents,
} from './document-money-internal.js';
import { Agreement, type Contract, Order } from './models/Contract.js';
import type { Invoice } from './models/Invoice.js';
import { MoneyValidationError } from './money.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';
import { ContractStatus, InvoiceStatus } from './types/index.js';

/** Exact billing entitlement in the schedule's explicit net or gross basis. */
export interface ContractBillingMilestone {
  key: string;
  label: string;
  amountMinor: number;
}
/** Immutable approved revision; ceiling is derived from original money plus amendments. */
export interface ContractBillingScheduleRevision {
  revision: number;
  requestId: string;
  approvalEvidenceRef: string;
  taxPolicyEvidenceRef: string;
  currency: string;
  basis: 'net' | 'gross';
  amendmentMinor: number;
  approvedTotalMinor: number;
  milestones: ContractBillingMilestone[];
}
/** Exact invoice amounts the host approved, independently of a net-only billing ceiling. */
export interface ContractMilestoneInvoiceMoney {
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
}
/** Immutable issued claim; settlement, cancellation and credits never implicitly reopen it. */
export interface ContractMilestoneClaim {
  requestId: string;
  revision: number;
  milestoneKey: string;
  invoiceId: string;
  moneySnapshotId: string;
  approvedMoney: ContractMilestoneInvoiceMoney;
  invoiceApprovalEvidenceRef: string;
}
/** Persisted append-only schedule history and billing claims. */
export interface ContractBillingSchedule {
  version: 1;
  originalAmountMinor: number;
  capacityPolicy: 'issued-consumed';
  revisions: ContractBillingScheduleRevision[];
  claims: ContractMilestoneClaim[];
}
interface ScheduleCommand {
  db: DatabaseInterface;
  tenantId: string;
  contractId: string;
  requestId: string;
}
/** The host must authorize approval and retain the referenced policy/evidence. */
export interface ApproveContractBillingScheduleInput extends ScheduleCommand {
  expectedRevision: number;
  approvalEvidenceRef: string;
  taxPolicyEvidenceRef: string;
  currency: string;
  basis: 'net' | 'gross';
  /** Zero for the original schedule; explicit signed approved value change thereafter. */
  amendmentMinor: number;
  milestones: ContractBillingMilestone[];
}
/** Issue an existing prepared draft under exact host-approved money and capacity. */
export interface IssueContractMilestoneInvoiceInput extends ScheduleCommand {
  revision: number;
  milestoneKey: string;
  invoiceId: string;
  approvedMoney: ContractMilestoneInvoiceMoney;
  invoiceApprovalEvidenceRef: string;
}
function invalid(message: string): never {
  throw new MoneyValidationError('INVALID_MONEY_INPUT', message);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value)
    invalid(`${label} must be nonempty trimmed text`);
  return value;
}
function integer(value: unknown, label: string, signed = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (!signed && value < 0)
  )
    invalid(`${label} must be a ${signed ? '' : 'nonnegative '}safe integer`);
  return value;
}
function safe(value: bigint): number {
  const result = Number(value);
  return integer(result, 'Computed amount');
}
function context(input: ScheduleCommand): void {
  text(input.tenantId, 'Tenant');
  text(input.contractId, 'Contract');
  text(input.requestId, 'Request');
  if (getTenantId() !== input.tenantId)
    invalid('Schedule command requires its active tenant context');
}
function milestones(
  value: ContractBillingMilestone[],
): ContractBillingMilestone[] {
  if (!Array.isArray(value) || value.length === 0)
    invalid('A schedule requires milestones');
  const keys = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') invalid('Invalid milestone');
    const key = text(entry.key, 'Milestone key');
    if (keys.has(key)) invalid('Milestone keys must be unique');
    keys.add(key);
    return {
      key,
      label: text(entry.label, 'Milestone label'),
      amountMinor: integer(entry.amountMinor, 'Milestone amount'),
    };
  });
}
function money(
  value: ContractMilestoneInvoiceMoney,
): ContractMilestoneInvoiceMoney {
  if (!value || typeof value !== 'object')
    invalid('Approved invoice money is required');
  const netMinor = integer(value.netMinor, 'Approved net');
  const taxMinor = integer(value.taxMinor, 'Approved tax');
  const grossMinor = integer(value.grossMinor, 'Approved gross');
  if (BigInt(netMinor) + BigInt(taxMinor) !== BigInt(grossMinor))
    invalid('Approved invoice money must reconcile');
  return { netMinor, taxMinor, grossMinor };
}
/** Allocate integer relative weights with the exact rounding remainder on the final milestone. */
export function allocateContractMilestones(
  totalMinor: number,
  weights: readonly number[],
): number[] {
  integer(totalMinor, 'Total');
  if (!Array.isArray(weights) || !weights.length)
    invalid('Milestone weights are required');
  const values = weights.map((value) => {
    integer(value, 'Weight');
    if (!value) invalid('Weights must be positive');
    return BigInt(value);
  });
  const sum = values.reduce((a, b) => a + b, 0n);
  let remaining = BigInt(totalMinor);
  return values.map((value, index) => {
    const amount =
      index === values.length - 1
        ? remaining
        : (BigInt(totalMinor) * value) / sum;
    remaining -= amount;
    return safe(amount);
  });
}
/** Read immutable schedule evidence; a detached result cannot mutate its Contract. */
export function getContractBillingSchedule(
  contract: Contract,
): ContractBillingSchedule | null {
  if (!contract.billingScheduleJson) return null;
  let parsed: ContractBillingSchedule;
  try {
    parsed = JSON.parse(contract.billingScheduleJson);
  } catch {
    invalid('Stored billing schedule is invalid');
  }
  if (
    parsed.version !== 1 ||
    parsed.capacityPolicy !== 'issued-consumed' ||
    !Array.isArray(parsed.revisions) ||
    !parsed.revisions.length ||
    !Array.isArray(parsed.claims)
  )
    invalid('Stored billing schedule is invalid');
  return parsed;
}
async function loadContract(
  db: DatabaseInterface,
  tenantId: string,
  contractId: string,
): Promise<Order | Agreement> {
  const collection = await ContractCollection.create({ db });
  await lockDocumentMoneyParents([{ id: contractId, tenantId, collection }]);
  const contract = await collection.get({ id: contractId }, { cache: false });
  if (
    !(contract instanceof Order || contract instanceof Agreement) ||
    contract.tenantId !== tenantId ||
    !contract.customerId ||
    contract.status !== ContractStatus.ACCEPTED ||
    !contract.moneySnapshotId
  )
    invalid(
      'Schedule requires an accepted customer contract in the active tenant',
    );
  return contract;
}
/** Append an approved schedule; original frozen Contract money remains authoritative and unchanged. */
export async function approveContractBillingSchedule(
  input: ApproveContractBillingScheduleInput,
): Promise<ContractBillingScheduleRevision> {
  context(input);
  const expectedRevision = integer(input.expectedRevision, 'Expected revision');
  const proposal = {
    requestId: input.requestId,
    approvalEvidenceRef: text(input.approvalEvidenceRef, 'Approval evidence'),
    taxPolicyEvidenceRef: text(
      input.taxPolicyEvidenceRef,
      'Tax policy evidence',
    ),
    currency: text(input.currency, 'Currency'),
    basis: input.basis,
    amendmentMinor: integer(input.amendmentMinor, 'Amendment', true),
    milestones: milestones(input.milestones),
  };
  if (proposal.basis !== 'net' && proposal.basis !== 'gross')
    invalid('Schedule basis must explicitly be net or gross');
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const contract = await loadContract(db, input.tenantId, input.contractId);
    const stored = getContractBillingSchedule(contract);
    const replay = stored?.revisions.find(
      (entry) => entry.requestId === input.requestId,
    );
    if (replay) {
      const { revision, approvedTotalMinor: _total, ...old } = replay;
      if (
        revision !== expectedRevision + 1 ||
        JSON.stringify(old) !== JSON.stringify(proposal)
      )
        invalid('Schedule request changed');
      return replay;
    }
    if (stored?.claims.some((entry) => entry.requestId === input.requestId))
      invalid('Request identity already used');
    const previous = stored?.revisions.at(-1);
    if ((previous?.revision ?? 0) !== expectedRevision)
      invalid('Schedule revision changed');
    if (
      contract.currency !== proposal.currency ||
      (previous &&
        (previous.currency !== proposal.currency ||
          previous.basis !== proposal.basis))
    )
      invalid('Schedule currency and basis must match original approval');
    const originalAmountMinor =
      stored?.originalAmountMinor ??
      (proposal.basis === 'net' ? contract.subtotal : contract.totalAmount);
    integer(originalAmountMinor, 'Original contract amount');
    if (!stored) {
      if (proposal.amendmentMinor !== 0)
        invalid('Initial schedule cannot amend original contract value');
      const invoices = await (
        await InvoiceCollection.create({ db })
      ).findByContract(input.contractId);
      if (
        invoices.some(
          (invoice) => invoice.kind === 'invoice' && !!invoice.moneySnapshotId,
        )
      )
        invalid(
          'Existing issued contract invoices prevent initial schedule approval',
        );
    }
    const approvedTotalMinor = safe(
      BigInt(previous?.approvedTotalMinor ?? originalAmountMinor) +
        BigInt(proposal.amendmentMinor),
    );
    if (
      proposal.milestones.reduce(
        (sum, entry) => sum + BigInt(entry.amountMinor),
        0n,
      ) !== BigInt(approvedTotalMinor)
    )
      invalid(
        'Milestone total must equal original contract plus approved amendments',
      );
    for (const claim of stored?.claims ?? []) {
      const prior = stored?.revisions
        .find((entry) => entry.revision === claim.revision)
        ?.milestones.find((entry) => entry.key === claim.milestoneKey);
      const next = proposal.milestones.find(
        (entry) => entry.key === claim.milestoneKey,
      );
      if (!prior || !next || JSON.stringify(prior) !== JSON.stringify(next))
        invalid('An issued milestone cannot be removed or changed');
    }
    const revision: ContractBillingScheduleRevision = {
      revision: expectedRevision + 1,
      ...proposal,
      approvedTotalMinor,
    };
    const state: ContractBillingSchedule = stored ?? {
      version: 1,
      originalAmountMinor,
      capacityPolicy: 'issued-consumed',
      revisions: [],
      claims: [],
    };
    state.revisions.push(revision);
    contract.billingScheduleJson = JSON.stringify(state);
    await contract.saveDerived(DOCUMENT_MONEY_WRITE);
    return revision;
  });
}

// An executor-bound, one-invoice capability. Never exported from the package.
const issuePermissions = new WeakMap<
  object,
  Map<
    string,
    {
      contractId: string;
      amountMinor: number;
      basis: 'net' | 'gross';
      approvedMoney: ContractMilestoneInvoiceMoney;
    }
  >
>();
/** @internal Called by the ordinary money aggregate before any new invoice freezes. */
export async function assertContractScheduleInvoiceFreeze(
  db: DatabaseInterface,
  invoice: Invoice,
): Promise<void> {
  if (invoice.kind !== 'invoice' || !invoice.contractId) return;
  const contract = await (await ContractCollection.create({ db })).get(
    { id: invoice.contractId },
    { cache: false },
  );
  if (!contract) return;
  if (contract.tenantId !== invoice.tenantId)
    invalid('Invoice contract must belong to its active tenant');
  const state = getContractBillingSchedule(contract);
  if (!state) return;
  // Abandoning an unissued draft creates no billing entitlement.
  if (
    invoice.status === InvoiceStatus.CANCELLED &&
    !invoice.moneySnapshotId &&
    !invoice.arJournalId
  )
    return;
  if (!(contract instanceof Order || contract instanceof Agreement))
    invalid('Scheduled contract must be a customer contract');
  const permission = invoice.id
    ? issuePermissions.get(db as object)?.get(invoice.id)
    : undefined;
  if (!permission || permission.contractId !== invoice.contractId)
    invalid(
      'Scheduled contract invoices must use issueContractMilestoneInvoice',
    );
  if (
    invoice.customerId !== contract.customerId ||
    invoice.currency !== contract.currency
  )
    invalid('Milestone invoice must match contract customer and currency');
  const actual = {
    netMinor: invoice.subtotal,
    taxMinor: invoice.taxAmount,
    grossMinor: invoice.totalAmount,
  };
  if (
    JSON.stringify(actual) !== JSON.stringify(permission.approvedMoney) ||
    (permission.basis === 'net' ? invoice.subtotal : invoice.totalAmount) !==
      permission.amountMinor
  )
    invalid('Milestone invoice money differs from approved amounts');
}
/** Atomically issue/freeze one prepared draft and consume exactly one approved milestone. */
export async function issueContractMilestoneInvoice(
  input: IssueContractMilestoneInvoiceInput,
): Promise<ContractMilestoneClaim> {
  context(input);
  const request = {
    requestId: input.requestId,
    revision: integer(input.revision, 'Revision'),
    milestoneKey: text(input.milestoneKey, 'Milestone key'),
    invoiceId: text(input.invoiceId, 'Invoice'),
    approvedMoney: money(input.approvedMoney),
    invoiceApprovalEvidenceRef: text(
      input.invoiceApprovalEvidenceRef,
      'Invoice approval evidence',
    ),
  };
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const contract = await loadContract(db, input.tenantId, input.contractId);
    const state = getContractBillingSchedule(contract);
    if (!state) invalid('Contract has no approved billing schedule');
    const replay = state.claims.find(
      (entry) => entry.requestId === request.requestId,
    );
    if (replay) {
      const { moneySnapshotId: _snapshot, ...prior } = replay;
      if (JSON.stringify(prior) !== JSON.stringify(request))
        invalid('Milestone issue request changed');
      return replay;
    }
    if (state.revisions.some((entry) => entry.requestId === request.requestId))
      invalid('Request identity already used');
    const revision = state.revisions.at(-1);
    if (!revision || revision.revision !== request.revision)
      invalid('Schedule revision changed');
    const milestone = revision.milestones.find(
      (entry) => entry.key === request.milestoneKey,
    );
    if (!milestone) invalid('Milestone does not exist in approved revision');
    if (
      state.claims.some(
        (entry) =>
          entry.milestoneKey === request.milestoneKey ||
          entry.invoiceId === request.invoiceId,
      )
    )
      invalid('Milestone or invoice already consumed');
    const invoices = await InvoiceCollection.create({ db });
    await lockDocumentMoneyParents([
      { id: request.invoiceId, tenantId: input.tenantId, collection: invoices },
    ]);
    const invoice = await invoices.get(
      { id: request.invoiceId },
      { cache: false },
    );
    if (
      !invoice ||
      invoice.tenantId !== input.tenantId ||
      invoice.kind !== 'invoice' ||
      invoice.status !== InvoiceStatus.DRAFT ||
      invoice.moneySnapshotId ||
      invoice.contractId !== input.contractId ||
      invoice.customerId !== contract.customerId ||
      invoice.currency !== revision.currency
    )
      invalid(
        'Milestone requires a matching unissued draft in the active tenant',
      );
    const permissions = issuePermissions.get(db as object) ?? new Map();
    permissions.set(request.invoiceId, {
      contractId: input.contractId,
      amountMinor: milestone.amountMinor,
      basis: revision.basis,
      approvedMoney: request.approvedMoney,
    });
    issuePermissions.set(db as object, permissions);
    try {
      invoice.markSent();
      await invoice.save();
    } finally {
      permissions.delete(request.invoiceId);
      if (!permissions.size) issuePermissions.delete(db as object);
    }
    if (!invoice.moneySnapshotId) invalid('Milestone invoice was not frozen');
    const claim: ContractMilestoneClaim = {
      ...request,
      moneySnapshotId: invoice.moneySnapshotId,
    };
    state.claims.push(claim);
    contract.billingScheduleJson = JSON.stringify(state);
    await contract.saveDerived(DOCUMENT_MONEY_WRITE);
    return claim;
  });
}
