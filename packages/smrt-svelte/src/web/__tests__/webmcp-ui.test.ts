import {
  createDataSurfaceRegistry,
  type DataSurfaceDescriptor,
  type DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-ui/data';
import { createControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import { describe, expect, it, vi } from 'vitest';
import type { WebMcpToolSpec } from '../webmcp.svelte.js';
import { registerWebMcpUiTools } from '../webmcp-ui.js';

function modelContext() {
  const registered: WebMcpToolSpec[] = [];
  const signals: AbortSignal[] = [];
  const document = {
    modelContext: {
      registerTool(tool: WebMcpToolSpec, options?: { signal?: AbortSignal }) {
        registered.push(tool);
        if (options?.signal) signals.push(options.signal);
      },
    },
  };
  return { document, registered, signals };
}

function parse(value: string | Promise<string>) {
  return Promise.resolve(value).then((result) => JSON.parse(result));
}

function findTool(tools: WebMcpToolSpec[], name: string): WebMcpToolSpec {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function descriptor(): DataSurfaceDescriptor {
  return {
    version: 1,
    identity: { surfaceId: 'content', kind: 'table' },
    schemaVersion: 1,
    label: 'Content',
    rowKey: 'id',
    columns: [
      {
        id: 'id',
        label: 'ID',
        capabilities: ['read', 'project'],
      },
      {
        id: 'internal',
        label: 'Internal',
        visibility: 'hidden',
        capabilities: ['read', 'project'],
      },
    ],
    query: {
      modes: ['rows'],
      projectableColumnIds: ['id', 'internal'],
    },
    controls: [{ id: 'next-page', label: 'Next page' }],
    actions: [],
    limits: { maxQueryRows: 50, maxQueryBytes: 10_000, maxSelectionSize: 10 },
  };
}

describe('registerWebMcpUiTools', () => {
  it('registers one fixed tool set and resolves mounted controls dynamically', async () => {
    const browser = modelContext();
    const controls = createControlInteractionRegistry();
    const surfaces = createDataSurfaceRegistry();
    const dispose = registerWebMcpUiTools({
      controlRegistry: controls,
      dataSurfaceRegistry: surfaces,
      document: browser.document,
    });

    expect(browser.registered.map((tool) => tool.name)).toEqual([
      'smrt_ui_list_form_controls',
      'smrt_ui_inspect_form_control',
      'smrt_ui_execute_form_control',
      'smrt_ui_list_data_surfaces',
      'smrt_ui_inspect_data_surface',
      'smrt_ui_execute_data_surface_control',
    ]);
    expect(browser.registered).toHaveLength(6);

    const list = findTool(browser.registered, 'smrt_ui_list_form_controls');
    expect(await parse(list.execute({}))).toEqual({ ok: true, result: [] });

    let value = 'Ada';
    const unregister = controls.register({
      identity: { formId: 'profile', controlId: 'name' },
      metadata: { kind: 'text', label: 'Name' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
      focus: vi.fn(),
    });
    expect((await parse(list.execute({}))).result).toHaveLength(1);
    expect(browser.registered).toHaveLength(6);

    unregister();
    expect(await parse(list.execute({}))).toEqual({ ok: true, result: [] });
    dispose();
    expect(browser.signals).toHaveLength(6);
    expect(browser.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('uses agent consent semantics and cannot be tricked into confirmation', async () => {
    const browser = modelContext();
    const controls = createControlInteractionRegistry();
    let value = 'Ada';
    controls.register({
      identity: { formId: 'profile', controlId: 'name' },
      metadata: { kind: 'text', label: 'Name' },
      getValue: () => value,
      setValue: (next) => {
        value = String(next);
      },
    });
    registerWebMcpUiTools({
      controlRegistry: controls,
      dataSurfaceRegistry: createDataSurfaceRegistry(),
      document: browser.document,
    });
    const execute = findTool(
      browser.registered,
      'smrt_ui_execute_form_control',
    );
    const identity = { formId: 'profile', controlId: 'name' };

    expect(
      (
        await parse(
          execute.execute({ action: 'stage', identity, value: 'Grace' }),
        )
      ).result,
    ).toMatchObject({ ok: true, action: 'stage' });
    expect(value).toBe('Ada');
    expect(
      (await parse(execute.execute({ action: 'apply', identity }))).result,
    ).toMatchObject({ ok: false, reason: 'consent_required' });
    expect(value).toBe('Ada');

    expect(
      await parse(
        execute.execute({
          action: 'apply',
          identity,
          confirmed: true,
        }),
      ),
    ).toEqual({ ok: false, reason: 'invalid_request', details: 'confirmed' });
    expect(value).toBe('Ada');
  });

  it('keeps secret values redacted from list and inspect responses', async () => {
    const browser = modelContext();
    const controls = createControlInteractionRegistry();
    controls.register({
      identity: { formId: 'account', controlId: 'password' },
      metadata: {
        kind: 'password',
        label: 'Password',
        sensitivity: 'secret',
      },
      getValue: () => 'never-serialize-this',
      setValue: () => {},
    });
    registerWebMcpUiTools({
      controlRegistry: controls,
      dataSurfaceRegistry: createDataSurfaceRegistry(),
      document: browser.document,
    });
    const list = findTool(browser.registered, 'smrt_ui_list_form_controls');
    const inspect = findTool(
      browser.registered,
      'smrt_ui_inspect_form_control',
    );
    const listed = await parse(list.execute({ formId: 'account' }));
    const inspected = await parse(
      inspect.execute({
        identity: { formId: 'account', controlId: 'password' },
      }),
    );
    expect(JSON.stringify([listed, inspected])).not.toContain(
      'never-serialize-this',
    );
    expect(listed.result[0].state.valueRedacted).toBe(true);
    expect(inspected.result.state.valueRedacted).toBe(true);
  });

  it('filters hidden columns and preserves surface revision and replay failures', async () => {
    const browser = modelContext();
    const surfaces = createDataSurfaceRegistry();
    let revision = 2;
    let page = 1;
    surfaces.register({
      descriptor: descriptor(),
      getSnapshot: () => ({ revision, state: { page } }),
      execute: (_command: DataSurfaceVisibleCommand) => {
        page += 1;
        revision += 1;
      },
    });
    registerWebMcpUiTools({
      controlRegistry: createControlInteractionRegistry(),
      dataSurfaceRegistry: surfaces,
      document: browser.document,
    });
    const list = findTool(browser.registered, 'smrt_ui_list_data_surfaces');
    const inspect = findTool(
      browser.registered,
      'smrt_ui_inspect_data_surface',
    );
    const execute = findTool(
      browser.registered,
      'smrt_ui_execute_data_surface_control',
    );
    const identity = { surfaceId: 'content', kind: 'table' };

    expect((await parse(list.execute({}))).result[0].columns).toHaveLength(1);
    const snapshot = (await parse(inspect.execute({ identity }))).result;
    expect(snapshot.descriptor.query.projectableColumnIds).toEqual(['id']);

    const command = {
      version: 1,
      commandId: 'page-1',
      identity,
      expectedRevision: 2,
      controlId: 'next-page',
    };
    expect((await parse(execute.execute(command))).result).toMatchObject({
      ok: true,
      revision: 3,
    });
    expect((await parse(execute.execute(command))).result).toMatchObject({
      ok: true,
      revision: 3,
    });
    expect(
      (
        await parse(
          execute.execute({ ...command, controlId: 'different-control' }),
        )
      ).result,
    ).toMatchObject({ ok: false, reason: 'idempotency_conflict' });
    expect(
      (await parse(execute.execute({ ...command, commandId: 'page-2' })))
        .result,
    ).toMatchObject({ ok: false, reason: 'stale_revision' });
  });

  it('rejects invalid and oversized requests with distinct failures', async () => {
    const browser = modelContext();
    const controls = createControlInteractionRegistry();
    registerWebMcpUiTools({
      controlRegistry: controls,
      dataSurfaceRegistry: createDataSurfaceRegistry(),
      document: browser.document,
    });
    const inspect = findTool(
      browser.registered,
      'smrt_ui_inspect_form_control',
    );
    expect(
      await parse(
        inspect.execute({ identity: { formId: '', controlId: 'name' } }),
      ),
    ).toEqual({
      ok: false,
      reason: 'invalid_identifier',
      details: 'formId',
    });
    expect(
      await parse(inspect.execute({ payload: 'x'.repeat(100_001) })),
    ).toEqual({ ok: false, reason: 'limit_exceeded' });

    controls.register({
      identity: { formId: 'broken', controlId: 'value' },
      metadata: { kind: 'text' },
      getValue: () => {
        throw new Error('private host detail');
      },
    });
    const list = findTool(browser.registered, 'smrt_ui_list_form_controls');
    const failed = await parse(list.execute({ formId: 'broken' }));
    expect(failed).toEqual({ ok: false, reason: 'execution_failed' });
    expect(JSON.stringify(failed)).not.toContain('private host detail');
  });

  it('locks a prefix atomically, permits distinct prefixes, and no-ops without WebMCP', () => {
    const browser = modelContext();
    const registries = {
      controlRegistry: createControlInteractionRegistry(),
      dataSurfaceRegistry: createDataSurfaceRegistry(),
    };
    const dispose = registerWebMcpUiTools({
      ...registries,
      document: browser.document,
    });
    expect(() =>
      registerWebMcpUiTools({ ...registries, document: browser.document }),
    ).toThrow('already registered');
    expect(browser.registered).toHaveLength(6);

    const disposeOther = registerWebMcpUiTools({
      ...registries,
      prefix: 'other_',
      document: browser.document,
    });
    expect(browser.registered).toHaveLength(12);
    disposeOther();
    dispose();

    expect(() =>
      registerWebMcpUiTools({
        ...registries,
        document: {},
      }),
    ).not.toThrow();
  });

  it('aborts every partial registration and releases the lock when a host rejects a tool', () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const document = {
      modelContext: {
        registerTool(
          _tool: WebMcpToolSpec,
          options?: { signal?: AbortSignal },
        ) {
          calls += 1;
          if (options?.signal) signals.push(options.signal);
          if (calls === 3) throw new Error('host collision');
        },
      },
    };
    const registries = {
      controlRegistry: createControlInteractionRegistry(),
      dataSurfaceRegistry: createDataSurfaceRegistry(),
    };

    expect(() => registerWebMcpUiTools({ ...registries, document })).toThrow(
      'host collision',
    );
    expect(signals.every((signal) => signal.aborted)).toBe(true);

    calls = 0;
    document.modelContext.registerTool = (
      _tool: WebMcpToolSpec,
      options?: { signal?: AbortSignal },
    ) => {
      calls += 1;
      if (options?.signal) signals.push(options.signal);
    };
    expect(() =>
      registerWebMcpUiTools({ ...registries, document }),
    ).not.toThrow();
    expect(calls).toBe(6);
  });
});
