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
      await screen.findByText(/No data surfaces are mounted on this route/i),
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
      await screen.findByText(/No data surfaces are mounted on this route/i),
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
});
