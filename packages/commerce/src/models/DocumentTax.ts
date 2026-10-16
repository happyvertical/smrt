/** Persisted per-code/component tax totals for a commerce document. */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  DOCUMENT_MONEY_WRITE,
  type DocumentMoneyWriteCapability,
} from '../document-money-internal.js';
import { MoneyValidationError, type TaxCodeKind } from '../money.js';

export type CommerceDocumentType = 'invoice' | 'contract' | 'credit_note';

export interface DocumentTaxOptions extends SmrtObjectOptions {
  tenantId?: string;
  documentType?: CommerceDocumentType;
  documentId?: string;
  currency?: string;
  taxCodeId?: string | null;
  taxCodeCode?: string | null;
  kind?: TaxCodeKind | null;
  taxComponentId?: string | null;
  taxComponentName?: string | null;
  percent?: string | null;
  liabilityAccountId?: string | null;
  taxableMinor?: number;
  taxMinor?: number;
  recoverableMinor?: number;
}
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'document_taxes',
  conflictColumns: [
    'document_type',
    'document_id',
    'tax_code_id',
    'tax_component_id',
  ],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class DocumentTax extends SmrtObject {
  @tenantId()
  tenantId = '';

  @field({ required: true })
  documentType: CommerceDocumentType = 'invoice';

  @field({ required: true })
  documentId = '';

  @field({ required: true })
  currency = 'USD';

  @field({ nullable: true })
  taxCodeId: string | null = null;

  @field({ nullable: true })
  taxCodeCode: string | null = null;

  @field({ nullable: true })
  kind: TaxCodeKind | null = null;

  @field({ nullable: true })
  taxComponentId: string | null = null;

  @field({ nullable: true })
  taxComponentName: string | null = null;

  @field({ type: 'decimal', nullable: true })
  percent: string | null = null;

  @field({ nullable: true })
  liabilityAccountId: string | null = null;

  @field({
    description: 'Tax-exclusive base in integer minor units.',
    ui: { format: 'money' },
  })
  taxableMinor = 0;

  @field({
    description: 'Tax total in integer minor units.',
    ui: { format: 'money' },
  })
  taxMinor = 0;

  @field({
    description: 'Recoverable purchase tax in integer minor units.',
    ui: { format: 'money' },
  })
  recoverableMinor = 0;

  constructor(options: DocumentTaxOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.documentType !== undefined)
      this.documentType = options.documentType;
    if (options.documentId !== undefined) this.documentId = options.documentId;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.taxCodeId !== undefined) this.taxCodeId = options.taxCodeId;
    if (options.taxCodeCode !== undefined)
      this.taxCodeCode = options.taxCodeCode;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.taxComponentId !== undefined)
      this.taxComponentId = options.taxComponentId;
    if (options.taxComponentName !== undefined)
      this.taxComponentName = options.taxComponentName;
    if (options.percent !== undefined) this.percent = options.percent;
    if (options.liabilityAccountId !== undefined)
      this.liabilityAccountId = options.liabilityAccountId;
    if (options.taxableMinor !== undefined)
      this.taxableMinor = options.taxableMinor;
    if (options.taxMinor !== undefined) this.taxMinor = options.taxMinor;
    if (options.recoverableMinor !== undefined)
      this.recoverableMinor = options.recoverableMinor;
  }

  private assertValidDerivedRow(): void {
    if (!['invoice', 'contract', 'credit_note'].includes(this.documentType)) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        `Unknown document tax type: ${this.documentType}`,
      );
    }
    for (const [label, value] of [
      ['tenantId', this.tenantId],
      ['documentId', this.documentId],
      ['currency', this.currency],
    ] as const) {
      if (!value || value.trim() !== value) {
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          `DocumentTax ${label} must be a nonempty value`,
        );
      }
    }
    for (const [label, value] of [
      ['taxableMinor', this.taxableMinor],
      ['taxMinor', this.taxMinor],
      ['recoverableMinor', this.recoverableMinor],
    ] as const) {
      if (!Number.isSafeInteger(value)) {
        throw new MoneyValidationError(
          'UNSAFE_MONEY',
          `DocumentTax ${label} must be safe integer minor units`,
        );
      }
    }
    if (this.taxCodeId === null) {
      if (
        this.taxComponentId !== null ||
        this.taxCodeCode !== null ||
        this.kind !== null ||
        this.taxComponentName !== null ||
        this.percent !== null ||
        this.liabilityAccountId !== null ||
        this.taxMinor !== 0 ||
        this.recoverableMinor !== 0
      ) {
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'An unassigned DocumentTax row cannot carry code/component snapshots or tax',
        );
      }
      return;
    }
    if (!this.taxCodeCode || !this.kind) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Assigned DocumentTax rows require code and kind snapshots',
      );
    }
    if (this.taxComponentId === null) {
      if (
        this.kind === 'taxable' ||
        this.taxComponentName !== null ||
        this.percent !== null ||
        this.liabilityAccountId !== null ||
        this.taxMinor !== 0 ||
        this.recoverableMinor !== 0
      ) {
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Component-less DocumentTax rows must be non-taxable zero-tax snapshots',
        );
      }
      return;
    }
    if (this.kind !== 'taxable' || !this.taxComponentName || !this.percent) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Component DocumentTax rows require taxable component snapshots',
      );
    }
    if (
      this.recoverableMinor !== 0 &&
      this.recoverableMinor !== this.taxMinor
    ) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'DocumentTax recoverableMinor must be zero or the component tax total',
      );
    }
  }

  override async save(): Promise<this> {
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'DocumentTax rows are derived and cannot be saved directly',
    );
  }

  override async delete(
    _options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'DocumentTax rows are derived and cannot be deleted directly',
    );
  }

  /** @internal Aggregate persistence only. */
  async saveDerived(capability: DocumentMoneyWriteCapability): Promise<this> {
    if (capability !== DOCUMENT_MONEY_WRITE) {
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'DocumentTax write capability is required',
      );
    }
    this.assertValidDerivedRow();
    return (await super.save()) as this;
  }

  /** @internal Aggregate persistence only. */
  async deleteDerived(
    capability: DocumentMoneyWriteCapability,
    options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    if (capability !== DOCUMENT_MONEY_WRITE) {
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'DocumentTax write capability is required',
      );
    }
    await super.delete(options);
  }
}
