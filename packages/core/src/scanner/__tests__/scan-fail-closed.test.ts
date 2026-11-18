/**
 * The shipped manifest pipeline (`ManifestBuilder`: scanner, adapter, and the
 * shared generation passes) reads decorator configuration in full or fails.
 *
 * A manifest drives generated routes, web field sets, MCP schemas and
 * migrations. Configuration the scanner could not read must never reach it as
 * "not configured": an absent surface key is open, an absent `sensitive` flag
 * is public, and an absent model is a missing table.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestBuilder } from '../../manifest/generator.js';
import {
  buildWebFieldDefinitions,
  resolveStandardCrudActions,
} from '../../vite-plugin/web-collections.js';
import type { SmartObjectDefinition } from '../types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PACKAGE = '@fixture/fail-closed';
const CORE = `import { SmrtObject, smrt, field, foreignKey } from '@happyvertical/smrt-core';`;

async function build(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-fail-closed-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: PACKAGE, version: '0.0.0' }),
  );
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  const manifest = await new ManifestBuilder(root).generate({
    include: ['src/**/*.ts'],
    outputMode: 'dev',
    outputDir: '.smrt',
    generateTypeStub: false,
  });
  const entry = (className: string) =>
    manifest.objects[`${PACKAGE}:${className}`] as
      | SmartObjectDefinition
      | undefined;
  return { root, manifest, entry };
}

describe('class decorator config in the generated manifest', () => {
  const CLOSED = `const closed = { tableName: 'fail_closed_vaults', api: false, mcp: false, cli: false };`;

  it('applies a config passed as a same-file constant', async () => {
    const { entry } = await build({
      'src/models/vault.ts': `${CORE}\n${CLOSED}\n@smrt(closed)\nexport class FailClosedVault extends SmrtObject {\n  name = '';\n  apiSecret = '';\n}`,
    });
    const vault = entry('FailClosedVault');

    expect(vault?.decoratorConfig).toMatchObject({
      tableName: 'fail_closed_vaults',
      api: false,
      mcp: false,
      cli: false,
    });
    expect(vault?.schema?.tableName).toBe('fail_closed_vaults');
    expect(resolveStandardCrudActions(vault?.decoratorConfig.api)).toEqual([]);
  });

  it('generates the same entry whether the constant is passed or spread', async () => {
    const passed = await build({
      'src/models/vault.ts': `${CORE}\n${CLOSED}\n@smrt(closed)\nexport class FailClosedVault extends SmrtObject { name = ''; }`,
    });
    const spread = await build({
      'src/models/vault.ts': `${CORE}\n${CLOSED}\n@smrt({ ...closed })\nexport class FailClosedVault extends SmrtObject { name = ''; }`,
    });
    const strip = (definition: SmartObjectDefinition | undefined) => ({
      ...definition,
      filePath: undefined,
    });

    expect(strip(passed.entry('FailClosedVault'))).toEqual(
      strip(spread.entry('FailClosedVault')),
    );
  });

  it('fails the build on a config it cannot read', async () => {
    await expect(
      build({
        'src/models/vault.ts': `${CORE}\nfunction buildConfig() { return { api: false }; }\n@smrt(buildConfig())\nexport class FailClosedVault extends SmrtObject { name = ''; }`,
      }),
    ).rejects.toThrow(/vault\.ts.*buildConfig\(\).*FailClosedVault/s);
  });

  it('keys a tenant-scoped class on the declared tenant field', async () => {
    const { entry } = await build({
      'src/models/vault.ts': `${CORE}\nimport { TenantScoped } from '@happyvertical/smrt-tenancy';\nconst TENANT_FIELD = 'orgId';\n@TenantScoped({ field: TENANT_FIELD })\n@smrt({ api: false })\nexport class FailClosedVault extends SmrtObject {\n  orgId = '';\n  name = '';\n}`,
    });
    const vault = entry('FailClosedVault');

    expect(vault?.decoratorConfig.tenantScoped).toMatchObject({
      field: 'orgId',
    });
    expect(vault?.decoratorConfig.conflictColumns).toEqual([
      'org_id',
      'slug',
      'context',
    ]);
    expect(Object.keys(vault?.schema?.columns ?? {})).toContain('org_id');
  });
});

describe('field decorator options in the generated manifest', () => {
  it('keeps field restrictions declared beside a same-file constant', async () => {
    const { entry } = await build({
      'src/models/account.ts': `${CORE}\nconst MAX_SECRET_LENGTH = 64;\nconst POLICY = 'RESTRICT';\n@smrt()\nexport class FailClosedOwner extends SmrtObject { name = ''; }\n@smrt()\nexport class FailClosedAccount extends SmrtObject {\n  @field({ sensitive: true, maxLength: MAX_SECRET_LENGTH }) apiSecret = '';\n  @field({ transient: true, maxLength: MAX_SECRET_LENGTH }) scratch = '';\n  @field({ unique: true, required: true, maxLength: MAX_SECRET_LENGTH }) handle = '';\n  @foreignKey(FailClosedOwner, { onDelete: POLICY }) ownerId = '';\n}`,
    });
    const account = entry('FailClosedAccount');
    if (!account) throw new Error('FailClosedAccount missing');

    expect(account.fields.apiSecret).toMatchObject({
      sensitive: true,
      maxLength: 64,
    });
    expect(account.fields.scratch.transient).toBe(true);
    expect(account.fields.handle).toMatchObject({
      required: true,
      maxLength: 64,
    });
    expect(account.fields.ownerId._meta?.onDelete).toBe('RESTRICT');

    const webFields = Object.keys(buildWebFieldDefinitions(account));
    expect(webFields).toContain('handle');
    expect(webFields).not.toContain('apiSecret');
    expect(Object.keys(account.schema?.columns ?? {})).not.toContain('scratch');
  });

  it('reads a field decorator imported under another name', async () => {
    const { entry } = await build({
      'src/models/account.ts': `import { SmrtObject, smrt, field as f } from '@happyvertical/smrt-core';\nimport * as core from '@happyvertical/smrt-core';\n@smrt()\nexport class FailClosedAccount extends SmrtObject {\n  @f({ sensitive: true }) aliasSecret = '';\n  @core.field({ sensitive: true }) namespaceSecret = '';\n  label = '';\n}`,
    });
    const account = entry('FailClosedAccount');
    if (!account) throw new Error('FailClosedAccount missing');

    expect(account.fields.aliasSecret.sensitive).toBe(true);
    expect(account.fields.namespaceSecret.sensitive).toBe(true);
    expect(Object.keys(buildWebFieldDefinitions(account))).toEqual(['label']);
  });

  it('fails the build on an option it cannot read', async () => {
    await expect(
      build({
        'src/models/account.ts': `${CORE}\nimport { MAX_SECRET_LENGTH } from './limits.js';\n@smrt()\nexport class FailClosedAccount extends SmrtObject {\n  @field({ sensitive: true, maxLength: MAX_SECRET_LENGTH }) apiSecret = '';\n}`,
        'src/models/limits.ts': `export const MAX_SECRET_LENGTH = 64;`,
      }),
    ).rejects.toThrow(
      /account\.ts.*MAX_SECRET_LENGTH.*FailClosedAccount\.apiSecret.*maxLength/s,
    );
  });
});

describe('configuration forms applications rely on', () => {
  it('keeps a feature table spread into a nested option', async () => {
    const { entry } = await build({
      'src/models/setting.ts': `${CORE}
export const FAIL_CLOSED_FEATURES = {
  'time.paid_break': { defaultEnabled: false, label: 'Paid break' },
  'time.offline_punch': { defaultEnabled: true, label: 'Offline punch' },
} as const;
@smrt({
  tableName: 'fail_closed_settings',
  api: { include: [] },
  features: { ...FAIL_CLOSED_FEATURES },
})
export class FailClosedSetting extends SmrtObject {
  key = '';
}`,
    });

    expect(entry('FailClosedSetting')?.decoratorConfig.features).toEqual({
      'time.paid_break': { defaultEnabled: false, label: 'Paid break' },
      'time.offline_punch': { defaultEnabled: true, label: 'Offline punch' },
    });
  });

  it('keeps a pattern literal as a validation rule beside its other options', async () => {
    const { entry } = await build({
      'src/models/order.ts': `${CORE}
@smrt()
export class FailClosedOrder extends SmrtObject {
  @field({ required: true, maxLength: 16, pattern: /^(draft|published)$/ })
  status = 'draft';
}`,
    });
    const order = entry('FailClosedOrder');

    expect(order?.fields.status).toMatchObject({
      required: true,
      maxLength: 16,
    });
    expect(order?.validationRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'status',
          rule: 'pattern',
          value: '^(draft|published)$',
        }),
        expect.objectContaining({ field: 'status', rule: 'maxLength' }),
      ]),
    );
    // The serialized manifest carries the pattern in the form it always has.
    expect(
      JSON.parse(JSON.stringify(order?.fields.status._meta)).pattern,
    ).toEqual({});
  });

  it('keeps a relationship whose target is a class reference', async () => {
    const { entry } = await build({
      'src/models/run.ts': `${CORE}\n@smrt()\nexport class FailClosedRun extends SmrtObject { name = ''; }`,
      'src/models/order.ts': `${CORE}
import { FailClosedRun } from './run.js';
@smrt()
export class FailClosedOrder extends SmrtObject {
  @foreignKey(FailClosedRun, { nullable: true, onDelete: 'RESTRICT' })
  runId: string | null = null;
  @foreignKey(() => FailClosedRun)
  lazyRunId = '';
}`,
    });
    const order = entry('FailClosedOrder');

    expect(order?.fields.runId).toMatchObject({
      type: 'foreignKey',
      related: 'FailClosedRun',
      required: false,
    });
    expect(order?.fields.runId._meta).toMatchObject({
      nullable: true,
      onDelete: 'RESTRICT',
    });
    expect(order?.fields.lazyRunId.related).toBe('FailClosedRun');
    expect(Object.keys(order?.schema?.columns ?? {})).toEqual(
      expect.arrayContaining(['run_id', 'lazy_run_id']),
    );
  });
});

describe('classes that share a name in the generated manifest', () => {
  const MODEL = `${CORE}\n@smrt()\nexport class FailClosedInvoice extends SmrtObject {\n  total = 0;\n}`;

  it('keeps a model beside an unrelated class of the same name', async () => {
    const { manifest, entry } = await build({
      'src/models/FailClosedInvoice.ts': MODEL,
      'src/pdf/FailClosedInvoice.ts': `export class FailClosedInvoice { render() { return ''; } }`,
    });

    expect(Object.keys(manifest.objects)).toEqual([
      `${PACKAGE}:FailClosedInvoice`,
    ]);
    expect(entry('FailClosedInvoice')?.schema?.tableName).toBe(
      'fail_closed_invoices',
    );
  });

  it('fails the build on two models of one name', async () => {
    await expect(
      build({
        'src/billing/FailClosedInvoice.ts': MODEL,
        'src/sales/FailClosedInvoice.ts': MODEL,
      }),
    ).rejects.toThrow(/Class name collision.*FailClosedInvoice/s);
  });
});
