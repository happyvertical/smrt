import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMobileContract } from '../build-contract.js';
import type { SmrtManifest } from '../types.js';

const manifest: SmrtManifest = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/sample-manifest.json'),
    'utf8',
  ),
);

const baseOptions = {
  manifests: [manifest],
  allowlist: ['FieldReport', 'Attachment'],
  kotlinPackage: 'com.example.generated',
  sourceLabel: 'fixtures/sample-manifest.json',
};

describe('buildMobileContract', () => {
  it('projects only allowlisted objects, in allowlist order', () => {
    const contract = buildMobileContract(baseOptions);

    expect(contract.objectCount).toBe(2);
    expect(contract.objects.map((object) => object.name)).toEqual([
      'FieldReport',
      'Attachment',
    ]);
    expect(contract.objects.map((object) => object.dtoName)).toEqual([
      'FieldReportDto',
      'AttachmentDto',
    ]);
  });

  it('injects a required id field first', () => {
    const contract = buildMobileContract(baseOptions);
    const [first] = contract.objects[0].fields;

    expect(first.name).toBe('id');
    expect(first.kotlinType).toBe('String');
    expect(first.kotlinDefault).toBeNull();
  });

  it('maps manifest field types to Kotlin types', () => {
    const contract = buildMobileContract(baseOptions);
    const fields = new Map(
      contract.objects[0].fields.map((field) => [field.name, field]),
    );

    expect(fields.get('created_at')?.kotlinType).toBe('Instant?');
    expect(fields.get('projectId')?.kotlinType).toBe('String');
    expect(fields.get('ownerRef')?.kotlinType).toBe('String');
    expect(fields.get('revision')?.kotlinType).toBe('Int');
    expect(fields.get('revision')?.kotlinDefault).toBe('1');
    expect(fields.get('confidence')?.kotlinType).toBe('DecimalString?');
    expect(fields.get('confidence')?.kotlinDefault).toBe('null');
    expect(fields.get('approved')?.kotlinType).toBe('Boolean');
    expect(fields.get('approved')?.kotlinDefault).toBe('true');
    // Raw `default` (current manifests) and quoted `defaultValue` (amaru-era).
    expect(fields.get('title')?.kotlinDefault).toBe('"Untitled"');
    expect(fields.get('status')?.kotlinDefault).toBe('"draft"');
    // Typeless field falls back to the *Json name heuristic.
    expect(fields.get('metadataJson')?.kotlinType).toBe('JsonObject');
  });

  it('excludes relationship declarations from DTO projection', () => {
    const contract = buildMobileContract(baseOptions);
    const names = contract.objects[0].fields.map((field) => field.name);

    expect(names).not.toContain('assignees');
    expect(names).toContain('ownerRef');
  });

  it('maps Kotlin types to Swift types', () => {
    const contract = buildMobileContract(baseOptions);
    const fields = new Map(
      contract.objects[0].fields.map((field) => [field.name, field]),
    );

    expect(fields.get('created_at')?.swiftType).toBe('String?');
    expect(fields.get('confidence')?.swiftType).toBe('String?');
    expect(fields.get('approved')?.swiftType).toBe('Bool');
    expect(fields.get('metadataJson')?.swiftType).toBe('String');
  });

  it('records table name and tenant scoping', () => {
    const contract = buildMobileContract(baseOptions);

    expect(contract.objects[0].tableName).toBe('field_reports');
    expect(contract.objects[0].hasTenantId).toBe(true);
    expect(contract.objects[1].hasTenantId).toBe(false);
  });

  it('produces a stable source hash that tracks the allowlist', () => {
    const first = buildMobileContract(baseOptions);
    const second = buildMobileContract(baseOptions);
    const narrowed = buildMobileContract({
      ...baseOptions,
      allowlist: ['Attachment'],
    });

    expect(first.sourceHash).toBe(second.sourceHash);
    expect(first.sourceHash).not.toBe(narrowed.sourceHash);
  });

  it('resolves qualified allowlist entries', () => {
    const contract = buildMobileContract({
      ...baseOptions,
      allowlist: ['@happyvertical/fixture-objects:Attachment'],
    });

    expect(contract.objects[0].name).toBe('Attachment');
  });

  it('throws on allowlist entries missing from every manifest', () => {
    expect(() =>
      buildMobileContract({ ...baseOptions, allowlist: ['Nonexistent'] }),
    ).toThrow(/missing object: Nonexistent/);
  });

  it('throws on ambiguous short names across manifests', () => {
    const clone: SmrtManifest = {
      packageName: '@happyvertical/other-objects',
      objects: {
        '@happyvertical/other-objects:Attachment': {
          name: 'Attachment',
          qualifiedName: '@happyvertical/other-objects:Attachment',
          fields: {},
        },
      },
    };

    expect(() =>
      buildMobileContract({
        ...baseOptions,
        manifests: [manifest, clone],
        allowlist: ['Attachment'],
      }),
    ).toThrow(/ambiguous/);
  });
});
