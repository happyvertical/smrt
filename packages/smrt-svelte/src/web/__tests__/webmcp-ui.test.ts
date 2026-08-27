import {
  createDataSurfaceRegistry,
  type DataSurfaceDescriptor,
  type DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-ui/data';
import {
  type ControlInteractionRegistry,
  type ControlSnapshot,
  createControlInteractionRegistry,
} from '@happyvertical/smrt-ui/forms';
import { describe, expect, it, vi } from 'vitest';
import type { WebMcpToolSpec } from '../webmcp.svelte.js';
import { registerWebMcpUiTools } from '../webmcp-ui.js';

function modelContext() {
  const registered: WebMcpToolSpec[] = [];
  const signals: AbortSignal[] = [];
  const document = {
    modelContext: {
      async registerTool(
        tool: WebMcpToolSpec,
        options?: { signal?: AbortSignal },
      ) {
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
    ).toMatchObject({ ok: false, reason: 'human_confirmation_required' });
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

  it('keeps secret values redacted from list, inspect, and execute responses', async () => {
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
      getState: () => ({
        valid: false,
        validationMessage: 'never-serialize-this is invalid',
      }),
      focus: () => {
        throw new Error('never-serialize-this cannot be focused');
      },
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
    const execute = findTool(
      browser.registered,
      'smrt_ui_execute_form_control',
    );
    const listed = await parse(list.execute({ formId: 'account' }));
    const inspected = await parse(
      inspect.execute({
        identity: { formId: 'account', controlId: 'password' },
      }),
    );
    const executed = await parse(
      execute.execute({
        action: 'focus',
        identity: { formId: 'account', controlId: 'password' },
      }),
    );
    expect(JSON.stringify([listed, inspected, executed])).not.toContain(
      'never-serialize-this',
    );
    expect(listed.result[0].state.valueRedacted).toBe(true);
    expect(inspected.result.state.valueRedacted).toBe(true);
    expect(executed.result.snapshot.state.valueRedacted).toBe(true);
    expect(executed.result.snapshot.state).not.toHaveProperty(
      'validationMessage',
    );
    expect(executed.result.reason).toBe('execution_failed');
  });

  it('does not expose host error messages that mimic public failures', async () => {
    const browser = modelContext();
    const controls = createControlInteractionRegistry();
    controls.register({
      identity: { formId: 'profile', controlId: 'unstable' },
      metadata: { kind: 'text', label: 'Unstable' },
      getValue: () => {
        throw new Error('not_found: private customer 4711');
      },
    });
    registerWebMcpUiTools({
      controlRegistry: controls,
      dataSurfaceRegistry: createDataSurfaceRegistry(),
      document: browser.document,
    });
    const inspect = findTool(
      browser.registered,
      'smrt_ui_inspect_form_control',
    );

    const result = await parse(
      inspect.execute({
        identity: { formId: 'profile', controlId: 'unstable' },
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'execution_failed' });
    expect(JSON.stringify(result)).not.toContain('customer 4711');
  });

  it('redacts sensitive injected snapshots and result text despite inconsistent flags', async () => {
    for (const sensitivity of ['secret', 'sensitive'] as const) {
      const marker = `injected-${sensitivity}-value`;
      const browser = modelContext();
      const snapshot = {
        identity: { formId: 'injected', controlId: sensitivity },
        metadata: {
          kind: 'password',
          sensitivity,
          capabilities: ['discard'],
        },
        state: {
          value: marker,
          valueRedacted: false,
          stagedValue: `${marker}-staged`,
          stagedValueRedacted: false,
          validationMessage: `${marker} validation`,
          staged: {
            value: `${marker}-nested`,
            valueRedacted: false,
            provenance: { source: 'agent' as const },
            stagedAt: 1,
            revision: 1,
            stale: false,
            validationMessage: `${marker} nested validation`,
          },
        },
      } satisfies ControlSnapshot;
      const controls: ControlInteractionRegistry = {
        register: () => () => {},
        unregister: () => {},
        list: () => [snapshot],
        get: () => snapshot,
        execute: async (command) => ({
          ok: false,
          action: command.action,
          identity: command.identity,
          reason: `${marker} reason`,
          validationMessage: `${marker} result validation`,
          snapshot,
        }),
        subscribe: () => () => {},
      };
      registerWebMcpUiTools({
        controlRegistry: controls,
        dataSurfaceRegistry: createDataSurfaceRegistry(),
        document: browser.document,
      });

      const identity = { formId: 'injected', controlId: sensitivity };
      const list = await parse(
        findTool(browser.registered, 'smrt_ui_list_form_controls').execute({}),
      );
      const inspect = await parse(
        findTool(browser.registered, 'smrt_ui_inspect_form_control').execute({
          identity,
        }),
      );
      const executed = await parse(
        findTool(browser.registered, 'smrt_ui_execute_form_control').execute({
          action: 'focus',
          identity,
        }),
      );

      expect(JSON.stringify([list, inspect, executed])).not.toContain(marker);
      for (const result of [
        list.result[0],
        inspect.result,
        executed.result.snapshot,
      ]) {
        expect(result.metadata.capabilities).toEqual(['discard']);
        expect(result.state).toMatchObject({
          valueRedacted: true,
          stagedValueRedacted: true,
          staged: {
            valueRedacted: true,
          },
        });
        expect(result.state).not.toHaveProperty('value');
        expect(result.state).not.toHaveProperty('stagedValue');
        expect(result.state).not.toHaveProperty('validationMessage');
        expect(result.state.staged).not.toHaveProperty('value');
        expect(result.state.staged).not.toHaveProperty('validationMessage');
      }
      expect(executed.result.reason).toBe('execution_failed');
      expect(executed.result).not.toHaveProperty('validationMessage');
    }
  });

  it('filters hidden columns and preserves surface revision and replay failures', async () => {
    const browser = modelContext();
    const surfaces = createDataSurfaceRegistry();
    let revision = 2;
    let page = 1;
    surfaces.register({
      descriptor: descriptor(),
      getSnapshot: () => ({
        revision,
        state: {
          page,
          internal: 'never-serialize-this',
          table: {
            version: 3,
            state: {
              filters: [
                { columnId: 'internal', value: 'nested-hidden-filter' },
                { columnId: 'id', value: ['internal'] },
              ],
              sorting: [{ columnId: 'internal', direction: 'asc' }],
              columnOrder: ['id', 'internal'],
            },
          },
        },
      }),
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
    expect(snapshot.state).not.toHaveProperty('internal');
    expect(JSON.stringify(snapshot)).not.toContain('nested-hidden-filter');
    expect(snapshot.state.table.state.columnOrder).toEqual(['id']);
    expect(snapshot.state.table.state.filters).toEqual([
      { columnId: 'id', value: ['internal'] },
    ]);

    const hiddenRowKeyDescriptor = descriptor();
    hiddenRowKeyDescriptor.rowKey = 'internal';
    const hiddenRowKeySurfaces = createDataSurfaceRegistry();
    hiddenRowKeySurfaces.register({
      descriptor: hiddenRowKeyDescriptor,
      getSnapshot: () => ({
        revision: 0,
        state: {
          table: {
            state: {
              selection: {
                scope: 'explicit',
                rowIds: ['nested-private-row-id'],
              },
              selectedRowIds: ['nested-private-row-id'],
              expandedRowIds: ['nested-private-row-id'],
            },
          },
        },
        selection: { scope: 'explicit-ids', rowIds: ['private-row-id'] },
      }),
    });
    const hiddenRowKeyBrowser = modelContext();
    registerWebMcpUiTools({
      controlRegistry: createControlInteractionRegistry(),
      dataSurfaceRegistry: hiddenRowKeySurfaces,
      document: hiddenRowKeyBrowser.document,
    });
    const hiddenRowKeyList = await parse(
      findTool(
        hiddenRowKeyBrowser.registered,
        'smrt_ui_list_data_surfaces',
      ).execute({}),
    );
    expect(hiddenRowKeyList.result[0]).not.toHaveProperty('rowKey');
    const hiddenRowKeyInspect = await parse(
      findTool(
        hiddenRowKeyBrowser.registered,
        'smrt_ui_inspect_data_surface',
      ).execute({ identity }),
    );
    expect(hiddenRowKeyInspect.result.selection).toBeNull();
    expect(JSON.stringify(hiddenRowKeyInspect)).not.toContain('private-row-id');
    expect(JSON.stringify(hiddenRowKeyInspect)).not.toContain(
      'nested-private-row-id',
    );

    const command = {
      version: 1,
      commandId: 'page-1',
      identity,
      expectedRevision: 2,
      controlId: 'next-page',
    };
    const completed = (await parse(execute.execute(command))).result;
    expect(completed).toMatchObject({
      ok: true,
      revision: 3,
    });
    expect(completed.snapshot.descriptor.columns).toHaveLength(1);
    expect(completed.snapshot.state).not.toHaveProperty('internal');
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
    const stale = (
      await parse(execute.execute({ ...command, commandId: 'page-2' }))
    ).result;
    expect(stale).toMatchObject({ ok: false, reason: 'stale_revision' });
    expect(stale.snapshot.descriptor.columns).toHaveLength(1);
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

  it('observes asynchronous host rejection, aborts tools, and releases only its own lock', async () => {
    let rejectFirstRegistration: ((reason?: unknown) => void) | undefined;
    const signals: AbortSignal[] = [];
    let calls = 0;
    const document = {
      modelContext: {
        registerTool(
          _tool: WebMcpToolSpec,
          options?: { signal?: AbortSignal },
        ): void | PromiseLike<void> {
          calls += 1;
          if (options?.signal) signals.push(options.signal);
          if (calls === 1) {
            return new Promise<void>((_resolve, reject) => {
              rejectFirstRegistration = reject;
            });
          }
        },
      },
    };
    const registries = {
      controlRegistry: createControlInteractionRegistry(),
      dataSurfaceRegistry: createDataSurfaceRegistry(),
    };

    const disposeFirst = registerWebMcpUiTools({ ...registries, document });
    disposeFirst();
    const disposeReplacement = registerWebMcpUiTools({
      ...registries,
      document,
    });

    rejectFirstRegistration?.(new Error('late host collision'));
    await Promise.resolve();
    await Promise.resolve();
    expect(signals.slice(0, 6).every((signal) => signal.aborted)).toBe(true);
    expect(signals.slice(6).every((signal) => !signal.aborted)).toBe(true);
    expect(() => registerWebMcpUiTools({ ...registries, document })).toThrow(
      'already registered',
    );

    disposeReplacement();
    expect(() =>
      registerWebMcpUiTools({ ...registries, document }),
    ).not.toThrow();
  });

  it('releases an active prefix when asynchronous host registration fails', async () => {
    const signals: AbortSignal[] = [];
    let rejectRegistration: ((reason?: unknown) => void) | undefined;
    const document = {
      modelContext: {
        registerTool(
          _tool: WebMcpToolSpec,
          options?: { signal?: AbortSignal },
        ): void | PromiseLike<void> {
          if (options?.signal) signals.push(options.signal);
          if (!rejectRegistration) {
            return new Promise<void>((_resolve, reject) => {
              rejectRegistration = reject;
            });
          }
        },
      },
    };
    const registries = {
      controlRegistry: createControlInteractionRegistry(),
      dataSurfaceRegistry: createDataSurfaceRegistry(),
    };

    registerWebMcpUiTools({ ...registries, document });
    rejectRegistration?.(new Error('host collision'));
    await Promise.resolve();
    await Promise.resolve();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(() =>
      registerWebMcpUiTools({ ...registries, document }),
    ).not.toThrow();
  });
});
