// @vitest-environment jsdom
/**
 * Component-level coverage for AssistantDock (#2904 review finding F1).
 *
 * The unit suite for `createAssistantDockController` and the smrt-svelte
 * conformance-style integration test both drive a SEPARATE controller
 * instance than the one the mounted component owns, so neither one could
 * have caught F1: `AssistantDock`'s `$effect` read `$state` synchronously
 * (via `startPolling` → `pendingSends`), so every real `send()` through the
 * component's OWN controller re-ran the effect and its cleanup permanently
 * unsubscribed the registry listener after the first message. This file
 * renders the real component and drives it through its own DOM.
 */
import {
  createDataSurfaceRegistry,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';

const identity: DataSurfaceIdentity = {
  surfaceId: 'orders',
  kind: 'table',
  subject: { type: 'tenant', id: 'tenant-a' },
};

const descriptor: DataSurfaceDescriptor = {
  version: 1,
  identity,
  schemaVersion: 1,
  label: 'Orders',
  rowKey: 'id',
  columns: [{ id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' }],
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

describe('AssistantDock (mounted component)', () => {
  it('loadThreads/loadModels fire exactly once per mount, and the registry subscription survives a send (F1)', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport({
      respond: (threadId, userMessage) => ({
        id: 'assistant-1',
        threadId,
        content: `echo: ${userMessage.content}`,
        role: 'assistant',
        createdAt: new Date(),
      }),
    });
    const listThreadsSpy = vi.spyOn(transport, 'listThreads');

    render(AssistantDock, { props: { transport, registry } });

    expect(
      await screen.findByText(/No data surfaces are mounted on this route/i),
    ).toBeInTheDocument();
    expect(listThreadsSpy).toHaveBeenCalledTimes(1);

    // Create + open a thread through the UI, then send a real message
    // through the component's OWN mounted controller.
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    const textarea = await screen.findByLabelText('Message');
    await userEvent.type(textarea, 'hello there');
    const sendButton = screen.getByRole('button', { name: 'Send' });
    await userEvent.click(sendButton);

    expect(await screen.findByText('echo: hello there')).toBeInTheDocument();

    // F1 regression: before the fix, the send above re-ran the mount effect
    // and its cleanup permanently disposed the controller (unsubscribing
    // the registry listener), so a surface registered afterward was never
    // discovered and the "no surfaces" notice never cleared.
    registry.register({
      descriptor,
      getSnapshot: () => ({ revision: 1, state: {} }),
    });

    // Poll until the notice clears (or fail): the registry event handler
    // runs synchronously, so this should resolve on the very next microtask.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!screen.queryByText(/No data surfaces are mounted on this route/i)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      screen.queryByText(/No data surfaces are mounted on this route/i),
    ).not.toBeInTheDocument();

    // loadThreads must still have fired only once for the mount — not once
    // per send/poll re-run of a re-triggered effect.
    expect(listThreadsSpy).toHaveBeenCalledTimes(1);
  });

  // Finding B (#2904 review, third final pass): reassigning the `registry`
  // prop (a host swapping tenant/workspace context) must be observed by the
  // MOUNTED component's own controller, not just a freshly-constructed one.
  // The corresponding controller-level test in
  // create-assistant-dock-controller.test.ts asserts the harder-to-observe
  // parts (surfaces content, previewAction rejection, preview invalidation)
  // directly against syncRegistry(); this test proves the DOM-visible
  // surfaces-empty notice reacts to the same prop swap through the real
  // component, and that F1's "mount effect runs once" guarantee still
  // holds afterward.
  it('re-subscribes when the registry prop is reassigned to a different instance', async () => {
    const r1 = createDataSurfaceRegistry();
    r1.register({
      descriptor,
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    const transport = createInMemoryAssistantTransport();
    const listThreadsSpy = vi.spyOn(transport, 'listThreads');

    const { rerender } = render(AssistantDock, {
      props: { transport, registry: r1 },
    });

    // R1 has a mounted surface — the empty notice must not show.
    expect(
      screen.queryByText(/No data surfaces are mounted on this route/i),
    ).not.toBeInTheDocument();

    // Reassign the prop to a DIFFERENT, empty registry instance (R2).
    const r2 = createDataSurfaceRegistry();
    await rerender({ transport, registry: r2 });

    expect(
      await screen.findByText(/No data surfaces are mounted on this route/i),
    ).toBeInTheDocument();

    // Registering a surface on R2 must be discovered — proves the
    // subscription actually moved to R2, not just a one-time resync.
    const r2Identity = { ...identity, surfaceId: 'products' };
    r2.register({
      descriptor: { ...descriptor, identity: r2Identity },
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!screen.queryByText(/No data surfaces are mounted on this route/i)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      screen.queryByText(/No data surfaces are mounted on this route/i),
    ).not.toBeInTheDocument();

    // F1 guarantee preserved: the registry-scoped effect must not have
    // caused the SEPARATE mount effect to re-run.
    expect(listThreadsSpy).toHaveBeenCalledTimes(1);
  });

  // Finding 1 (#2904 review, fresh cycle): the documented `surfaces` override
  // prop did not exist on <AssistantDock> — only reachable by constructing
  // the controller directly. Discovery half asserted here through the DOM:
  // the override, not the registry's live contents, decides whether the
  // "no surfaces" notice renders.
  it("scopes discovery to the explicit `surfaces` override, ignoring the registry's live contents", async () => {
    const registry = createDataSurfaceRegistry();
    // Registry has ORDERS mounted, but the override is an explicit EMPTY
    // list — the notice must still render "no surfaces" because the
    // override, not the registry, is authoritative (surfaces is decoupled
    // from what's actually registered once an override is set).
    registry.register({
      descriptor,
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    const transport = createInMemoryAssistantTransport();

    render(AssistantDock, {
      props: { transport, registry, surfaces: [] },
    });

    expect(
      await screen.findByText(/No data surfaces are mounted on this route/i),
    ).toBeInTheDocument();
  });

  it('the `surfaces` override alone makes discovery non-empty, even with nothing registered', async () => {
    const registry = createDataSurfaceRegistry(); // nothing registered
    const transport = createInMemoryAssistantTransport();

    render(AssistantDock, {
      props: { transport, registry, surfaces: [identity] },
    });

    // Registry alone would show the empty notice; the override must
    // suppress it.
    expect(
      screen.queryByText(/No data surfaces are mounted on this route/i),
    ).not.toBeInTheDocument();
  });

  // Finding 4 (#2904 review, fresh cycle): a failed mount-time listThreads
  // must render as a dock-level error, not an empty, explanation-free
  // thread list.
  it('renders a dock-level error when the mount-time loadThreads() call rejects', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    transport.listThreads = async () => {
      throw new Error('offline');
    };

    render(AssistantDock, { props: { transport, registry } });

    expect(
      await screen.findByText(/Something went wrong: offline/i),
    ).toBeInTheDocument();
  });

  // Cycle-2 second final finding 1: the `surfaces` override was captured
  // once at construction — a mounted component's own controller never
  // observed a reassignment of the prop. Drives it through the real
  // component (rerender), not just the controller directly, mirroring how
  // Finding B's registry-swap test complements the controller-level test.
  it('re-scopes discovery and the action gate when the `surfaces` prop is reassigned, in both directions', async () => {
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor,
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    const transport = createInMemoryAssistantTransport();
    const productsIdentity: DataSurfaceIdentity = {
      ...identity,
      surfaceId: 'products',
    };

    const { rerender } = render(AssistantDock, {
      props: { transport, registry, surfaces: [productsIdentity] },
    });

    // Override only includes `products`; the registered `orders` surface is
    // gated out even though it's genuinely registered — the "no surfaces"
    // notice must NOT show (the override list is non-empty).
    expect(
      screen.queryByText(/No data surfaces are mounted on this route/i),
    ).not.toBeInTheDocument();

    // Narrow the override to an EMPTY list.
    await rerender({ transport, registry, surfaces: [] });
    expect(
      await screen.findByText(/No data surfaces are mounted on this route/i),
    ).toBeInTheDocument();

    // Widen back to include the registered `orders` surface — discovery
    // must follow the reassignment and the notice must clear.
    await rerender({ transport, registry, surfaces: [identity] });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!screen.queryByText(/No data surfaces are mounted on this route/i)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      screen.queryByText(/No data surfaces are mounted on this route/i),
    ).not.toBeInTheDocument();
  });

  // Cycle-2 second final finding 1: the F1 "mount effect runs exactly once"
  // guarantee must hold even with the new `surfaces`-scoped effect added
  // alongside the existing `registry` one.
  it('loadThreads still fires exactly once per mount when `surfaces` is reassigned', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    const listThreadsSpy = vi.spyOn(transport, 'listThreads');

    const { rerender } = render(AssistantDock, {
      props: { transport, registry, surfaces: [] },
    });
    await screen.findByText(/No data surfaces are mounted on this route/i);
    await rerender({ transport, registry, surfaces: [identity] });
    await rerender({ transport, registry, surfaces: [] });

    expect(listThreadsSpy).toHaveBeenCalledTimes(1);
  });

  // Cycle-2 second final finding 2: "+ New conversation" and thread
  // selection previously produced an unhandled rejection with zero
  // user-visible surface when the transport failed — the exact path a
  // `createSmrtAssistantTransport` without `writeEndpoint` is documented to
  // hit.
  it('a rejecting createThread (clicking "+ New conversation") shows the dock-level error banner', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    transport.createThread = async () => {
      throw new Error('no writeEndpoint configured');
    };

    render(AssistantDock, { props: { transport, registry } });
    await screen.findByText(/No data surfaces are mounted on this route/i);

    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );

    expect(
      await screen.findByText(
        /Something went wrong: no writeEndpoint configured/i,
      ),
    ).toBeInTheDocument();
  });

  // Cycle-2 third final: a rejecting uploadAttachment previously had no
  // catch in AssistantDock's handleUpload, so the dock-level banner never
  // reflected an attachment failure the way it does for send/thread
  // failures.
  it('a rejecting uploadAttachment shows the dock-level error banner', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    transport.uploadAttachment = async () => {
      throw new Error('no writeEndpoint configured');
    };

    const { container } = render(AssistantDock, {
      props: { transport, registry },
    });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    await screen.findByLabelText('Message');

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    await userEvent.upload(
      fileInput,
      new File(['data'], 'photo.png', { type: 'image/png' }),
    );

    expect(
      await screen.findByText(
        /Something went wrong: no writeEndpoint configured/i,
      ),
    ).toBeInTheDocument();
  });
});
