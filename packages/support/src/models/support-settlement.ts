/**
 * Derived commercial snapshots for approved Service Time Entries
 * (FR-32/FR-35, issue #1930). Two deliberately separate rows per entry:
 *
 * - **SupportCharge** — what the Client owes, derived from the Managed
 *   Support Plan (included-time consumption, then metered overage).
 * - **SupportCompensation** — what the delivering Participant earns, derived
 *   from the Support Compensation Plan.
 *
 * Margin = charge − compensation, computed by readers; the two records are
 * never merged so client pricing can't leak provider terms. Rows snapshot the
 * rate terms at derivation time (`rateSnapshot`) — later plan edits never
 * rewrite them; corrections void/supersede and re-derive from the correcting
 * entry. Settlement (invoicing, ledger posting) is out of scope here and
 * composes at the app/accounting boundary (#1925).
 *
 * Append-only surfaces: `list`/`get` generated routes only; writes go through
 * `TimeEntryApprovalService`.
 */

import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { parseJsonField, type SupportSettlementStatus } from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_charges',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['time_entry_id'],
})
export class SupportCharge extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('ServiceTimeEntry', { required: true })
  timeEntryId: string = '';

  @foreignKey('SupportCase')
  caseId: string | null = null;

  /** Plan the pricing derived from (null = no plan; zero-amount charge). */
  @foreignKey('SupportPlan')
  planId: string | null = null;

  /**
   * Client charge for the billable time, in **integer minor units** of
   * {@link currency} (#2401). Derived by the approval service, which rounds
   * `(hours * rate)` to a whole minor unit at the one boundary where a rate
   * meets money, so every comparison downstream is exact.
   */
  amount: number = 0;

  @field({ type: 'text' })
  currency: string = 'USD';

  /** Seconds priced at the metered rate (after included-time consumption). */
  billableSeconds: number = 0;

  /** Seconds absorbed by the plan's included support time. */
  includedSecondsApplied: number = 0;

  /**
   * JSON snapshot of the pricing terms used: hourly rate, rate source
   * (`overage` | `on_call` | `none`), plan key, included-time state,
   * derivation timestamp. Never rewritten by later plan edits.
   */
  @field({ type: 'text' })
  rateSnapshot: string = '{}';

  @field({ type: 'text' })
  status: SupportSettlementStatus = 'pending';

  finalizedAt: Date | null = null;

  @field({ type: 'text' })
  metadata: string = '{}';

  getRateSnapshot(): Record<string, unknown> {
    return parseJsonField(this.rateSnapshot, {});
  }

  setRateSnapshot(value: Record<string, unknown>): void {
    this.rateSnapshot = JSON.stringify(value ?? {});
  }
}

export class SupportChargeCollection extends SmrtCollection<SupportCharge> {
  static readonly _itemClass = SupportCharge;

  async forTimeEntry(timeEntryId: string): Promise<SupportCharge | null> {
    const matches = await this.list({ where: { timeEntryId }, limit: 1 });
    return matches[0] ?? null;
  }

  async forCase(caseId: string): Promise<SupportCharge[]> {
    return this.list({ where: { caseId }, orderBy: 'created_at ASC' });
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_compensations',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['time_entry_id'],
})
export class SupportCompensation extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('ServiceTimeEntry', { required: true })
  timeEntryId: string = '';

  @foreignKey('SupportSpecialist')
  specialistId: string | null = null;

  /** Compensation plan the earning derived from (null = no plan resolved). */
  @foreignKey('SupportCompensationPlan')
  compensationPlanId: string | null = null;

  /**
   * Provider earning for the payable time, in **integer minor units** of
   * {@link currency} (#2401). Converts with {@link SupportCharge.amount}: the
   * delivery margin is the difference between the two.
   */
  amount: number = 0;

  @field({ type: 'text' })
  currency: string = 'USD';

  /** Seconds compensated. */
  payableSeconds: number = 0;

  /** JSON snapshot of the earning terms used at derivation time. */
  @field({ type: 'text' })
  rateSnapshot: string = '{}';

  @field({ type: 'text' })
  status: SupportSettlementStatus = 'pending';

  finalizedAt: Date | null = null;

  @field({ type: 'text' })
  metadata: string = '{}';

  getRateSnapshot(): Record<string, unknown> {
    return parseJsonField(this.rateSnapshot, {});
  }

  setRateSnapshot(value: Record<string, unknown>): void {
    this.rateSnapshot = JSON.stringify(value ?? {});
  }
}

export class SupportCompensationCollection extends SmrtCollection<SupportCompensation> {
  static readonly _itemClass = SupportCompensation;

  async forTimeEntry(timeEntryId: string): Promise<SupportCompensation | null> {
    const matches = await this.list({ where: { timeEntryId }, limit: 1 });
    return matches[0] ?? null;
  }

  async forSpecialist(specialistId: string): Promise<SupportCompensation[]> {
    return this.list({ where: { specialistId }, orderBy: 'created_at ASC' });
  }
}

export default SupportCharge;
