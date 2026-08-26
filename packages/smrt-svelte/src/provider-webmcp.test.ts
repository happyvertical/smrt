import type { WebMcpRegistrationDefinition } from '@happyvertical/smrt-web';
import { render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './internal/logger.js';

const { registerWebMcpTools } = vi.hoisted(() => ({
  registerWebMcpTools: vi.fn(),
}));

vi.mock('@happyvertical/smrt-web', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-web')>();
  return {
    ...actual,
    registerWebMcpTools: (
      ...args: Parameters<typeof actual.registerWebMcpTools>
    ) => {
      registerWebMcpTools(...args);
      return actual.registerWebMcpTools(...args);
    },
  };
});

import Harness from './__tests__/provider-webmcp-harness.svelte';

describe('Provider WebMCP policy', () => {
  beforeEach(() => {
    registerWebMcpTools.mockClear();
    document.modelContext = undefined;
  });

  it('passes the same exposure policy to the framework-agnostic registrar', async () => {
    const filter = vi.fn(() => true);
    const filterTool = vi.fn(() => true);
    const definitions = [];

    render(Harness, {
      props: {
        webmcp: {
          definitions,
          effects: ['read', 'write'],
          namespace: 'workspace',
          maxTools: 12,
          basePath: '/api/v2',
          scope: 'tenant-a',
          filter,
          filterTool,
        },
      },
    });

    await waitFor(() => expect(registerWebMcpTools).toHaveBeenCalledOnce());
    expect(registerWebMcpTools).toHaveBeenCalledWith(definitions, {
      client: undefined,
      basePath: '/api/v2',
      fetchFn: undefined,
      scope: 'tenant-a',
      filter,
      filterTool,
      effects: ['read', 'write'],
      namespace: 'workspace',
      maxTools: 12,
    });
  });

  it('registers the same real tool set as direct registration', async () => {
    const definitions: WebMcpRegistrationDefinition[] = [
      {
        name: 'reports',
        objectRef: '@test/smrt-svelte:Report',
        className: 'Report',
        endpoint: '/reports',
        idField: 'id',
        actions: ['list', 'create'],
        fields: {},
        toolDescriptors: [
          {
            action: 'list',
            name: 'report_list',
            description: 'List reports',
            inputSchema: { type: 'object' },
            readOnly: true,
            effect: 'read',
            idempotent: true,
            openWorld: false,
          },
          {
            action: 'create',
            name: 'report_create',
            description: 'Create a report',
            inputSchema: { type: 'object' },
            readOnly: false,
            effect: 'write',
            idempotent: false,
            openWorld: false,
          },
        ],
      },
      {
        collection: 'audits',
        objectRef: '@test/smrt-svelte:Audit',
        className: 'Audit',
        endpoint: '/audits',
        idField: 'id',
        idType: 'uuid',
        relationships: [],
        action: 'get',
        name: 'audit_get',
        description: 'Get an audit record',
        inputSchema: { type: 'object' },
        readOnly: true,
        effect: 'read',
        idempotent: true,
        openWorld: false,
        route: { method: 'GET', scope: 'item', path: [] },
      },
    ];
    const policy = {
      definitions,
      effects: ['read', 'write'] as const,
      namespace: 'workspace',
      maxTools: 4,
      filterTool: (
        tool: Extract<WebMcpRegistrationDefinition, { collection: string }>,
      ) => tool.collection === 'audits',
    };
    const captured: Array<{ name: string; annotations?: unknown }> = [];
    const installRegistry = () => {
      captured.length = 0;
      document.modelContext = {
        registerTool(tool) {
          captured.push({ name: tool.name, annotations: tool.annotations });
        },
      };
    };

    installRegistry();
    const { registerWebMcpTools: directRegister } = await vi.importActual<
      typeof import('@happyvertical/smrt-web')
    >('@happyvertical/smrt-web');
    directRegister(definitions, policy);
    const direct = structuredClone(captured);

    installRegistry();
    render(Harness, { props: { webmcp: policy } });
    await waitFor(() => expect(registerWebMcpTools).toHaveBeenCalledOnce());

    expect(captured).toEqual(direct);
    expect(captured.map((tool) => tool.name)).toEqual([
      'workspace_report_list',
      'workspace_report_create',
      'workspace_audit_get',
    ]);
  });

  it('defaults generated data tools to read-only exposure', async () => {
    const captured: string[] = [];
    document.modelContext = {
      registerTool(tool) {
        captured.push(tool.name);
      },
    };
    const definitions: WebMcpRegistrationDefinition[] = [
      {
        name: 'reports',
        objectRef: '@test/smrt-svelte:Report',
        className: 'Report',
        endpoint: '/reports',
        idField: 'id',
        actions: ['list', 'create'],
        fields: {},
        toolDescriptors: [
          {
            action: 'list',
            name: 'report_list',
            description: 'List reports',
            inputSchema: { type: 'object' },
            readOnly: true,
            effect: 'read',
            idempotent: true,
            openWorld: false,
          },
          {
            action: 'create',
            name: 'report_create',
            description: 'Create a report',
            inputSchema: { type: 'object' },
            readOnly: false,
            effect: 'write',
            idempotent: false,
            openWorld: false,
          },
        ],
      },
    ];

    render(Harness, { props: { webmcp: { definitions } } });
    await waitFor(() => expect(registerWebMcpTools).toHaveBeenCalledOnce());

    expect(captured).toEqual(['report_list']);
  });

  it('reports rejected generated data-tool policies without an unhandled rejection', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    document.modelContext = { registerTool: vi.fn() };

    render(Harness, {
      props: { webmcp: { definitions: [], maxTools: -1 } },
    });

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Provider: WebMCP data tool registration rejected',
        {
          error: expect.objectContaining({
            message: 'WebMCP maxTools must be a non-negative safe integer',
          }),
        },
      ),
    );
  });
});
