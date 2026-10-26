/**
 * `data.discover` summary mode (#4329): a bounded first discovery step whose
 * detail comes from `data.inspect`, under exactly the same permission gates.
 */

import { createHash } from 'node:crypto';
import type { DataQueryFilterOperator } from '@happyvertical/smrt-types';
import type { SessionPermissionRuntimeContext } from '@happyvertical/smrt-users';
import { describe, expect, it } from 'vitest';
import type {
  DataSurfaceAuditEntry,
  DataSurfaceDefinition,
  DataSurfaceSchema,
  DataSurfaceToolsOptions,
} from './data-surface.js';
import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  normalizeDataSurfaceRowCountHint,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';

const ALL_TOOLS = [
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
];

function fakeRun(
  allowedTools: string[] = ALL_TOOLS,
  permissions: string[] = [],
  readableCollections: readonly string[] = ['records'],
): PrincipalRun {
  return {
    context: {
      userId: 'delegated-user',
      tenantId: 'tenant-a',
      database: undefined,
      permissions,
      permissionSet: new Set(permissions),
      membership: null,
      postgresRls: false,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      user: null,
    } satisfies SessionPermissionRuntimeContext,
    permissions,
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error(`denied:${tool}`);
    },
    async assertOperation(collection, action) {
      if (!readableCollections.includes(collection) || action !== 'read') {
        throw new Error('rbac denied');
      }
      return {
        allowed: true,
        permission: `${collection}.read`,
        reason: 'permission_granted',
      };
    },
  };
}

/** A realistic surface: a dozen fields with operators, metadata, and limits. */
function syntheticSchema(index: number): DataSurfaceSchema {
  const types = ['string', 'number', 'datetime', 'boolean'] as const;
  const operators = {
    string: ['eq', 'ne', 'in', 'like'],
    number: ['eq', 'gt', 'gte', 'lt', 'lte'],
    datetime: ['eq', 'gt', 'gte', 'lt', 'lte'],
    boolean: ['eq'],
  } satisfies Record<(typeof types)[number], DataQueryFilterOperator[]>;
  return {
    version: 1,
    identityField: 'id',
    fields: [
      {
        id: 'id',
        type: 'string',
        projectable: true,
        sortable: true,
        filterOperators: ['eq', 'in'],
      },
      ...Array.from({ length: 12 }, (_, field) => ({
        id: `field_${index}_${field}`,
        type: types[field % types.length],
        projectable: true,
        sortable: field % 2 === 0,
        facetable: field % 3 === 0,
        filterOperators: operators[types[field % types.length]],
        metadata: { label: `Field ${field} of surface ${index}`, unit: 'n/a' },
      })),
      {
        id: 'tenant_secret',
        type: 'string',
        projectable: true,
        sensitive: true,
      },
      {
        id: 'payroll',
        type: 'number',
        projectable: true,
        readPermission: 'records.payroll',
      },
    ],
    defaultPageLimit: 25,
    maxPageLimit: 100,
    maxResultBytes: 64_000,
    supports: { cursorPagination: true, facets: true },
  };
}

function syntheticCatalog(count = 34): DataSurfaceDefinition[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `surface-${String(index).padStart(2, '0')}`,
    collection: 'records',
    className: `@acme/records:Record${index}`,
    label: `Records ${index}`,
    description:
      `Bounded, tenant-safe rows for record set ${index}.\n` +
      'Second line with operational detail the summary must not carry.',
    metadata: {
      domain: 'smrt-collection',
      adapter: 'SmrtCollection',
      queryModes: ['rows', 'count', 'facets'],
    },
    schema: syntheticSchema(index),
  }));
}

function tools(options: DataSurfaceToolsOptions) {
  return new Map(
    createDataSurfaceTools(options).map((tool) => [tool.slug, tool]),
  );
}

async function discover(
  options: DataSurfaceToolsOptions,
  run: PrincipalRun = fakeRun(),
): Promise<unknown> {
  const tool = tools(options).get(DATA_DISCOVER_TOOL_SLUG);
  if (!tool) throw new Error('missing discover tool');
  return tool.execute({ run, args: {}, db: undefined });
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * SHA-256 of the JSON of `data.discover` for `syntheticCatalog()` under
 * `fakeRun()`, recorded from the implementation before `discoverDetail`
 * existed (e4a97858c). Full mode must stay byte-identical to it. Reproduce it
 * against the base from `packages/agents` (the test only needs the base's
 * `createDataSurfaceTools`; the summary-only tests fail there as expected):
 *
 *   git show e4a97858c:packages/agents/src/data-surface.ts > src/data-surface.ts
 *   pnpm exec vitest run src/data-surface.discover-summary.test.ts -t byte-identical
 *   git checkout -- src/data-surface.ts
 */
const FULL_DISCOVER_BASELINE_SHA256 =
  '6e334cd5c7db4cf729ba0319cecd34d669b46b27f6335f67d570de29d77fb131';

async function inspect(
  options: DataSurfaceToolsOptions,
  surfaceId: string,
  run: PrincipalRun = fakeRun(),
): Promise<unknown> {
  const tool = tools(options).get(DATA_INSPECT_TOOL_SLUG);
  if (!tool) throw new Error('missing inspect tool');
  return tool.execute({ run, args: { surfaceId }, db: undefined });
}

function discoverDescription(options: DataSurfaceToolsOptions): string {
  const description = tools(options).get(DATA_DISCOVER_TOOL_SLUG)?.aiTool
    .function.description;
  if (typeof description !== 'string') throw new Error('missing description');
  return description;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function surface(
  overrides: Partial<DataSurfaceDefinition> = {},
): DataSurfaceDefinition {
  return { ...syntheticCatalog(1)[0], ...overrides };
}

describe('data.discover summary mode (#4329)', () => {
  it('keeps full-mode discovery byte-identical to the pre-summary output', async () => {
    const implicit = await discover({ surfaces: syntheticCatalog() });
    const explicit = await discover({
      surfaces: syntheticCatalog(),
      discoverDetail: 'full',
    });
    // Readable structural check first, so a shape change names the key.
    const [first] = implicit as Array<Record<string, unknown>>;
    expect(Object.keys(first)).toEqual([
      'id',
      'label',
      'description',
      'metadata',
      'collection',
      'identityField',
      'fields',
      'supports',
      'limits',
    ]);
    expect(Object.keys((first.fields as object[])[1])).toEqual([
      'id',
      'type',
      'projectable',
      'sortable',
      'facetable',
      'filterOperators',
      'metadata',
    ]);
    expect(sha256(implicit)).toBe(FULL_DISCOVER_BASELINE_SHA256);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(implicit));
  });

  it('changes the discover tool description only in summary mode', () => {
    const full = 'List data surfaces and their safe, readable fields.';
    expect(discoverDescription({ surfaces: [] })).toBe(full);
    expect(discoverDescription({ surfaces: [], discoverDetail: 'full' })).toBe(
      full,
    );
    const summary = discoverDescription({
      surfaces: [],
      discoverDetail: 'summary',
    });
    expect(summary).not.toBe(full);
    expect(summary).toContain('data.inspect');
    const otherTools = (options: DataSurfaceToolsOptions) =>
      createDataSurfaceTools(options)
        .filter((tool) => tool.slug !== DATA_DISCOVER_TOOL_SLUG)
        .map((tool) => JSON.stringify(tool.aiTool));
    expect(otherTools({ surfaces: [], discoverDetail: 'summary' })).toEqual(
      otherTools({ surfaces: [] }),
    );
  });

  it('returns only id, label, a one-line description, and the row-count hint', async () => {
    const result = await discover({
      surfaces: [
        surface({ id: 'b-hinted', rowCountHint: 1200 }),
        surface({
          id: 'a-unlabelled',
          label: undefined,
          description: undefined,
        }),
      ],
      discoverDetail: 'summary',
    });
    expect(result).toEqual([
      { id: 'a-unlabelled', label: 'a-unlabelled' },
      {
        id: 'b-hinted',
        label: 'Records 0',
        description: 'Bounded, tenant-safe rows for record set 0.',
        rowCountHint: 1200,
      },
    ]);
  });

  it('cuts the description at its first line and bounds it with an ellipsis', async () => {
    const long = `${'x'.repeat(150)} ${'y'.repeat(40)}`;
    const descriptions = [
      'First line.\r\nSecond line.',
      '  Padded first line  \nrest',
      long,
      `${'z'.repeat(160)}`,
      '\nleading blank line hides the rest',
      '   ',
    ];
    const result = await discover({
      surfaces: descriptions.map((description, index) =>
        surface({ id: `s${index}`, description }),
      ),
      discoverDetail: 'summary',
    });
    expect(
      (result as Array<{ description?: string }>).map(
        (entry) => entry.description,
      ),
    ).toEqual([
      'First line.',
      'Padded first line',
      `${long.slice(0, 159)}\u2026`,
      'z'.repeat(160),
      undefined,
      undefined,
    ]);
    const cut = (result as Array<{ description?: string }>)[2].description;
    expect(Array.from(cut ?? '').length).toBeLessThanOrEqual(160);
  });

  it.each([
    ['VT', 'One\vTwo'],
    ['FF', 'One\fTwo'],
    ['CR', 'One\rTwo'],
    ['NEL', 'One\u0085Two'],
    ['LINE SEPARATOR', 'One\u2028Two'],
    ['PARAGRAPH SEPARATOR', 'One\u2029Two'],
  ])('treats %s as a line break in the summary description', async (_name, description) => {
    const [entry] = (await discover({
      surfaces: [surface({ description })],
      discoverDetail: 'summary',
    })) as Array<{ description?: string }>;
    expect(entry.description).toBe('One');
  });

  it('strips bidi, zero-width, and other format characters from the summary line', async () => {
    const format = '\u202E\u2066\u200B\u200E\u200D\uFEFF\u00AD\u{E0041}\u2060';
    const [stripped, onlyFormat] = (await discover({
      surfaces: [
        surface({ id: 'a', description: `Sa${format}fe text${format}` }),
        surface({ id: 'b', description: `${format}\nhidden` }),
      ],
      discoverDetail: 'summary',
    })) as Array<{ description?: string }>;
    expect(stripped.description).toBe('Safe text');
    expect(onlyFormat).not.toHaveProperty('description');
  });

  it('cuts on code points, never splitting an astral character, and trims a cut on a space', async () => {
    const emojiAtCut = `${'a'.repeat(158)}\u{1F600}${'b'.repeat(10)}`;
    const spaceAtCut = `${'c'.repeat(157)}  ${'d'.repeat(10)}`;
    const [emoji, space] = (await discover({
      surfaces: [
        surface({ id: 'a', description: emojiAtCut }),
        surface({ id: 'b', description: spaceAtCut }),
      ],
      discoverDetail: 'summary',
    })) as Array<{ description: string }>;
    expect(emoji.description).toBe(`${'a'.repeat(158)}\u{1F600}\u2026`);
    expect(Array.from(emoji.description)).toHaveLength(160);
    expect(space.description).toBe(`${'c'.repeat(157)}\u2026`);
  });

  it('keeps a 34-surface summary a small fraction of the full catalog', async () => {
    const full = await discover({ surfaces: syntheticCatalog() });
    const summary = await discover({
      surfaces: syntheticCatalog(),
      discoverDetail: 'summary',
    });
    expect(summary).toHaveLength(34);
    expect(bytes(summary)).toBeLessThan(bytes(full) / 20);
    // Hard ceiling regardless of field count: id + label + 160-char line.
    expect(bytes(summary)).toBeLessThan(34 * 300);
  });

  it('still returns the full descriptor from data.inspect in summary mode', async () => {
    const catalog = syntheticCatalog();
    const full = await inspect({ surfaces: catalog }, 'surface-07');
    const summaryMode = await inspect(
      { surfaces: catalog, discoverDetail: 'summary' },
      'surface-07',
    );
    expect(summaryMode).toEqual(full);
    expect(summaryMode).toMatchObject({
      description: catalog[7].description,
      metadata: catalog[7].metadata,
      limits: { maxPageLimit: 100 },
    });
  });

  it('applies identical permission filtering and denials in both modes', async () => {
    const catalog = [
      ...syntheticCatalog(3),
      surface({ id: 'denied-collection', collection: 'payroll' }),
      // The identity field is sensitive: the surface is denied as a whole.
      surface({
        id: 'hidden-identity',
        schema: {
          ...syntheticSchema(9),
          fields: syntheticSchema(9).fields.map((field) =>
            field.id === 'id' ? { ...field, sensitive: true } : field,
          ),
        },
      }),
    ];
    const ids = (value: unknown) =>
      (value as Array<{ id: string }>).map((entry) => entry.id);
    for (const discoverDetail of ['full', 'summary'] as const) {
      const options = { surfaces: catalog, discoverDetail };
      expect(ids(await discover(options))).toEqual([
        'surface-00',
        'surface-01',
        'surface-02',
      ]);
      await expect(
        discover(options, fakeRun([DATA_INSPECT_TOOL_SLUG])),
      ).rejects.toThrow(`denied:${DATA_DISCOVER_TOOL_SLUG}`);
      await expect(inspect(options, 'denied-collection')).rejects.toMatchObject(
        { name: 'DataSurfaceDeniedError' },
      );
      expect(
        await discover(options, fakeRun(ALL_TOOLS, [], ['other'])),
      ).toEqual([]);
    }
  });

  it('writes the same audit entries and failure handling in both modes', async () => {
    const entries: Record<string, DataSurfaceAuditEntry[]> = {};
    const failures: Record<string, unknown[]> = {};
    for (const discoverDetail of ['full', 'summary'] as const) {
      entries[discoverDetail] = [];
      failures[discoverDetail] = [];
      const options: DataSurfaceToolsOptions = {
        surfaces: syntheticCatalog(2),
        discoverDetail,
        audit: (entry) => {
          entries[discoverDetail].push(entry);
        },
      };
      await discover(options);
      await inspect(options, 'surface-01');
      await expect(
        discover({
          discoverDetail,
          surfaces: () => {
            throw new Error('catalog backend detail');
          },
          onFailure: (entry) => {
            failures[discoverDetail].push(entry.action);
          },
        }),
      ).rejects.toMatchObject({ code: 'DATA_SURFACE_QUERY_FAILED' });
    }
    expect(entries.summary).toEqual(entries.full);
    expect(entries.summary).toEqual([
      { action: 'discover', userId: 'delegated-user', tenantId: 'tenant-a' },
      {
        action: 'inspect',
        surfaceId: 'surface-01',
        userId: 'delegated-user',
        tenantId: 'tenant-a',
      },
    ]);
    expect(failures.summary).toEqual(['discover']);
    expect(failures.summary).toEqual(failures.full);
  });

  it('validates rowCountHint and omits invalid values without failing discovery', async () => {
    const hints: unknown[] = [
      0,
      42,
      '  ~2k  ',
      '1k-10k',
      'a'.repeat(32),
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
      '',
      '   ',
      'a'.repeat(33),
      'line\nbreak',
      { min: 1 },
      true,
    ];
    const catalog = hints.map((hint, index) =>
      surface({
        id: `h${String(index).padStart(2, '0')}`,
        rowCountHint: hint as DataSurfaceDefinition['rowCountHint'],
      }),
    );
    const expected = [0, 42, '~2k', '1k-10k', 'a'.repeat(32)];
    for (const discoverDetail of ['full', 'summary'] as const) {
      const result = (await discover({
        surfaces: catalog,
        discoverDetail,
      })) as Array<{ id: string; rowCountHint?: unknown }>;
      expect(result).toHaveLength(hints.length);
      expect(result.map((entry) => entry.rowCountHint)).toEqual([
        ...expected,
        ...hints.slice(expected.length).map(() => undefined),
      ]);
      for (const entry of result.slice(expected.length)) {
        expect(Object.hasOwn(entry, 'rowCountHint')).toBe(false);
      }
    }
    expect(normalizeDataSurfaceRowCountHint(' 5k ')).toBe('5k');
    expect(normalizeDataSurfaceRowCountHint(-3)).toBeUndefined();
  });

  it.each([
    ['Cc (NUL)', '5k\u0000'],
    ['Cc (tab)', '5\tk'],
    ['Cf (RIGHT-TO-LEFT OVERRIDE)', '\u202E5k'],
    ['Cf (LEFT-TO-RIGHT ISOLATE)', '5k\u2066'],
    ['Cf (ZERO WIDTH SPACE)', '5\u200Bk'],
    ['Cf (LEFT-TO-RIGHT MARK)', '5k\u200E'],
    ['Cf (BOM at an edge trim() would drop)', '\uFEFF5k'],
    ['Cf (SOFT HYPHEN)', '5\u00ADk'],
    ['Cf (tag character)', '5k\u{E0041}'],
    ['Zl (LINE SEPARATOR at an edge)', '5k\u2028'],
    ['Zp (PARAGRAPH SEPARATOR)', '5\u2029k'],
    ['only invisible blanks', '\u3164\u2800\u00A0'],
    ['only an ideographic space', '\u3000'],
  ])('rejects a rowCountHint containing %s', (_name, hint) => {
    expect(normalizeDataSurfaceRowCountHint(hint)).toBeUndefined();
  });

  it('accepts visible non-ASCII labels', () => {
    expect(normalizeDataSurfaceRowCountHint('≈ 2 000')).toBe('≈ 2 000');
    expect(normalizeDataSurfaceRowCountHint('约2千')).toBe('约2千');
  });
});
