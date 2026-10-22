import { describe, expect, it, vi } from 'vitest';
import type { CatalogAcquisitionStore } from '../catalog-acquisition-service.js';
import { CatalogAcquisitionService } from '../catalog-acquisition-service.js';
import type { CatalogResourceRepresentation } from '../catalog-contracts.js';

const limited: CatalogResourceRepresentation = {
  format: 'pdf',
  mediaType: 'application/pdf',
  byteLength: 100,
  validators: { etag: '"v1"', lastModified: 'Wed, 14 Dec 2022 12:29:18 GMT' },
  acquisition: { status: 'size-limit', maxBytes: 50 },
};

const encoder = new TextEncoder();
const bytes = encoder.encode('selected worksheet');
const hash = '088b053384b8f40d64c4f79c2b2c9799ed01a8c157e54b5eef34d89229e3a8f8';
const resource = {
  id: 'resource-1',
  providerId: 'im',
  stableId: 'unit-1',
  revision: 'v1',
  canonicalUrl: 'https://example.test',
  title: 'Worksheet',
  visibility: 'catalog' as const,
  withdrawnAt: null,
  availableFormats: ['pdf'],
  licenseEvidence: {
    state: 'verified' as const,
    identifier: 'CC-BY-4.0',
    permittedOperations: ['print' as const],
    attribution: 'Author',
  },
};
function store(): CatalogAcquisitionStore & {
  createAcquisition: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(async () => resource),
    getSelection: vi.fn(async () => ({
      id: 'selection-1',
      tenantId: 'tenant',
      resourceId: 'resource-1',
      selectedRevision: 'v1',
    })),
    findAcquisition: vi.fn(async () => undefined),
    createAcquisition: vi.fn(async (input) => ({
      ...input,
      id: 'acquisition-1',
    })),
  };
}
const request = {
  tenantId: 'tenant',
  actorUserId: 'guardian',
  roles: ['guardian'],
  resourceId: 'resource-1',
  selectionId: 'selection-1',
  revision: 'v1',
  format: 'pdf',
  operation: 'print' as const,
};

describe('CatalogAcquisitionService', () => {
  it('acquires only an explicitly permitted selected revision and pins its hash', async () => {
    const state = store();
    const adapter = {
      acquire: vi.fn(async () => ({ bytes, sha256: hash, revision: 'v1' })),
    };
    const result = await new CatalogAcquisitionService(state, adapter).acquire(
      request,
    );
    expect(result).toMatchObject({
      revision: 'v1',
      sha256: hash,
      attribution: 'Author',
    });
    expect(adapter.acquire).toHaveBeenCalledWith({
      providerId: 'im',
      stableId: 'unit-1',
      revision: 'v1',
      format: 'pdf',
    });
  });

  it('denies direct unlicensed acquisition without calling the provider', async () => {
    const state = store();
    state.getResource = vi.fn(async () => ({
      ...resource,
      licenseEvidence: { state: 'unknown' as const },
    }));
    const adapter = { acquire: vi.fn() };
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire(request),
    ).rejects.toThrow('unverified-license');
    expect(adapter.acquire).not.toHaveBeenCalled();
  });

  it('requires a tenant-owned selected revision before calling the provider', async () => {
    const state = store();
    state.getSelection = vi.fn(async () => undefined);
    const adapter = { acquire: vi.fn() };
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire(request),
    ).rejects.toThrow('matching tenant selection');
    expect(adapter.acquire).not.toHaveBeenCalled();
  });

  it('returns an existing pinned acquisition without downloading again', async () => {
    const state = store();
    state.getResource = vi.fn(async () => ({
      ...resource,
      representation: limited,
    }));
    state.findAcquisition = vi.fn(async () => ({
      id: 'old',
      tenantId: 'tenant',
      resourceId: 'resource-1',
      revision: 'v1',
      format: 'pdf',
      sha256: hash,
    }));
    const adapter = { acquire: vi.fn() };
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire(request),
    ).resolves.toMatchObject({ id: 'old' });
    expect(adapter.acquire).not.toHaveBeenCalled();
  });

  it.each([
    limited,
    { format: 'pdf' } as CatalogResourceRepresentation,
  ])('denies new unsupported or malformed acquisition before provider or file writes', async (representation) => {
    const state = store();
    state.getResource = vi.fn(async () => ({ ...resource, representation }));
    const adapter = { acquire: vi.fn() };
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire(request),
    ).rejects.toThrow('Catalog acquisition unavailable');
    expect(adapter.acquire).not.toHaveBeenCalled();
    expect(state.createAcquisition).not.toHaveBeenCalled();
  });

  it('denies a legally permitted observed DOCX before provider and private acquisition writes', async () => {
    const state = store();
    state.getResource = vi.fn(async () => ({
      ...resource,
      availableFormats: ['docx'],
      representation: {
        ...limited,
        format: 'docx' as const,
        mediaType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const,
        acquisition: { status: 'unsupported-format' as const },
      },
    }));
    const adapter = { acquire: vi.fn() };
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire({
        ...request,
        format: 'docx',
      }),
    ).rejects.toThrow('unsupported-format');
    expect(adapter.acquire).not.toHaveBeenCalled();
    expect(state.createAcquisition).not.toHaveBeenCalled();
  });

  it('acquires a supported observed representation with its exact size', async () => {
    const state = store();
    state.getResource = vi.fn(async () => ({
      ...resource,
      representation: {
        ...limited,
        byteLength: bytes.byteLength,
        acquisition: { status: 'supported' as const, maxBytes: 50 },
      },
    }));
    const adapter = {
      acquire: vi.fn(async () => ({ bytes, sha256: hash, revision: 'v1' })),
    };
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire(request),
    ).resolves.toMatchObject({ sha256: hash });
    expect(state.createAcquisition).toHaveBeenCalledOnce();
  });

  it.each([
    1, 100,
  ])('rejects expanded/truncated bytes versus observed size %d before writing', async (byteLength) => {
    const state = store();
    state.getResource = vi.fn(async () => ({
      ...resource,
      representation: {
        ...limited,
        byteLength,
        acquisition: { status: 'supported' as const, maxBytes: 200 },
      },
    }));
    const adapter = {
      acquire: vi.fn(async () => ({ bytes, sha256: hash, revision: 'v1' })),
    };
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire(request),
    ).rejects.toThrow('observed representation length');
    expect(state.createAcquisition).not.toHaveBeenCalled();
  });

  it('rejects changed revisions and dishonest provider hashes', async () => {
    const state = store();
    const adapter = {
      acquire: vi.fn(async () => ({
        bytes,
        sha256: '0'.repeat(64),
        revision: 'v1',
      })),
    };
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire(request),
    ).rejects.toThrow('hash');
    await expect(
      new CatalogAcquisitionService(state, adapter).acquire({
        ...request,
        revision: 'v0',
      }),
    ).rejects.toThrow('no longer current');
  });
});
