import { describe, expect, it, vi } from 'vitest';
import {
  CatalogRepresentationError,
  catalogRepresentationMediaType,
  evaluateCatalogAcquisitionCapability as evaluate,
  normalizeCatalogRepresentation as normalize,
} from '../catalog-capability.js';
import type {
  CatalogResourceRepresentation,
  CatalogSourceRecord,
} from '../catalog-contracts.js';
import { CatalogResource } from '../catalog-models.js';
import { CatalogReadService } from '../catalog-read-service.js';

const pdf: CatalogResourceRepresentation = {
  format: 'pdf',
  mediaType: 'application/pdf',
  byteLength: 20,
  validators: { etag: '"v1"', lastModified: 'Wed, 14 Dec 2022 12:29:18 GMT' },
  acquisition: { status: 'supported', maxBytes: 30 },
};
const zip: CatalogResourceRepresentation = {
  ...pdf,
  format: 'zip',
  mediaType: 'application/zip',
  acquisition: { status: 'unsupported-format' },
};
const row: CatalogSourceRecord & { id: string } = {
  id: 'id',
  providerId: 'im',
  stableId: 'student',
  revision: '1',
  canonicalUrl: 'https://example.test',
  title: 'Student',
  availableFormats: ['pdf'],
  visibility: 'catalog',
  licenseEvidence: { state: 'verified', permittedOperations: ['print'] },
};
describe('catalog acquisition capability boundary', () => {
  it.each([
    undefined,
    null,
    'null',
  ])('preserves legacy absence %s without inventing measured support', (value) => {
    expect(normalize(value)).toBeUndefined();
    expect(
      evaluate({ ...row, representation: value as undefined }, 'pdf'),
    ).toEqual({ allowed: true, verification: 'legacy' });
  });
  it.each([
    null,
    'application/octet-stream',
  ])('retains serialized unknown %s and denies before selection with empty formats', async (mediaType) => {
    const unknown: CatalogResourceRepresentation = {
      ...pdf,
      format: 'unknown',
      mediaType,
      acquisition: {
        status: 'unknown-format',
        reason:
          mediaType === null
            ? 'missing-content-type'
            : 'unrecognized-content-type',
      },
    };
    expect(normalize(JSON.stringify(unknown))).toEqual(unknown);
    expect(
      evaluate({ availableFormats: [], representation: unknown }, 'unknown'),
    ).toEqual({ allowed: false, reason: 'unknown-format', byteLength: 20 });
    const model = new CatalogResource();
    model.setRepresentation(unknown);
    expect(model.getRepresentation()).toEqual(unknown);
    const service = new CatalogReadService({
      search: async () => [
        {
          ...row,
          availableFormats: [],
          representation: JSON.stringify(
            unknown,
          ) as unknown as CatalogResourceRepresentation,
        },
      ],
    });
    const results = await service.search({
      tenantId: 'tenant',
      actorUserId: 'guardian',
      roles: ['guardian'],
    });
    expect(results[0]).toMatchObject({
      availableFormats: [],
      representation: unknown,
    });
  });
  it('validates complete MIME syntax before retaining the observed token', () => {
    expect(
      catalogRepresentationMediaType('Application/PDF; charset="utf-8"'),
    ).toBe('application/pdf');
    for (const mediaType of [
      '',
      'not a mime',
      'application/pdf; broken',
      'application/pdf, application/zip',
      `application/${'a'.repeat(513)}`,
    ])
      expect(() => catalogRepresentationMediaType(mediaType)).toThrow(
        CatalogRepresentationError,
      );
  });
  it.each([
    { mediaType: null, reason: 'unrecognized-content-type' },
    { mediaType: 'application/octet-stream', reason: 'missing-content-type' },
    { mediaType: 'application/pdf', reason: 'unrecognized-content-type' },
    { mediaType: 'garbage', reason: 'unrecognized-content-type' },
    { mediaType: '', reason: 'unrecognized-content-type' },
    {
      mediaType: 'application/octet-stream; foo=bar',
      reason: 'unrecognized-content-type',
    },
    { mediaType: undefined, reason: 'missing-content-type' },
  ])('rejects inconsistent unknown metadata %j', ({ mediaType, reason }) => {
    const unknown = {
      ...pdf,
      format: 'unknown',
      mediaType,
      acquisition: { status: 'unknown-format', reason },
    };
    expect(() => normalize(JSON.stringify(unknown))).toThrow(
      CatalogRepresentationError,
    );
    expect(
      evaluate(
        {
          availableFormats: [],
          representation: unknown as CatalogResourceRepresentation,
        },
        'pdf',
      ),
    ).toMatchObject({
      allowed: false,
      reason: 'invalid-representation-metadata',
    });
  });
  it('normalizes actual DOCX and denies new acquisition independently of legal permission', () => {
    const docx = {
      ...zip,
      format: 'docx',
      mediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    expect(normalize(docx)).toEqual(docx);
    expect(
      evaluate(
        {
          ...row,
          availableFormats: ['docx'],
          representation: docx as CatalogResourceRepresentation,
        },
        'docx',
      ),
    ).toMatchObject({ allowed: false, reason: 'unsupported-format' });
  });
  it('normalizes observed metadata without sharing mutable nested objects', () => {
    const normalized = normalize(JSON.stringify(pdf));
    expect(normalized).toEqual(pdf);
    expect(normalize(pdf)?.validators).not.toBe(pdf.validators);
  });
  it.each([
    '',
    'undefined',
    '[]',
    '{}',
    { ...pdf, format: 'docx' },
    {
      ...zip,
      format: 'docx',
      mediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      acquisition: { status: 'supported', maxBytes: 30 },
    },
    {
      ...zip,
      format: 'docx',
      mediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      acquisition: { status: 'size-limit', maxBytes: 10 },
    },
    { ...pdf, mediaType: 'application/zip' },
    { ...pdf, byteLength: 0 },
    { ...pdf, byteLength: Number.MAX_SAFE_INTEGER + 1 },
    { ...pdf, byteLength: 1.5 },
    { ...pdf, extra: true },
    { ...pdf, validators: { ...pdf.validators, etag: 'W/"v1"' } },
    { ...pdf, validators: { ...pdf.validators, lastModified: 'yesterday' } },
    { ...pdf, acquisition: { status: 'supported', maxBytes: 10 } },
    { ...pdf, acquisition: { status: 'size-limit', maxBytes: 30 } },
    { ...pdf, acquisition: { status: 'unsupported-format' } },
    { ...zip, acquisition: { status: 'supported', maxBytes: 30 } },
    { ...zip, acquisition: { status: 'unsupported-format', maxBytes: 30 } },
  ])('denies malformed present metadata instead of interpreting it as legacy: %j', (value) => {
    expect(() => normalize(value)).toThrow(CatalogRepresentationError);
    expect(
      evaluate(
        { ...row, representation: value as CatalogResourceRepresentation },
        'pdf',
      ),
    ).toEqual({ allowed: false, reason: 'invalid-representation-metadata' });
  });
  it('uses a side-effect-free evaluator before any selection, file write or provider request', () => {
    const createSelection = vi.fn();
    const writeFile = vi.fn();
    const request = vi.fn();
    const result = evaluate(
      { ...row, availableFormats: ['zip'], representation: zip },
      'zip',
    );
    if (result.allowed) {
      createSelection();
      writeFile();
      request();
    }
    expect(result).toMatchObject({
      allowed: false,
      reason: 'unsupported-format',
    });
    expect(createSelection).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('allows observed PDF, can tighten but never loosen snapshots, and requires matching format', () => {
    expect(evaluate({ ...row, representation: pdf }, 'pdf')).toEqual({
      allowed: true,
      verification: 'observed',
    });
    expect(
      evaluate({ ...row, representation: pdf }, 'pdf', { maxBytes: 10 }),
    ).toMatchObject({ allowed: false, reason: 'size-limit', maxBytes: 10 });
    expect(
      evaluate(
        {
          ...row,
          representation: {
            ...pdf,
            acquisition: { status: 'size-limit', maxBytes: 10 },
          },
        },
        'pdf',
        { maxBytes: 100 },
      ),
    ).toMatchObject({ allowed: false, reason: 'size-limit', maxBytes: 10 });
    expect(
      evaluate({ ...row, representation: pdf }, 'pdf', { maxBytes: 0 }),
    ).toMatchObject({
      allowed: false,
      reason: 'invalid-representation-metadata',
    });
    expect(evaluate({ ...row, representation: pdf }, 'zip')).toMatchObject({
      allowed: false,
      reason: 'format-unavailable',
    });
  });
  it('does not erase malformed persisted model/read metadata into legacy absence', async () => {
    const model = new CatalogResource();
    model.representation = '{"format":"pdf"}';
    expect(() => model.getRepresentation()).toThrow(CatalogRepresentationError);
    expect(() =>
      model.setRepresentation({
        format: 'pdf',
      } as CatalogResourceRepresentation),
    ).toThrow(CatalogRepresentationError);
    expect(model.representation).toBe('{"format":"pdf"}');
    const service = new CatalogReadService({
      search: async () => [
        {
          ...row,
          representation:
            '{"format":"pdf"}' as unknown as CatalogResourceRepresentation,
        },
      ],
    });
    await expect(
      service.search({
        tenantId: 'tenant',
        actorUserId: 'guardian',
        roles: ['guardian'],
      }),
    ).rejects.toThrow(CatalogRepresentationError);
  });
});
