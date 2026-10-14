import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { TaxSettingsOptions } from '../types/index.js';

export interface TaxRegistration {
  taxComponentId: string;
  number: string;
  label: string;
}

/** Tenant-level defaults and registration numbers for tax determination. */
@TenantScoped({ mode: 'required' })
@smrt({
  api: { include: ['get', 'create', 'update'] },
  mcp: { include: ['get'] },
  cli: { skipApiCheck: true },
})
export class TaxSettings extends SmrtObject {
  @tenantId()
  tenantId = '';

  @crossPackageRef('@happyvertical/smrt-commerce:TaxCode', {
    description: 'The default tax code for sales documents.',
  })
  defaultSalesTaxCodeId = '';

  @crossPackageRef('@happyvertical/smrt-commerce:TaxCode', {
    description: 'The default tax code for purchase documents.',
  })
  defaultPurchaseTaxCodeId = '';

  @field({
    description:
      'Whether new document amounts are exclusive, inclusive or out of scope.',
  })
  defaultLineAmountType: 'exclusive' | 'inclusive' | 'none' = 'exclusive';

  @field({ description: 'Whether components round per line or per document.' })
  taxRoundingScope: 'line' | 'document' = 'line';

  @field({
    sensitive: true,
    description:
      'Registration numbers by tax component, for issued-document snapshots.',
  })
  taxRegistrations: TaxRegistration[] = [];

  constructor(options: TaxSettingsOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.defaultSalesTaxCodeId !== undefined)
      this.defaultSalesTaxCodeId = options.defaultSalesTaxCodeId;
    if (options.defaultPurchaseTaxCodeId !== undefined)
      this.defaultPurchaseTaxCodeId = options.defaultPurchaseTaxCodeId;
    if (options.defaultLineAmountType !== undefined)
      this.defaultLineAmountType = options.defaultLineAmountType;
    if (options.taxRoundingScope !== undefined)
      this.taxRoundingScope = options.taxRoundingScope;
    if (options.taxRegistrations !== undefined)
      this.taxRegistrations = structuredClone(options.taxRegistrations);
  }
}
