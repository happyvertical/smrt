import { describe, expect, it } from 'vitest';
import { generateRuntimeBootstrap } from './mcp-runtime-template.js';

describe('generated MCP custom-action runtime (#2182)', () => {
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
    expect(source).toContain(
      "actionMeta.scope === 'item' && parameterName === 'id'",
    );
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
});
