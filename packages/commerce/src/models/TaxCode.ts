import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { MoneyValidationError } from '../money.js';
import type { TaxCodeOptions, TaxCodePart } from '../types/index.js';

export type TaxCodeKind = 'taxable' | 'zero-rated' | 'exempt' | 'out-of-scope';
export type TaxCodeAppliesTo = 'sales' | 'purchases' | 'both';

/** A reusable tax code whose ordered component list is safe to edit. */
@TenantScoped({ mode: 'required' })
@smrt({
  conflictColumns: ['tenant_id', 'code'],
  api: {
    include: ['list', 'get', 'create', 'update'],
    writable: ['code', 'name', 'kind', 'appliesTo', 'components', 'active'],
  },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class TaxCode extends SmrtObject {
  @tenantId()
  tenantId = '';

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
  /** Stored JSON is guarded through the typed accessor below. */
  componentsJson = '[]';

  @field({ description: 'The ordered tax components in this code.' })
  get components(): TaxCodePart[] {
    try {
      const value: unknown = JSON.parse(this.componentsJson);
      if (!Array.isArray(value)) return [];
      return value.filter(
        (part): part is TaxCodePart =>
          !!part &&
          typeof part === 'object' &&
          typeof (part as TaxCodePart).taxComponentId === 'string' &&
          typeof (part as TaxCodePart).compound === 'boolean',
      );
    } catch {
      return [];
    }
  }

  set components(value: TaxCodePart[] | string) {
    this.componentsJson =
      typeof value === 'string' ? value : JSON.stringify(value);
  }

  @field({
    description: 'Whether users may select this code for new documents.',
  })
  active = true;

  constructor(options: TaxCodeOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId ?? '';
    if (options.code !== undefined) this.code = options.code;
    if (options.name !== undefined) this.name = options.name;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.appliesTo !== undefined) this.appliesTo = options.appliesTo;
    if (options.components !== undefined)
      this.components = structuredClone(options.components);
    if (options.active !== undefined) this.active = options.active;
  }

  override async save(): Promise<this> {
    if (!this.code.trim() || !this.name.trim())
      throw new Error('Tax code requires a nonempty code and name');
    if (
      !['taxable', 'zero-rated', 'exempt', 'out-of-scope'].includes(this.kind)
    )
      throw new Error('Tax code kind is invalid');
    if (!['sales', 'purchases', 'both'].includes(this.appliesTo))
      throw new Error('Tax code appliesTo is invalid');
    const parts = this.parsedComponents();
    if (!parts)
      throw new Error('Tax code components must be a valid JSON array');
    const nonTaxable = this.kind !== 'taxable';
    if (nonTaxable && parts.length) {
      throw new MoneyValidationError(
        'TAX_CODE_NON_TAXABLE_COMPONENTS',
        `${this.kind} tax codes cannot have components.`,
      );
    }
    if (!nonTaxable && !parts.length) {
      throw new MoneyValidationError(
        'TAX_CODE_TAXABLE_EMPTY',
        'Taxable tax codes require at least one component.',
      );
    }
    const seen = new Set<string>();
    for (const component of parts) {
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
    return this.withTransaction(async () => {
      const { TaxComponentCollection } = await import(
        '../collections/TaxComponentCollection.js'
      );
      const components = await TaxComponentCollection.create({ db: this.db });
      for (const part of parts) {
        const component = await components.get(
          { id: part.taxComponentId },
          { cache: false },
        );
        if (!component) {
          throw new Error('Tax code components must belong to the same tenant');
        }
        if (!component.updated_at)
          throw new Error('Tax code component is missing its revision');
        await component.claimRevision(component.updated_at);
        if (!this.tenantId) this.tenantId = component.tenantId;
        if (component.tenantId !== this.tenantId)
          throw new Error('Tax code components must belong to the same tenant');
      }
      return (await super.save()) as this;
    });
  }

  private parsedComponents(): TaxCodePart[] | null {
    try {
      const value: unknown = JSON.parse(this.componentsJson);
      if (!Array.isArray(value)) return null;
      if (
        value.some(
          (part) =>
            !part ||
            typeof part !== 'object' ||
            typeof (part as TaxCodePart).taxComponentId !== 'string' ||
            !(part as TaxCodePart).taxComponentId.trim() ||
            typeof (part as TaxCodePart).compound !== 'boolean',
        )
      )
        return null;
      return value as TaxCodePart[];
    } catch {
      return null;
    }
  }
}
