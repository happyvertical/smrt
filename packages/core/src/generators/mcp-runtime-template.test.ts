import { describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import {
  MCP_STABLE_CATALOG_TTL_MS,
  MCPGenerator,
  resolveMCPToolListCacheHint,
  sortMCPTools,
} from './mcp.js';
import { generateRuntimeBootstrap } from './mcp-runtime-template.js';

describe('generated MCP custom-action runtime (#2182)', () => {
  it('emits the SDK v2 stateless lifecycle', () => {
    const source = generateRuntimeBootstrap({ tools: [], customActions: {} });

    expect(source).toContain("from '@modelcontextprotocol/server'");
    expect(source).toContain("from '@modelcontextprotocol/server/stdio'");
    expect(source).toContain("setRequestHandler('tools/list'");
    expect(source).toContain("setRequestHandler('tools/call'");
    expect(source).toContain('serveStdio(() => createServer()');
    expect(source).toContain('await loadConfig()');
    expect(source).toContain('structuredContent');
    expect(source).toContain('function successResult');
    expect(source).toContain('function errorResult');
    expect(source).toContain('function resolveCreateTarget');
    expect(source).toContain('ObjectRegistry.loadAllManifests');
    expect(source).not.toContain('@modelcontextprotocol/sdk');
    expect(source).not.toContain('initialize');
  });

  it('emits a private cacheable, byte-stable tool catalog by default', () => {
    const source = generateRuntimeBootstrap({
      tools: [
        { name: 'zebra_list', description: 'Zebra', inputSchema: {} },
        { name: 'antelope_list', description: 'Antelope', inputSchema: {} },
      ],
    });

    expect(source).toContain(
      "cacheHints: {\n          'tools/list': TOOL_LIST_CACHE_HINT,",
    );
    expect(source).toContain(
      'const TOOL_LIST_CACHE_HINT = {"ttlMs":86400000,"cacheScope":"private"};',
    );
    expect(source).toContain(
      'tools: [...TOOLS].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)',
    );
  });

  it('requires an explicit global-catalog opt-in and never shares tenant catalogs', () => {
    expect(resolveMCPToolListCacheHint(undefined, false)).toEqual({
      ttlMs: MCP_STABLE_CATALOG_TTL_MS,
      cacheScope: 'private',
    });
    expect(
      resolveMCPToolListCacheHint({ cacheScope: 'public' }, false),
    ).toMatchObject({ cacheScope: 'private' });
    expect(
      resolveMCPToolListCacheHint(
        { cacheScope: 'public', publicCatalog: true },
        false,
      ),
    ).toMatchObject({ cacheScope: 'public' });
    expect(
      resolveMCPToolListCacheHint(
        { cacheScope: 'public', publicCatalog: true },
        true,
      ),
    ).toMatchObject({ cacheScope: 'private' });
  });

  it('treats registry-declared tenant tools as private even without the tenancy runtime', async () => {
    const allClasses = vi
      .spyOn(ObjectRegistry, 'getAllClasses')
      .mockReturnValue(
        new Map([
          ['TenantCacheDocument', { name: 'TenantCacheDocument' }],
        ]) as ReturnType<typeof ObjectRegistry.getAllClasses>,
      );
    const isTenantScoped = vi
      .spyOn(ObjectRegistry, 'isTenantScoped')
      .mockReturnValue(true);
    const generator = new MCPGenerator();
    const detector = generator as unknown as {
      hasTenantScopedTools(tools: Array<{ name: string }>): Promise<boolean>;
    };

    try {
      await expect(
        detector.hasTenantScopedTools([{ name: 'tenantcachedocument_list' }]),
      ).resolves.toBe(true);
    } finally {
      allClasses.mockRestore();
      isTenantScoped.mockRestore();
    }
  });

  it('sorts a copied tool catalog independently of discovery order', () => {
    const source = [
      { name: 'zebra_list' },
      { name: 'antelope_list' },
      { name: 'marmoset_list' },
      { name: 'i_list' },
      { name: 'I_list' },
    ];

    expect(sortMCPTools(source).map((tool) => tool.name)).toEqual([
      'I_list',
      'antelope_list',
      'i_list',
      'marmoset_list',
      'zebra_list',
    ]);
    expect(source.map((tool) => tool.name)).toEqual([
      'zebra_list',
      'antelope_list',
      'marmoset_list',
      'i_list',
      'I_list',
    ]);
  });

  it('carries canonical receivers and positional invocation metadata without exposing it as a tool field', () => {
    const source = generateRuntimeBootstrap({
      tools: [
        {
          name: 'document_apply',
          description: 'Apply an item action',
          inputSchema: { type: 'object' },
        },
        {
          name: 'document_rebalance',
          description: 'Rebalance a collection action',
          inputSchema: { type: 'object' },
        },
        {
          name: 'document_restoreintocontent',
          description: 'Restore a camelCase item action',
          inputSchema: { type: 'object' },
        },
      ],
      customActions: {
        document_apply: {
          scope: 'item',
          isStatic: false,
          methodName: 'apply',
          parameterNames: ['idempotencyKey', 'expectedVersion'],
          legacyOptions: false,
        },
        document_rebalance: {
          scope: 'collection',
          isStatic: true,
          methodName: 'rebalance',
          parameterNames: ['idempotencyKey', 'expectedVersion'],
          legacyOptions: false,
        },
        document_configure: {
          scope: 'item',
          isStatic: false,
          methodName: 'configure',
          parameterNames: ['options'],
          optionsParameter: true,
          legacyOptions: false,
        },
        document_restoreintocontent: {
          scope: 'item',
          isStatic: false,
          methodName: 'restoreIntoContent',
          parameterNames: ['idempotencyKey'],
          legacyOptions: false,
        },
      },
    });

    expect(source).toContain('const CUSTOM_ACTIONS = {"document_apply"');
    expect(source).toContain("actionMeta.scope === 'item' && !id");
    expect(source).toContain("actionMeta.scope === 'collection' && id");
    expect(source).toContain(
      "? ObjectRegistry.getClass('Document')?.constructor",
    );
    expect(source).toContain("parameterName === 'id'");
    expect(source).toContain("? 'actionId'");
    expect(source).toMatch(/actionMeta\.optionsParameter\s+\? \[options\]/);
    expect(source).toContain('actionMethod.call(target, ...methodArgs)');
    expect(source).toContain("target[actionMeta.methodName || 'apply']");
    expect(source).toContain(
      "target[actionMeta.methodName || 'restoreintocontent']",
    );
    expect(source).toContain('"methodName":"restoreIntoContent"');
    expect(source).toContain('normalizeCustomActionFailure(result)');
    expect(source).toContain('isError: true');
    expect(source).not.toContain('customActions:');
  });

  it('resolves STI create discriminators before applying write policy', () => {
    const source = generateRuntimeBootstrap({
      tools: [
        {
          name: 'animal_create',
          description: 'Create an animal',
          inputSchema: { type: 'object' },
        },
      ],
      stiTargets: {
        animal: { '@test/animals:Cat': '@test/animals:Cat' },
      },
    });

    expect(source).toContain("resolveCreateTarget('animal', args, aiConfig)");
    expect(source).toContain('const STI_TARGETS');
    expect(source).toContain('"@test/animals:Cat":"@test/animals:Cat"');
    expect(source).toContain('applyWritablePolicy(targetObjectName, args)');
  });
});
