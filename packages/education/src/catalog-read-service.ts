import { normalizeCatalogRepresentation } from './catalog-capability.js';
import type {
  CatalogActor,
  CatalogLicenseEvidence,
  CatalogResourceRepresentation,
  CatalogSourceRecord,
} from './catalog-contracts.js';
import { CatalogPolicy } from './catalog-policy.js';
import { type CatalogPreview, catalogPreviewFor } from './catalog-preview.js';

export interface CatalogReadStore {
  search(input: { query?: string; subject?: string; grade?: string }): Promise<
    readonly (CatalogSourceRecord & {
      id: string;
      withdrawnAt?: string | null;
    })[]
  >;
}

/** Deliberately metadata-only DTO: credentials, byte locations, and teacher records stay server-side. */
export interface CatalogResourceView {
  id: string;
  providerId: string;
  stableId: string;
  revision: string;
  canonicalUrl: string;
  title: string;
  suppliedDescription?: string;
  author?: string;
  subjects?: string[];
  gradeRange?: { min?: string; max?: string };
  language?: string;
  resourceType?: string;
  parentStableId?: string;
  availableFormats?: string[];
  representation?: CatalogResourceRepresentation;
  preview?: CatalogPreview;
  license: Pick<
    CatalogLicenseEvidence,
    | 'state'
    | 'identifier'
    | 'version'
    | 'attribution'
    | 'exceptions'
    | 'retrievedAt'
  >;
}

export class CatalogReadService {
  constructor(
    private readonly store: CatalogReadStore,
    private readonly policy = new CatalogPolicy(),
  ) {}

  async search(
    actor: CatalogActor,
    filter: { query?: string; subject?: string; grade?: string } = {},
  ): Promise<CatalogResourceView[]> {
    if (!actor.tenantId.trim() || !actor.actorUserId.trim())
      throw new Error('Trusted tenant and actor identity are required.');
    const records = await this.store.search(filter);
    return records
      .filter(
        (record) => !record.withdrawnAt && this.policy.canView(record, actor),
      )
      .map((record) => this.view(record));
  }

  private view(
    record: CatalogSourceRecord & { id: string },
  ): CatalogResourceView {
    const { licenseEvidence } = record;
    const representation = normalizeCatalogRepresentation(
      record.representation,
    );
    const preview = catalogPreviewFor(record);
    return {
      id: record.id,
      providerId: record.providerId,
      stableId: record.stableId,
      revision: record.revision,
      canonicalUrl: record.canonicalUrl,
      title: record.title,
      ...(record.suppliedDescription
        ? { suppliedDescription: record.suppliedDescription }
        : {}),
      ...(record.author ? { author: record.author } : {}),
      ...(record.subjects ? { subjects: [...record.subjects] } : {}),
      ...(record.gradeRange ? { gradeRange: { ...record.gradeRange } } : {}),
      ...(record.language ? { language: record.language } : {}),
      ...(record.resourceType ? { resourceType: record.resourceType } : {}),
      ...(record.parentStableId
        ? { parentStableId: record.parentStableId }
        : {}),
      ...(record.availableFormats
        ? { availableFormats: [...record.availableFormats] }
        : {}),
      ...(representation ? { representation } : {}),
      ...(preview ? { preview } : {}),
      license: {
        state: licenseEvidence.state,
        ...(licenseEvidence.identifier
          ? { identifier: licenseEvidence.identifier }
          : {}),
        ...(licenseEvidence.version
          ? { version: licenseEvidence.version }
          : {}),
        ...(licenseEvidence.attribution
          ? { attribution: licenseEvidence.attribution }
          : {}),
        ...(licenseEvidence.exceptions
          ? { exceptions: licenseEvidence.exceptions }
          : {}),
        ...(licenseEvidence.retrievedAt
          ? { retrievedAt: licenseEvidence.retrievedAt }
          : {}),
      },
    };
  }
}
