import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { normalizeCatalogRepresentation } from './catalog-capability.js';
import type {
  CatalogLicenseState,
  CatalogResourceRepresentation,
  CatalogVisibility,
} from './catalog-contracts.js';
import {
  type CatalogPreview,
  normalizeCatalogPreview,
} from './catalog-preview.js';

const closed = { api: false, mcp: false, cli: false } as const;

/** Globally visible provider registration. Hosts configure adapters and credentials out of band. */
@smrt({ ...closed })
export class CatalogProvider extends SmrtObject {
  @field({ required: true }) providerId = '';
  @field({ required: true }) name = '';
  active = true;
}

/** A provider-native record. Rows are intentionally not merged across providers. */
@smrt({ ...closed })
export class CatalogResource extends SmrtObject {
  @field({ required: true }) providerId = '';
  @field({ required: true }) stableId = '';
  @field({ required: true }) revision = '';
  canonicalUrl = '';
  @field({ required: true }) title = '';
  suppliedDescription = '';
  author = '';
  subjects = '[]';
  grades = '{}';
  language = '';
  resourceType = '';
  parentStableId = '';
  availableFormats = '[]';
  /** Serialized observed representation; JSON null is legacy absence. */
  representation = 'null';
  /** Exact revision-bound publisher preview, not an original or private asset grant. */
  preview = 'null';

  getPreview(): CatalogPreview | undefined {
    return normalizeCatalogPreview(this.preview);
  }
  setPreview(value: CatalogPreview | undefined): void {
    if (value !== undefined && !normalizeCatalogPreview(value))
      throw new Error('Invalid catalog preview metadata.');
    this.preview = JSON.stringify(normalizeCatalogPreview(value) ?? null);
  }

  getRepresentation(): CatalogResourceRepresentation | undefined {
    return normalizeCatalogRepresentation(this.representation);
  }
  setRepresentation(value: CatalogResourceRepresentation | undefined): void {
    this.representation = JSON.stringify(
      normalizeCatalogRepresentation(value) ?? null,
    );
  }
  licenseEvidence = '{}';
  licenseState: CatalogLicenseState = 'unknown';
  visibility: CatalogVisibility = 'catalog';
  /** Last durable enumeration generation that observed this provider record. */
  lastSeenRunId = '';
  withdrawnAt = '';
}

/** Durable per-provider enumeration state. A failed or partial feed is never complete. */
@smrt({ ...closed })
export class CatalogSyncState extends SmrtObject {
  /** Provider-owned stable key, not an internal provider row ID. */
  @field({ required: true }) providerId = '';
  cursor = '';
  /** Persists across interrupted pages so terminal withdrawal is safe on resume. */
  runId = '';
  complete = false;
  paused = false;
  pauseReason = '';
  importedCount = 0;
  failures = '[]';
  lastSuccessfulAt = '';
}

/** Tenant-owned intent to use a metadata record, distinct from acquiring bytes. */
@TenantScoped({ mode: 'required' })
@smrt({ ...closed })
export class CatalogSelection extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CatalogResource', { required: true }) resourceId = '';
  @field({ required: true }) selectedByUserId = '';
  @field({ required: true }) selectedRevision = '';
}

/** A pinned, tenant-owned acquisition record. Bytes belong in a host storage service. */
@TenantScoped({ mode: 'required' })
@smrt({ ...closed })
export class CatalogAcquisition extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CatalogResource', { required: true }) resourceId = '';
  @foreignKey('CatalogSelection', { required: true }) selectionId = '';
  @field({ required: true }) revision = '';
  @field({ required: true }) format = '';
  @field({ required: true }) sha256 = '';
  attribution = '';
  notices = '';
}
