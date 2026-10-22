import type {
  CatalogAcquisitionCapabilityDecision,
  CatalogResourceRepresentation,
  CatalogSourceRecord,
} from './catalog-contracts.js';

export class CatalogRepresentationError extends Error {
  readonly code = 'invalid-representation-metadata';
  constructor() {
    super('Catalog representation metadata is invalid.');
    this.name = 'CatalogRepresentationError';
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CatalogRepresentationError();
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new CatalogRepresentationError();
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Missing/null is legacy; malformed present data always throws, never becomes absence. */
export function normalizeCatalogRepresentation(
  value: unknown,
): CatalogResourceRepresentation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value.length > 4096) throw new CatalogRepresentationError();
    try {
      value = JSON.parse(value);
    } catch {
      throw new CatalogRepresentationError();
    }
    if (value === null) return undefined;
  }
  const record = object(value);
  keys(record, [
    'format',
    'mediaType',
    'byteLength',
    'validators',
    'acquisition',
  ]);
  if (
    !(
      (record.format === 'pdf' && record.mediaType === 'application/pdf') ||
      (record.format === 'zip' && record.mediaType === 'application/zip')
    ) ||
    !positive(record.byteLength)
  )
    throw new CatalogRepresentationError();
  const validators = object(record.validators);
  keys(validators, ['etag', 'lastModified']);
  if (
    typeof validators.etag !== 'string' ||
    !/^"[\x21\x23-\x7e]{1,200}"$/.test(validators.etag) ||
    typeof validators.lastModified !== 'string' ||
    validators.lastModified.length > 100 ||
    !Number.isFinite(Date.parse(validators.lastModified)) ||
    new Date(validators.lastModified).toUTCString() !== validators.lastModified
  )
    throw new CatalogRepresentationError();
  const capability = object(record.acquisition);
  keys(capability, ['status', 'maxBytes']);
  let acquisition: CatalogResourceRepresentation['acquisition'];
  if (record.format === 'zip') {
    if (
      capability.status !== 'unsupported-format' ||
      capability.maxBytes !== undefined
    )
      throw new CatalogRepresentationError();
    acquisition = { status: 'unsupported-format' };
  } else {
    if (
      !positive(capability.maxBytes) ||
      (capability.status !== 'supported' &&
        capability.status !== 'size-limit') ||
      (capability.status === 'supported') !==
        record.byteLength <= capability.maxBytes
    )
      throw new CatalogRepresentationError();
    acquisition = {
      status: capability.status as 'supported' | 'size-limit',
      maxBytes: capability.maxBytes,
    };
  }
  return {
    format: record.format,
    mediaType: record.mediaType as CatalogResourceRepresentation['mediaType'],
    byteLength: record.byteLength,
    validators: {
      etag: validators.etag,
      lastModified: validators.lastModified,
    },
    acquisition,
  };
}

/** Read-only preselection guard for NEW downloads. It does not authorize legal use or pinned-byte printing. */
export function evaluateCatalogAcquisitionCapability(
  resource: Pick<CatalogSourceRecord, 'availableFormats' | 'representation'>,
  format: string,
  limits?: { maxBytes?: number },
): CatalogAcquisitionCapabilityDecision {
  let representation: CatalogResourceRepresentation | undefined;
  try {
    representation = normalizeCatalogRepresentation(resource.representation);
    if (limits?.maxBytes !== undefined && !positive(limits.maxBytes))
      throw new CatalogRepresentationError();
  } catch {
    return { allowed: false, reason: 'invalid-representation-metadata' };
  }
  if (
    !Array.isArray(resource.availableFormats) ||
    !resource.availableFormats.includes(format)
  )
    return { allowed: false, reason: 'format-unavailable' };
  if (!representation) return { allowed: true, verification: 'legacy' };
  if (representation.format !== format)
    return { allowed: false, reason: 'format-unavailable' };
  if (representation.acquisition.status === 'unsupported-format')
    return {
      allowed: false,
      reason: 'unsupported-format',
      byteLength: representation.byteLength,
    };
  const maxBytes = Math.min(
    representation.acquisition.maxBytes,
    limits?.maxBytes ?? representation.acquisition.maxBytes,
  );
  if (
    representation.acquisition.status === 'size-limit' ||
    representation.byteLength > maxBytes
  )
    return {
      allowed: false,
      reason: 'size-limit',
      maxBytes,
      byteLength: representation.byteLength,
    };
  return { allowed: true, verification: 'observed' };
}
