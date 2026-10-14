import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { MoneyValidationError } from '../money.js';
import type { TaxComponentOptions } from '../types/index.js';

/**
 * One reusable tax rate component. Codes may combine components, but the
 * component's percent is immutable after it has been saved: archive it and
 * repoint editable codes to a replacement rate instead of rewriting history.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class TaxComponent extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ description: 'The name of this tax component, for example GST.' })
  name = '';

  /** Percent, not a fraction: 7.125 means 7.125%. Stored as DECIMAL. */
  @field({
    type: 'decimal',
    description: 'The tax percentage, for example 7.125 for 7.125 percent.',
  })
  percent = '0.0';

  @crossPackageRef('@happyvertical/smrt-ledgers:Account', {
    description: 'The liability account that receives this tax component.',
  })
  liabilityAccountId = '';

  @field({
    description:
      'Whether purchases using this component may recover the full input tax. Partial recovery is not supported.',
  })
  recoverable = false;

  @field({ description: 'Whether new tax codes and overrides may select it.' })
  active = true;

  private persistedPercent: string | null = null;

  constructor(options: TaxComponentOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.percent !== undefined) this.percent = options.percent;
    if (options.liabilityAccountId !== undefined)
      this.liabilityAccountId = options.liabilityAccountId;
    if (options.recoverable !== undefined)
      this.recoverable = options.recoverable;
    if (options.active !== undefined) this.active = options.active;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    this.persistedPercent = this.percent;
    return this;
  }

  override async save(): Promise<this> {
    if (
      !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(this.percent) ||
      (this.percent.length > 3 && Number(this.percent) > 100)
    ) {
      throw new MoneyValidationError(
        'PERCENT_OUT_OF_RANGE',
        'Tax component percent must be between 0 and 100 with at most six decimal places.',
      );
    }
    if (
      this.persistedPercent !== null &&
      this.persistedPercent !== this.percent
    ) {
      throw new MoneyValidationError(
        'PERCENT_OUT_OF_RANGE',
        'A referenced tax component rate is immutable; archive it and repoint its tax codes.',
      );
    }
    const saved = (await super.save()) as this;
    this.persistedPercent = this.percent;
    return saved;
  }
}
