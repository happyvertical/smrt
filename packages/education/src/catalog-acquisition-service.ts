import {
  evaluateCatalogAcquisitionCapability,
  normalizeCatalogRepresentation,
} from './catalog-capability.js';
import type {
  CatalogAcquireAdapter,
  CatalogActor,
  CatalogOperation,
  CatalogSourceRecord,
} from './catalog-contracts.js';
import { CatalogPolicy } from './catalog-policy.js';

export interface CatalogAcquisitionRecord {
  id: string;
  tenantId: string;
  resourceId: string;
  selectionId: string;
  revision: string;
  format: string;
  sha256: string;
  attribution?: string;
  notices?: string;
}

export interface CatalogSelectionRecord {
  id: string;
  tenantId: string;
  resourceId: string;
  selectedRevision: string;
}

export interface CatalogAcquisitionStore {
  getResource(
    resourceId: string,
  ): Promise<
    (CatalogSourceRecord & { id: string; withdrawnAt: Date | null }) | undefined
  >;
  getSelection(input: {
    tenantId: string;
    selectionId: string;
  }): Promise<CatalogSelectionRecord | undefined>;
  findAcquisition(input: {
    tenantId: string;
    resourceId: string;
    selectionId: string;
    revision: string;
    format: string;
  }): Promise<CatalogAcquisitionRecord | undefined>;
  createAcquisition(
    input: Omit<CatalogAcquisitionRecord, 'id'> & { bytes: Uint8Array },
  ): Promise<CatalogAcquisitionRecord>;
}

export interface CatalogAcquisitionRequest {
  tenantId: string;
  actorUserId: string;
  roles: readonly string[];
  resourceId: string;
  selectionId: string;
  revision: string;
  format: string;
  operation: CatalogOperation;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Explicit, policy-gated selected-content acquisition. Catalog discovery has no route here. */
export class CatalogAcquisitionService {
  constructor(
    private readonly store: CatalogAcquisitionStore,
    private readonly adapter: CatalogAcquireAdapter,
    private readonly policy = new CatalogPolicy(),
  ) {}

  async acquire(
    request: CatalogAcquisitionRequest,
  ): Promise<CatalogAcquisitionRecord> {
    const actor: CatalogActor = {
      tenantId: request.tenantId,
      actorUserId: request.actorUserId,
      roles: request.roles,
    };
    if (!actor.tenantId.trim() || !actor.actorUserId.trim())
      throw new Error('Trusted tenant and actor identity are required.');
    const resource = await this.store.getResource(request.resourceId);
    if (!resource) throw new Error('Catalog resource was not found.');
    if (resource.withdrawnAt)
      throw new Error('Withdrawn catalog resource cannot be acquired.');
    if (resource.revision !== request.revision)
      throw new Error(
        'Catalog resource revision is no longer current; reselect it.',
      );
    const selection = await this.store.getSelection({
      tenantId: actor.tenantId,
      selectionId: request.selectionId,
    });
    if (
      !selection ||
      selection.resourceId !== resource.id ||
      selection.selectedRevision !== request.revision
    )
      throw new Error(
        'A matching tenant selection is required for acquisition.',
      );
    if (!resource.availableFormats?.includes(request.format))
      throw new Error('Requested content format is unavailable.');
    const decision = this.policy.authorize(resource, request.operation, actor);
    if (!decision.allowed)
      throw new Error(`Catalog acquisition denied: ${decision.reason}`);
    const existing = await this.store.findAcquisition({
      tenantId: actor.tenantId,
      resourceId: resource.id,
      selectionId: selection.id,
      revision: request.revision,
      format: request.format,
    });
    if (existing) return existing;
    const capability = evaluateCatalogAcquisitionCapability(
      resource,
      request.format,
    );
    if (!capability.allowed)
      throw new Error(`Catalog acquisition unavailable: ${capability.reason}`);
    const acquired = await this.adapter.acquire({
      providerId: resource.providerId,
      stableId: resource.stableId,
      revision: request.revision,
      format: request.format,
    });
    if (acquired.revision !== request.revision)
      throw new Error('Provider returned an unpinned resource revision.');
    const representation = normalizeCatalogRepresentation(
      resource.representation,
    );
    if (
      representation &&
      acquired.bytes.byteLength !== representation.byteLength
    )
      throw new Error(
        'Acquired bytes differ from observed representation length.',
      );
    const actualHash = await digest(acquired.bytes);
    if (actualHash !== acquired.sha256.toLowerCase())
      throw new Error('Provider content hash did not match acquired bytes.');
    return await this.store.createAcquisition({
      tenantId: actor.tenantId,
      resourceId: resource.id,
      selectionId: selection.id,
      revision: request.revision,
      format: request.format,
      sha256: actualHash,
      attribution: resource.licenseEvidence.attribution,
      notices: resource.licenseEvidence.exceptions,
      bytes: acquired.bytes,
    });
  }
}
