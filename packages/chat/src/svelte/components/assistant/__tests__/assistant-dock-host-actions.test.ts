// @vitest-environment jsdom
/**
 * #2989: a host can propose an action into the dock and observe an applied
 * outcome — controller `onActionApplied`, and AssistantDock's
 * `oncontroller` / `onactionapplied` props.
 */
import {
  createDataSurfaceRegistry,
  type DataSurfaceActionRequest,
  type DataSurfaceActionResult,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';
import {
  type AssistantActionClient,
  type AssistantDockController,
  createAssistantDockController,
} from '../create-assistant-dock-controller.svelte.js';

const identity: DataSurfaceIdentity = {
  surfaceId: 'assets',
  kind: 'table',
  subject: { type: 'tenant', id: 'tenant-a' },
};

function registryWithSurface() {
  const registry = createDataSurfaceRegistry();
  const descriptor: DataSurfaceDescriptor = {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Assets',
    rowKey: 'id',
    columns: [
      { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
    ],
    query: {
      modes: ['rows'],
      projectableColumnIds: ['id'],
      searchableColumnIds: [],
      filterableColumnIds: [],
      sortableColumnIds: [],
    },
    actions: [],
    controls: [],
    limits: { maxQueryRows: 10, maxQueryBytes: 10_000, maxSelectionSize: 10 },
  };
  registry.register({
    descriptor,
    getSnapshot: () => ({ revision: 1, state: {} }),
  });
  return registry;
}

function proposal(requestId = 'req-approve'): DataSurfaceActionRequest {
  return {
    version: 1,
    requestId,
    identity,
    actionId: 'approve',
    phase: 'preview',
    selection: { scope: 'explicit-ids', rowIds: ['row-sent'] },
  };
}

function result(
  request: DataSurfaceActionRequest,
  phase: 'preview' | 'apply',
  ok: boolean,
  extra: Partial<DataSurfaceActionResult> = {},
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: request.requestId,
    identity: request.identity,
    actionId: request.actionId,
    phase,
    ok,
    ...extra,
  };
}

function client(apply: AssistantActionClient['apply']): AssistantActionClient {
  return {
    preview: async (request) =>
      result(request, 'preview', true, { confirmationToken: 'tok' }),
    apply,
  };
}

describe('controller onActionApplied (#2989)', () => {
  it('fires once with the server result for an accepted apply', async () => {
    const onActionApplied = vi.fn();
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: registryWithSurface(),
      actionClient: client(async (request) =>
        result(request, 'apply', true, {
          details: { approvedAssetId: 'asset-from-server' },
        }),
      ),
      onActionApplied,
    });
    await controller.previewAction(proposal());
    await controller.applyAction('req-approve');

    expect(controller.actions.get('req-approve')?.status).toBe('applied');
    expect(onActionApplied).toHaveBeenCalledTimes(1);
    const [request, applied] = onActionApplied.mock.calls[0];
    expect(request.phase).toBe('apply');
    expect(request.requestId).toBe('req-approve');
    expect(applied.details).toEqual({ approvedAssetId: 'asset-from-server' });
    controller.dispose();
  });

  it('does not fire for a refusal or a thrown apply', async () => {
    const onActionApplied = vi.fn();
    let mode: 'refuse' | 'throw' = 'refuse';
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: registryWithSurface(),
      actionClient: client(async (request) => {
        if (mode === 'throw') throw new Error('network down');
        return result(request, 'apply', false, { reason: 'denied' });
      }),
      onActionApplied,
    });
    await controller.previewAction(proposal('req-a'));
    await controller.applyAction('req-a');
    mode = 'throw';
    await controller.previewAction(proposal('req-b'));
    await controller.applyAction('req-b');
    expect(onActionApplied).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('keeps the applied state when the host callback throws', async () => {
    const onActionApplied = vi.fn(() => {
      throw new Error('host bug');
    });
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: registryWithSurface(),
      actionClient: client(async (request) => result(request, 'apply', true)),
      onActionApplied,
    });
    await controller.previewAction(proposal());
    await expect(
      controller.applyAction('req-approve'),
    ).resolves.toBeUndefined();
    expect(onActionApplied).toHaveBeenCalledTimes(1);
    expect(controller.actions.get('req-approve')?.status).toBe('applied');
    controller.dispose();
  });

  it('does not fire for an apply that lands after a context swap', async () => {
    const onActionApplied = vi.fn();
    let release!: () => void;
    let registry = registryWithSurface();
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      get registry() {
        return registry;
      },
      actionClient: client(async (request) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return result(request, 'apply', true);
      }),
      onActionApplied,
    });
    await controller.previewAction(proposal());
    const applying = controller.applyAction('req-approve');
    registry = registryWithSurface();
    controller.syncRegistry();
    release();
    await applying;
    expect(onActionApplied).not.toHaveBeenCalled();
    controller.dispose();
  });
});

describe('AssistantDock oncontroller / onactionapplied (#2989)', () => {
  it('lets a host propose an action and observe the applied outcome', async () => {
    let hostController: AssistantDockController | undefined;
    const onactionapplied = vi.fn();
    const oncontroller = vi.fn((c: AssistantDockController) => {
      hostController = c;
    });
    render(AssistantDock, {
      props: {
        transport: createInMemoryAssistantTransport(),
        registry: registryWithSurface(),
        actionClient: client(async (request) =>
          result(request, 'apply', true, {
            details: { approvedAssetId: 'asset-from-server' },
          }),
        ),
        oncontroller,
        onactionapplied,
      },
    });
    expect(oncontroller).toHaveBeenCalledTimes(1);
    expect(hostController).toBeDefined();

    await hostController?.previewAction(proposal());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Confirm' }),
    );
    await vi.waitFor(() => expect(onactionapplied).toHaveBeenCalledTimes(1));
    expect(onactionapplied.mock.calls[0][1].details).toEqual({
      approvedAssetId: 'asset-from-server',
    });
  });
});
