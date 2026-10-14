import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  compileRuntimeReportSpec,
  describeRuntimeReportSource,
  type RuntimeReportCompileContext,
} from '../runtime-compiler.js';

import { parseRuntimeReportSpec } from '../runtime-spec.js';

class PolicyReportSource extends SmrtObject {}
class RestrictedPolicyReportSource extends SmrtObject {}

function register(name: string, definition: Record<string, unknown>) {
  ObjectRegistry.registerFieldDecorator(
    'PolicyReportSource',
    name,
    definition as never,
  );
}

function context(
  policy: Record<string, unknown> = {},
): RuntimeReportCompileContext {
  return {
    sources: [{ id: 'records', className: 'PolicyReportSource', ...policy }],
    permissions: [],
    tenantId: '11111111-1111-4111-8111-111111111111',
  };
}

async function names(policy: Record<string, unknown> = {}) {
  const result = await describeRuntimeReportSource(context(policy), 'records');
  return result.fields.map((field) => field.name);
}

function query(overrides: Record<string, unknown> = {}) {
  return parseRuntimeReportSpec({
    title: 'Records',
    source: 'records',
    dimensions: [],
    measures: [{ fn: 'count', as: 'records' }],
    ...overrides,
  });
}

beforeEach(() => {
  register('title', { type: 'text' });
  register('amount', { type: 'integer' });
  register('signatureAssetId', { type: 'text' });
  register('tenantAlias', { type: 'text', columnName: 'tenant_id' });
  register('secret', { type: 'text', sensitive: true });
  register('margin', { type: 'integer', readPermission: 'finance.margins' });
  register('tenantId', {
    type: 'text',
    _meta: { __tenancy: { isTenantIdField: true, mode: 'required' } },
  });
  register('created_at', { type: 'datetime' });
  register('updated_at', { type: 'datetime' });
  ObjectRegistry.register(PolicyReportSource, {
    tableName: 'policy_report_sources',
    tenantScoped: { mode: 'required' },
  });
});

describe('server-owned runtime source field policy', () => {
  it('intersects allow-list and exclusions with existing field authority', async () => {
    expect(
      await names({ fields: ['title', 'amount'], excludeFields: ['amount'] }),
    ).toEqual(['title']);
    expect(await names({ fields: [] })).toEqual([]);
    expect(
      await names({ fields: ['secret', 'margin', 'tenantId', 'tenantAlias'] }),
    ).toEqual([]);
    const allowed = context({ fields: ['margin'] });
    allowed.permissions = ['finance.margins'];
    expect(
      (await describeRuntimeReportSource(allowed, 'records')).fields,
    ).toMatchObject([{ name: 'margin' }]);
  });

  it('exposes each base timestamp once, using its canonical spelling', async () => {
    const fields = await names();
    expect(
      fields.filter((name) => /created|updated/.test(name)).sort(),
    ).toEqual(['createdAt', 'updatedAt']);
    expect(
      await names({ excludeFields: ['createdAt', 'updatedAt'] }),
    ).not.toEqual(expect.arrayContaining(['createdAt', 'updatedAt']));
  });

  it('cannot resurrect a timestamp alias with restricted model metadata', async () => {
    ObjectRegistry.registerFieldDecorator(
      'RestrictedPolicyReportSource',
      'created_at',
      {
        type: 'datetime',
        sensitive: true,
      },
    );
    ObjectRegistry.registerFieldDecorator(
      'RestrictedPolicyReportSource',
      'updated_at',
      {
        type: 'datetime',
        readPermission: 'timestamps.read',
      },
    );
    ObjectRegistry.register(RestrictedPolicyReportSource, {
      tableName: 'restricted_policy_sources',
    });
    expect(
      await names({
        className: 'RestrictedPolicyReportSource',
        fields: ['createdAt', 'updatedAt'],
      }),
    ).toEqual([]);
  });

  it.each([
    { dimensions: [{ field: 'signatureAssetId' }] },
    {
      measures: [
        { fn: 'countDistinct', field: 'signatureAssetId', as: 'signatures' },
      ],
    },
    { filters: [{ field: 'signatureAssetId', op: 'eq', value: 'secret-key' }] },
    { dimensions: [{ field: 'created_at' }] },
    { dimensions: [{ field: 'updated_at' }] },
  ])('rejects excluded or noncanonical fields in every input position: %j', async (part) => {
    await expect(
      compileRuntimeReportSpec(
        query(part),
        context({
          excludeFields: ['signatureAssetId'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'unknown_field' });
  });

  it.each([
    { fields: 'title' },
    { fields: null },
    { fields: [1] },
    { excludeFields: Array(1) },
    { fields: ['misspelled'] },
    { excludeFields: ['signature_asset_id'] },
    { excludeFields: 'signatureAssetId' },
  ])('fails closed on invalid host configuration: %j', async (policy) => {
    await expect(names(policy)).rejects.toMatchObject({
      code: 'unsupported_source',
    });
    await expect(
      compileRuntimeReportSpec(query(), context(policy)),
    ).rejects.toMatchObject({ code: 'unsupported_source' });
  });
});
