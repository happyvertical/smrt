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
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import {
  type AssistantAttachmentRef,
  type AssistantMessage,
  type AssistantTransport,
  createInMemoryAssistantTransport,
} from '../assistant-transport.js';
import type { AssistantDockController } from '../create-assistant-dock-controller.svelte.js';

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
  it('guides a server-context user to an existing conversation without selecting it for them', async () => {
    const registry = createDataSurfaceRegistry();
    const transport: AssistantTransport = {
      async listThreads() {
        return [
          {
            id: 'session-1',
            title: 'Workspace assistant',
            isResolved: false,
            messageCount: 0,
          },
        ];
      },
      async loadMessages() {
        return [];
      },
      async sendMessage(input) {
        return {
          inProgress: false,
          messages: [
            {
              id: 'reply-1',
              threadId: input.threadId,
              content: 'Server reply',
              role: 'assistant',
              createdAt: new Date(),
            },
          ],
        };
      },
    };

    const { container } = render(AssistantDock, {
      props: { transport, registry, contextMode: 'server' },
    });

    expect(
      await screen.findByRole('heading', { name: 'Choose a conversation' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
    const chooseButton = screen.getByRole('button', {
      name: 'View conversations',
    });
    expect(chooseButton).toHaveAttribute(
      'aria-controls',
      screen
        .getByRole('button', { name: 'Conversations' })
        .getAttribute('aria-controls'),
    );
    await expectNoA11yViolations(container);

    await userEvent.click(chooseButton);
    const workspaceThread = screen.getByRole('button', {
      name: 'Workspace assistant',
    });
    expect(document.activeElement).toBe(workspaceThread);
    await userEvent.click(workspaceThread);
    expect(
      screen.queryByRole('heading', { name: 'Choose a conversation' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /New conversation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Attach files/i }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(
      screen.queryByText(/Nothing on this page can be changed from the chat/i),
    ).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Message'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Server reply')).toBeInTheDocument();
  });

  it('shows loading before first-use guidance and offers creation only when supported', async () => {
    let resolveThreads!: (threads: []) => void;
    const transport = createInMemoryAssistantTransport();
    transport.listThreads = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveThreads = resolve;
        }),
    );

    const { container } = render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
      },
    });

    expect(
      screen.getByRole('status', { name: 'Loading conversations…' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Start a conversation' }),
    ).not.toBeInTheDocument();

    resolveThreads([]);
    expect(
      await screen.findByRole('heading', { name: 'Start a conversation' }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
    await userEvent.click(
      screen.getByRole('button', { name: 'Create conversation' }),
    );
    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(
      screen.queryByRole('heading', { name: 'Start a conversation' }),
    ).not.toBeInTheDocument();
  });

  it('explains an empty conversation list without inventing a create capability', async () => {
    const transport: AssistantTransport = {
      async listThreads() {
        return [];
      },
      async loadMessages() {
        return [];
      },
      async sendMessage() {
        return { inProgress: false };
      },
    };

    render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
      },
    });

    expect(
      await screen.findByRole('heading', {
        name: 'No conversations available',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create conversation' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
  });

  it('server context keeps transport errors visible', async () => {
    const transport: AssistantTransport = {
      async listThreads() {
        throw new Error('server unavailable');
      },
      async loadMessages() {
        return [];
      },
      async sendMessage() {
        return { inProgress: false };
      },
    };
    render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
      },
    });

    expect(
      await screen.findByText(/Something went wrong: server unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /conversation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing on this page can be changed from the chat/i),
    ).not.toBeInTheDocument();
  });

  it('returns to loading and neutral guidance when the transport context changes', async () => {
    const registry = createDataSurfaceRegistry();
    const original: AssistantTransport = {
      async listThreads() {
        return [
          {
            id: 'tenant-a-session',
            title: 'Tenant A assistant',
            isResolved: false,
            messageCount: 0,
          },
        ];
      },
      async loadMessages() {
        return [];
      },
      async sendMessage() {
        return { inProgress: false };
      },
    };
    let resolveReplacement!: (
      threads: Awaited<ReturnType<AssistantTransport['listThreads']>>,
    ) => void;
    const replacement: AssistantTransport = {
      listThreads: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveReplacement = resolve;
          }),
      ),
      async loadMessages() {
        return [];
      },
      async sendMessage() {
        return { inProgress: false };
      },
    };

    const { rerender } = render(AssistantDock, {
      props: {
        transport: original,
        registry,
        contextMode: 'server',
      },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Tenant A assistant' }),
    );
    expect(screen.getByLabelText('Message')).toBeEnabled();

    await rerender({
      transport: replacement,
      registry,
      contextMode: 'server',
    });
    expect(
      screen.getByRole('status', { name: 'Loading conversations…' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Tenant A assistant' }),
    ).not.toBeInTheDocument();

    resolveReplacement([
      {
        id: 'tenant-b-session',
        title: 'Tenant B assistant',
        isResolved: false,
        messageCount: 0,
      },
    ]);
    expect(
      await screen.findByRole('heading', { name: 'Choose a conversation' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Tenant B assistant' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
  });

  it('removes full-only controls and staged attachments on a reduced transport swap', async () => {
    const registry = createDataSurfaceRegistry();
    const full = createInMemoryAssistantTransport();
    const reduced: AssistantTransport = {
      async listThreads() {
        return [
          {
            id: 'tenant-b-session',
            title: 'Tenant B',
            isResolved: false,
            messageCount: 0,
          },
        ];
      },
      async loadMessages() {
        return [];
      },
      async sendMessage() {
        return { inProgress: false };
      },
    };
    const { container, rerender } = render(AssistantDock, {
      props: { transport: full, registry, contextMode: 'server' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    await userEvent.upload(
      fileInput,
      new File(['data'], 'tenant-a.png', { type: 'image/png' }),
    );
    expect(await screen.findByText('tenant-a.png')).toBeInTheDocument();

    await rerender({ transport: reduced, registry, contextMode: 'server' });

    expect(await screen.findByText('Tenant B')).toBeInTheDocument();
    expect(screen.queryByText('tenant-a.png')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /New conversation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Attach files/i }),
    ).not.toBeInTheDocument();
  });

  it.each([
    false,
    true,
  ])('isolates deferred upload rejection after transport replacement (reuse=%s)', async (reuseOriginal) => {
    const registry = createDataSurfaceRegistry();
    const original = createInMemoryAssistantTransport();
    let rejectUpload!: (error: Error) => void;
    const pendingUpload = new Promise<never>((_, reject) => {
      rejectUpload = reject;
    });
    original.uploadAttachment = vi.fn(() => pendingUpload);
    const replacement: AssistantTransport = {
      async listThreads() {
        throw new Error('Current context error');
      },
      async loadMessages() {
        return [];
      },
      async sendMessage() {
        return { inProgress: false };
      },
    };
    const { container, rerender } = render(AssistantDock, {
      props: { transport: original, registry, contextMode: 'server' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('file input not found');
    await userEvent.upload(
      input,
      new File(['a'], 'private-a.png', { type: 'image/png' }),
    );
    expect(original.uploadAttachment).toHaveBeenCalledTimes(1);
    await rerender({ transport: replacement, registry, contextMode: 'server' });
    if (reuseOriginal) {
      original.listThreads = replacement.listThreads;
      await rerender({ transport: original, registry, contextMode: 'server' });
    }
    expect(
      await screen.findByText(/Something went wrong: Current context error/),
    ).toBeInTheDocument();
    rejectUpload(new Error('Private previous context error'));
    await pendingUpload.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.queryByText(/Private previous context error/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Something went wrong: Current context error/),
    ).toBeInTheDocument();
  });

  it('clears staged attachments after registry-only replacement', async () => {
    const transport = createInMemoryAssistantTransport();
    const { container, rerender } = render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('file input not found');
    await userEvent.upload(
      input,
      new File(['a'], 'private-a.png', { type: 'image/png' }),
    );
    expect(await screen.findByText('private-a.png')).toBeInTheDocument();

    await rerender({
      transport,
      registry: createDataSurfaceRegistry(),
      contextMode: 'server',
    });
    expect(screen.queryByText('private-a.png')).not.toBeInTheDocument();
  });

  it.each([
    'resolve',
    'reject',
  ] as const)('isolates deferred upload %s after registry-only replacement', async (outcome) => {
    const originalRegistry = createDataSurfaceRegistry();
    const replacementRegistry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    const sendMessage = vi.spyOn(transport, 'sendMessage');
    let resolveUpload!: (attachments: AssistantAttachmentRef[]) => void;
    let rejectUpload!: (error: Error) => void;
    const pendingUpload = new Promise<AssistantAttachmentRef[]>(
      (resolve, reject) => {
        resolveUpload = resolve;
        rejectUpload = reject;
      },
    );
    transport.uploadAttachment = vi.fn(async () => (await pendingUpload)[0]);
    const { container, rerender } = render(AssistantDock, {
      props: { transport, registry: originalRegistry, contextMode: 'server' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('file input not found');
    await userEvent.upload(
      input,
      new File(['a'], 'private-a.png', { type: 'image/png' }),
    );
    expect(transport.uploadAttachment).toHaveBeenCalledTimes(1);

    await rerender({
      transport,
      registry: replacementRegistry,
      contextMode: 'server',
    });
    await userEvent.click(
      screen.getByRole('button', { name: /^\+ New conversation$/i }),
    );
    if (outcome === 'resolve')
      resolveUpload([{ id: 'private', name: 'private-a.png' }]);
    else rejectUpload(new Error('Private previous context error'));
    await pendingUpload.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText('private-a.png')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Private previous context error/),
    ).not.toBeInTheDocument();
    if (outcome === 'resolve') {
      await userEvent.type(screen.getByLabelText('Message'), 'new context');
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));
      expect(sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ attachments: [] }),
      );
    }
  });

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
      await screen.findByText(
        /Nothing on this page can be changed from the chat/i,
      ),
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
      if (
        !screen.queryByText(
          /Nothing on this page can be changed from the chat/i,
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      screen.queryByText(/Nothing on this page can be changed from the chat/i),
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
      screen.queryByText(/Nothing on this page can be changed from the chat/i),
    ).not.toBeInTheDocument();

    // Reassign the prop to a DIFFERENT, empty registry instance (R2).
    const r2 = createDataSurfaceRegistry();
    await rerender({ transport, registry: r2 });

    expect(
      await screen.findByText(
        /Nothing on this page can be changed from the chat/i,
      ),
    ).toBeInTheDocument();

    // Registering a surface on R2 must be discovered — proves the
    // subscription actually moved to R2, not just a one-time resync.
    const r2Identity = { ...identity, surfaceId: 'products' };
    r2.register({
      descriptor: { ...descriptor, identity: r2Identity },
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        !screen.queryByText(
          /Nothing on this page can be changed from the chat/i,
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      screen.queryByText(/Nothing on this page can be changed from the chat/i),
    ).not.toBeInTheDocument();

    // F1 guarantee preserved: the registry-scoped effect must not have
    // caused the SEPARATE mount effect to re-run — but Copilot PR #2919
    // jAwsd's fix means the swap ITSELF now legitimately triggers exactly
    // one more loadThreads() call, via syncRegistry()'s
    // resetConversationStateForContextSwap() reloading from the new
    // context. Two total: one from the mount effect, one from the swap.
    expect(listThreadsSpy).toHaveBeenCalledTimes(2);
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
      await screen.findByText(
        /Nothing on this page can be changed from the chat/i,
      ),
    ).toBeInTheDocument();
  });

  // Copilot PR #2919 jAwr0: `surfaces` is a NARROWING filter over the live
  // registry — an override identity that isn't genuinely registered must
  // NOT make discovery non-empty (that broke the documented fail-closed
  // route scoping). Renamed from "the `surfaces` override alone makes
  // discovery non-empty, even with nothing registered", which asserted the
  // now-fixed behavior.
  it('the `surfaces` override does NOT make discovery non-empty when the override identity is not registered', async () => {
    const registry = createDataSurfaceRegistry(); // nothing registered
    const transport = createInMemoryAssistantTransport();

    render(AssistantDock, {
      props: { transport, registry, surfaces: [identity] },
    });

    expect(
      await screen.findByText(
        /Nothing on this page can be changed from the chat/i,
      ),
    ).toBeInTheDocument();
  });

  it('the `surfaces` override makes discovery non-empty only when the identity IS also registered', async () => {
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor,
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    const transport = createInMemoryAssistantTransport();

    render(AssistantDock, {
      props: { transport, registry, surfaces: [identity] },
    });

    expect(
      screen.queryByText(/Nothing on this page can be changed from the chat/i),
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
    // Copilot PR #2919 jAwr0: `surfaces` narrows against the live registry,
    // so `products` must be genuinely registered too, or it would never
    // pass the mount gate regardless of the override.
    registry.register({
      descriptor: { ...descriptor, identity: productsIdentity },
      getSnapshot: () => ({ revision: 1, state: {} }),
    });

    const { rerender } = render(AssistantDock, {
      props: { transport, registry, surfaces: [productsIdentity] },
    });

    // Override only includes `products`; the registered `orders` surface is
    // gated out even though it's genuinely registered — the "no surfaces"
    // notice must NOT show (the override list is non-empty).
    expect(
      screen.queryByText(/Nothing on this page can be changed from the chat/i),
    ).not.toBeInTheDocument();

    // Narrow the override to an EMPTY list.
    await rerender({ transport, registry, surfaces: [] });
    expect(
      await screen.findByText(
        /Nothing on this page can be changed from the chat/i,
      ),
    ).toBeInTheDocument();

    // Widen back to include the registered `orders` surface — discovery
    // must follow the reassignment and the notice must clear.
    await rerender({ transport, registry, surfaces: [identity] });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        !screen.queryByText(
          /Nothing on this page can be changed from the chat/i,
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      screen.queryByText(/Nothing on this page can be changed from the chat/i),
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
    await screen.findByText(
      /Nothing on this page can be changed from the chat/i,
    );
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
    await screen.findByText(
      /Nothing on this page can be changed from the chat/i,
    );

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

  // Cycle-3 second final finding 1: message.attachments was populated by the
  // transport but never rendered anywhere — an uploaded, sent attachment
  // became permanently invisible the instant the composer's chip row
  // cleared on success.
  it('renders an attachment chip on a message after send()', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();

    const { container } = render(AssistantDock, {
      props: { transport, registry },
    });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    const textarea = await screen.findByLabelText('Message');

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    await userEvent.upload(
      fileInput,
      new File(['data'], 'report.pdf', { type: 'application/pdf' }),
    );

    await userEvent.type(textarea, 'here is the report');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('report.pdf')).toBeInTheDocument();
  });

  it('renders an attachment chip on a message loaded via loadMessages()', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    const originalLoadMessages = transport.loadMessages.bind(transport);
    transport.loadMessages = async (threadId: string) => {
      const existing = await originalLoadMessages(threadId);
      if (existing.length > 0) return existing;
      return [
        {
          id: 'seeded-1',
          threadId,
          content: 'attached earlier',
          role: 'user',
          createdAt: new Date(),
          attachments: [{ id: 'att-seeded', name: 'contract.docx' }],
        },
      ];
    };

    render(AssistantDock, { props: { transport, registry } });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );

    expect(await screen.findByText('contract.docx')).toBeInTheDocument();
  });

  // Cycle-3 second final finding 2: a `models`-bearing transport mounts
  // ModelPicker (previously untested and unnamed anywhere in this suite);
  // an attachment-bearing message exercises the chip/link list added for
  // finding 1 above. Neither path had ever been axe-checked.
  it('is axe-clean with ModelPicker mounted and an attachment-bearing message', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport({
      models: [
        { id: 'model-a', label: 'Model A' },
        { id: 'model-b', label: 'Model B' },
      ],
    });

    const { container } = render(AssistantDock, {
      props: { transport, registry },
    });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    const textarea = await screen.findByLabelText('Message');

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    await userEvent.upload(
      fileInput,
      new File(['data'], 'report.pdf', { type: 'application/pdf' }),
    );
    await userEvent.type(textarea, 'here is the report');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('report.pdf');

    // ModelPicker must have mounted (its accessible name resolves).
    expect(screen.getByLabelText('Model')).toBeInTheDocument();

    await expectNoA11yViolations(container);
  });

  // Cycle-3 second final F1 addendum: attachment.url is transport-supplied
  // data bound to <a href> — a javascript: URL must never render a
  // clickable anchor.
  it('renders a javascript: attachment URL as plain text, not an anchor', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    const originalLoadMessages = transport.loadMessages.bind(transport);
    transport.loadMessages = async (threadId: string) => {
      const existing = await originalLoadMessages(threadId);
      if (existing.length > 0) return existing;
      return [
        {
          id: 'seeded-xss',
          threadId,
          content: 'attached earlier',
          role: 'user',
          createdAt: new Date(),
          attachments: [
            {
              id: 'att-xss',
              name: 'evil.txt',
              url: 'javascript:alert(1)',
            },
          ],
        },
      ];
    };

    render(AssistantDock, { props: { transport, registry } });
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );

    const attachmentText = await screen.findByText('evil.txt');
    expect(attachmentText.closest('a')).toBeNull();
  });

  // #3000: in a narrow container the thread list collapses behind a
  // "Conversations" disclosure (the `@container` rule decides visibility;
  // jsdom has no layout, so this pins the state + ARIA contract the CSS
  // keys off). Widths are measured in a real browser, see the PR.
  it('exposes a labelled Conversations disclosure that controls the thread list and closes when a conversation starts (#3000)', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    const { container } = render(AssistantDock, {
      props: { transport, registry },
    });

    const toggle = screen.getByRole('button', { name: 'Conversations' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const controlsId = toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    const region = container.querySelector(`#${CSS.escape(controlsId ?? '')}`);
    expect(region).not.toBeNull();
    expect(
      region?.querySelector('nav[aria-label="Assistant conversations"]'),
    ).not.toBeNull();
    const layout = container.querySelector('.assistant-dock-layout');
    expect(layout).not.toHaveAttribute('data-threads-open');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(layout).toHaveAttribute('data-threads-open');

    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Starting a conversation from the open list hands the width back.
    await userEvent.click(
      screen.getByRole('button', { name: /New conversation/i }),
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(layout).not.toHaveAttribute('data-threads-open');
    // The activated button is now inside a hidden region; focus returns to
    // the toggle instead of falling back to <body>.
    await vi.waitFor(() => expect(document.activeElement).toBe(toggle));
    await expectNoA11yViolations(container);
  });

  it('closes the narrow list and returns focus to the toggle when an existing thread is selected (#3000)', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    await transport.createThread('Existing chat');
    render(AssistantDock, { props: { transport, registry } });

    const toggle = screen.getByRole('button', { name: 'Conversations' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(
      await screen.findByRole('button', { name: /Existing chat/ }),
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await vi.waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it('omits the Conversations toggle and thread list when `threadList` is false (#3405)', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    await transport.createThread('Existing chat');
    const { container } = render(AssistantDock, {
      props: { transport, registry, threadList: false },
    });

    // The empty state settles first, so absence below is not just "not loaded".
    expect(
      await screen.findByRole('heading', { name: 'Start a conversation' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Conversations' }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('nav[aria-label="Assistant conversations"]'),
    ).toBeNull();
    expect(container.querySelector('.assistant-dock-threads')).toBeNull();
    expect(
      container.querySelector('.assistant-dock-threads-toggle'),
    ).toBeNull();
    expect(screen.queryByText('Existing chat')).not.toBeInTheDocument();
    // Never points at the omitted list.
    expect(
      screen.queryByRole('button', { name: 'View conversations' }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('[aria-controls]')).toBeNull();
    expect(container.querySelector('.assistant-dock-main')).not.toBeNull();
    await expectNoA11yViolations(container);
  });

  it('still renders the thread list by default and with `threadList` true (#3405)', async () => {
    const registry = createDataSurfaceRegistry();
    for (const props of [{}, { threadList: true }]) {
      const { container, unmount } = render(AssistantDock, {
        props: {
          transport: createInMemoryAssistantTransport(),
          registry,
          ...props,
        },
      });
      expect(
        screen.getByRole('button', { name: 'Conversations' }),
      ).toBeInTheDocument();
      expect(container.querySelector('.assistant-dock-threads')).not.toBeNull();
      unmount();
    }
  });

  it('with `threadList` false a host-opened conversation takes the whole dock and can be sent to (#3405)', async () => {
    const registry = createDataSurfaceRegistry();
    const transport = createInMemoryAssistantTransport();
    let dock: AssistantDockController | undefined;
    const { container } = render(AssistantDock, {
      props: {
        transport,
        registry,
        threadList: false,
        oncontroller: (c: AssistantDockController) => {
          dock = c;
        },
      },
    });

    await vi.waitFor(() => expect(dock).toBeDefined());
    const thread = await dock?.createThread('Host-opened');
    await dock?.openThread(thread?.id ?? '');

    const composer = await screen.findByLabelText('Message');
    await vi.waitFor(() => expect(composer).toBeEnabled());
    expect(
      screen.queryByRole('heading', { name: 'Start a conversation' }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('.assistant-dock-threads')).toBeNull();
    await userEvent.type(composer, 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText('hello')).toBeInTheDocument();
  });

  // #2988: a host renders a message's own toolCallData through the
  // `toolCall` snippet; without one the dock never renders the payload.
  describe('toolCall snippet (#2988)', () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    function transportWithToolCall() {
      return createInMemoryAssistantTransport({
        respond: (threadId, userMessage) => ({
          id: `assistant-${userMessage.id}`,
          threadId,
          content: userMessage.content === 'plain' ? 'no tool' : 'with tool',
          role: 'assistant',
          createdAt: new Date(),
          toolCallData:
            userMessage.content === 'plain'
              ? undefined
              : { kind: 'imageEditCandidate', label: hostile },
        }),
      });
    }

    async function sendThroughDock(text: string) {
      const textarea = await screen.findByLabelText('Message');
      await userEvent.type(textarea, text);
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    }

    it('renders the host snippet inside the bubble only for messages with toolCallData', async () => {
      const seen: AssistantMessage[] = [];
      const toolCall = createRawSnippet((message: () => AssistantMessage) => ({
        render: () => '<span class="host-tool-call"></span>',
        setup(node: Element) {
          const m = message();
          seen.push(m);
          const data = m.toolCallData as { kind: string; label: string };
          node.textContent = `${data.kind}: ${data.label}`;
        },
      }));
      const { container } = render(AssistantDock, {
        props: {
          transport: transportWithToolCall(),
          registry: createDataSurfaceRegistry(),
          toolCall,
        },
      });
      await userEvent.click(
        screen.getByRole('button', { name: /New conversation/i }),
      );
      await sendThroughDock('plain');
      expect(await screen.findByText('no tool')).toBeInTheDocument();
      await sendThroughDock('tool');
      expect(await screen.findByText('with tool')).toBeInTheDocument();

      const regions = container.querySelectorAll('.assistant-dock-tool-call');
      expect(regions).toHaveLength(1);
      expect(regions[0].textContent).toBe(`imageEditCandidate: ${hostile}`);
      // Rendered as text, never parsed as markup.
      expect(container.querySelector('img')).toBeNull();
      expect(
        regions[0]
          .closest('li')
          ?.querySelector('.assistant-dock-message-content')?.textContent,
      ).toBe('with tool');
      expect(seen.every((m) => m.toolCallData != null)).toBe(true);
    });

    it('renders no tool-call region and never the raw payload without a snippet', async () => {
      const { container } = render(AssistantDock, {
        props: {
          transport: transportWithToolCall(),
          registry: createDataSurfaceRegistry(),
        },
      });
      await userEvent.click(
        screen.getByRole('button', { name: /New conversation/i }),
      );
      await sendThroughDock('tool');
      expect(await screen.findByText('with tool')).toBeInTheDocument();
      expect(container.querySelector('.assistant-dock-tool-call')).toBeNull();
      expect(container.innerHTML).not.toContain('imageEditCandidate');
      expect(container.querySelector('img')).toBeNull();
    });
  });
});
