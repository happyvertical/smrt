import { describe, expect, it } from 'vitest';
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
