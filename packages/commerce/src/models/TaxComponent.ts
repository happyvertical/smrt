import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { AccountCollection } from '@happyvertical/smrt-ledgers';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { MoneyValidationError } from '../money.js';
import type { TaxComponentOptions } from '../types/index.js';

const PERCENT = /^(\d+)(?:\.(\d{1,6}))?$/;

function isPercent(value: string): boolean {
  const match = PERCENT.exec(value);
  if (!match) return false;
  const scaled =
    BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return scaled <= 100_000_000n;
}

function canonicalPercent(value: string): string {
  const [whole, fraction = ''] = String(value).split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

/**
 * One reusable tax rate component. Codes may combine components, but the
 * component's percent is immutable after it has been saved: archive it and
 * repoint editable codes to a replacement rate instead of rewriting history.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'],
    writable: [
      'name',
      'percent',
      'liabilityAccountId',
      'recoverable',
      'active',
    ],
  },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class TaxComponent extends SmrtObject {
  @tenantId()
  tenantId = '';

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

  constructor(options: TaxComponentOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId ?? '';
    if (options.name !== undefined) this.name = options.name;
    if (options.percent !== undefined) this.percent = options.percent;
    if (options.liabilityAccountId !== undefined)
      this.liabilityAccountId = options.liabilityAccountId;
    if (options.recoverable !== undefined)
      this.recoverable = options.recoverable;
    if (options.active !== undefined) this.active = options.active;
  }

  override async save(): Promise<this> {
    if (!this.name.trim())
      throw new Error('Tax component requires a nonempty name');
    if (!isPercent(this.percent)) {
      throw new MoneyValidationError(
        'PERCENT_OUT_OF_RANGE',
        'Tax component percent must be between 0 and 100 with at most six decimal places.',
      );
    }
    this.percent = canonicalPercent(this.percent);
    return this.withTransaction(async () => {
      const { TaxComponentCollection } = await import(
        '../collections/TaxComponentCollection.js'
      );
      const components = await TaxComponentCollection.create({ db: this.db });
      const persisted = this.id
        ? await components.get({ id: this.id }, { cache: false })
        : null;
      if (persisted && canonicalPercent(persisted.percent) !== this.percent) {
        const referenced = await this.isReferenced(persisted);
        // claimRevision advanced the row's version; the pending save must use
        // that version rather than its stale caller snapshot.
        this.updated_at = persisted.updated_at;
        if (referenced) {
          throw new MoneyValidationError(
            'PERCENT_OUT_OF_RANGE',
            'A referenced tax component rate is immutable; archive it and repoint its tax codes.',
          );
        }
      }
      if (this.liabilityAccountId) {
        const accounts = await AccountCollection.create({ db: this.db });
        const account = await accounts.get(
          { id: this.liabilityAccountId },
          { cache: false },
        );
        if (!account || account.tenantId !== this.tenantId) {
          throw new Error(
            'Tax component liability account must belong to its tenant',
          );
        }
      }
      return (await super.save()) as this;
    });
  }

  private async isReferenced(persisted: TaxComponent): Promise<boolean> {
    if (!this.id) return false;
    if (!persisted.updated_at)
      throw new Error('Referenced tax component is missing its revision');
    // Claim before inspecting references. TaxCode.save() claims the same row
    // before attaching it, so a concurrent rate edit must reload and retry.
    await persisted.claimRevision(persisted.updated_at);
    const { TaxCodeCollection } = await import(
      '../collections/TaxCodeCollection.js'
    );
    const codes = await TaxCodeCollection.create({ db: this.db });
    return (await codes.list({ where: { tenantId: this.tenantId } })).some(
      (code) =>
        code.components.some(
          (component) => component.taxComponentId === this.id,
        ),
    );
  }
}
