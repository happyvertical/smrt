/** Metadata-only resource visibility. Teacher material is never learner-visible. */
export type CatalogVisibility = 'catalog' | 'teacher';
export type CatalogLicenseState =
  | 'verified'
  | 'unknown'
  | 'conflicting'
  | 'restricted';
export type CatalogOperation =
  | 'link'
  | 'download'
  | 'print'
  | 'adapt'
  | 'redistribute'
  | 'commercial-use';

/** Exact source evidence; no provider-wide license inference is permitted. */
export interface CatalogLicenseEvidence {
  state: CatalogLicenseState;
  identifier?: string;
  version?: string;
  sourceUrl?: string;
  attribution?: string;
  exceptions?: string;
  retrievedAt?: string;
  /** Operations expressly authorized by the source evidence. */
  permittedOperations?: CatalogOperation[];
}

/** A provider's durable source record. It remains distinct after deduplication. */
export interface CatalogSourceRecord {
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
  licenseEvidence: CatalogLicenseEvidence;
  visibility: CatalogVisibility;
}

export interface CatalogSyncFailure {
  cursor?: string;
  code: string;
  message: string;
  retryAfterMs?: number;
}

/** One metadata-only enumeration result. `complete` only means this page is terminal. */
export interface CatalogSyncPage {
  records: CatalogSourceRecord[];
  nextCursor?: string;
  complete: boolean;
  /** Honest non-terminal stop, e.g. missing source authorization. */
  paused?: boolean;
  exclusions?: CatalogSyncFailure[];
}

export interface CatalogSyncCheckpoint {
  providerId: string;
  /** Internal sync generation retained until its terminal page permits withdrawals. */
  runId?: string;
  cursor?: string;
  lastSuccessfulAt?: string;
  complete: boolean;
  paused?: boolean;
  pauseReason?: string;
  importedCount: number;
  failures: CatalogSyncFailure[];
}

export interface CatalogSyncAdapter {
  enumerate(input: {
    cursor?: string;
    checkpoint: CatalogSyncCheckpoint;
  }): Promise<CatalogSyncPage>;
}

export interface CatalogAcquireAdapter {
  acquire(input: {
    providerId: string;
    stableId: string;
    revision: string;
    format: string;
  }): Promise<{ bytes: Uint8Array; sha256: string; revision: string }>;
}

export interface CatalogActor {
  tenantId: string;
  actorUserId: string;
  roles: readonly string[];
}
