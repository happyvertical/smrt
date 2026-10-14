import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { MoneyValidationError } from '../money.js';
import type { TaxCodeOptions, TaxCodePart } from '../types/index.js';

export type TaxCodeKind = 'taxable' | 'zero-rated' | 'exempt' | 'out-of-scope';
export type TaxCodeAppliesTo = 'sales' | 'purchases' | 'both';

/** A reusable tax code whose ordered component list is safe to edit. */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class TaxCode extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ description: 'A stable short code, for example gst-pst-bc.' })
  code = '';

  @field({ description: 'The name people see for this tax code.' })
  name = '';

  @field({ description: 'How the tax code is reported.' })
  kind: TaxCodeKind = 'taxable';

  @field({
    description: 'Whether the code applies to sales, purchases or both.',
  })
  appliesTo: TaxCodeAppliesTo = 'both';

  /** Ordered component IDs; compound is reserved and deliberately unsupported. */
  @field({ description: 'The ordered tax components in this code.' })
  components: TaxCodePart[] = [];

  @field({
    description: 'Whether users may select this code for new documents.',
  })
  active = true;

  constructor(options: TaxCodeOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.code !== undefined) this.code = options.code;
    if (options.name !== undefined) this.name = options.name;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.appliesTo !== undefined) this.appliesTo = options.appliesTo;
    if (options.components !== undefined)
      this.components = structuredClone(options.components);
    if (options.active !== undefined) this.active = options.active;
  }

  override async save(): Promise<this> {
    const nonTaxable = this.kind !== 'taxable';
    if (nonTaxable && this.components.length) {
      throw new MoneyValidationError(
        'TAX_CODE_NON_TAXABLE_COMPONENTS',
        `${this.kind} tax codes cannot have components.`,
      );
    }
    if (!nonTaxable && !this.components.length) {
      throw new MoneyValidationError(
        'TAX_CODE_TAXABLE_EMPTY',
        'Taxable tax codes require at least one component.',
      );
    }
    const seen = new Set<string>();
    for (const component of this.components) {
      if (seen.has(component.taxComponentId)) {
        throw new MoneyValidationError(
          'TAX_CODE_DUPLICATE_COMPONENT',
          'A tax code cannot contain the same component twice.',
        );
      }
      seen.add(component.taxComponentId);
      if (component.compound) {
        throw new MoneyValidationError(
          'COMPOUND_UNSUPPORTED',
          'Compound tax components are reserved for a future release.',
        );
      }
    }
    return super.save() as Promise<this>;
  }
}
