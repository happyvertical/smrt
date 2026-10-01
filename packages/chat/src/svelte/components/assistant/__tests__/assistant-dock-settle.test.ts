// @vitest-environment jsdom
/**
 * A step that navigates must be followed by a step that sees the NEW page's
 * tools: the dock waits for the host's settle hook, tracked link-surface
 * navigations, and a quiet registry before it resumes the turn.
 */
import {
  createDataSurfaceRegistry,
  registerLinkSurface,
} from '@happyvertical/smrt-ui/data';
import { describe, expect, it } from 'vitest';
import type { AssistantClientToolCall } from '../../../../assistant-turn-events.js';
import type {
  AssistantMessage,
  AssistantResumeTurnInput,
  AssistantSendMessageInput,
  AssistantTransport,
} from '../assistant-transport.js';
import type {
  AssistantClientTool,
  AssistantClientToolSource,
} from '../client-tools.js';
import { createAssistantDockController } from '../create-assistant-dock-controller.svelte.js';

function message(id: string, role: AssistantMessage['role'], content: string) {
  return {
    id,
    threadId: 't1',
    role,
    content,
    createdAt: new Date(0).toISOString(),
  } satisfies AssistantMessage;
}

function transportFor(calls: AssistantClientToolCall[]) {
  const sent: AssistantSendMessageInput[] = [];
  const resumed: AssistantResumeTurnInput[] = [];
  const transport: AssistantTransport & {
    sent: typeof sent;
    resumed: typeof resumed;
  } = {
    sent,
    resumed,
    listThreads: async () => [
      { id: 't1', title: 'T', isResolved: false, messageCount: 0 },
    ],
    createThread: async () => ({
      id: 't1',
      title: 'T',
      isResolved: false,
      messageCount: 0,
    }),
    loadMessages: async () => [],
    uploadAttachment: async () => {
      throw new Error('no');
    },
    async sendMessage(input) {
      sent.push(input);
      return {
        inProgress: false,
        userMessage: message('u1', 'user', input.content),
        clientToolCalls: { continuationId: 'cont-1', calls },
      };
    },
    async resumeTurn(input) {
      resumed.push(input);
      return {
        inProgress: false,
        assistantMessage: message('a1', 'assistant', 'Here it is.'),
      };
    },
  };
  return transport;
}

const tool = (name: string): AssistantClientTool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  effect: 'read',
});

describe('dock waits for the page to settle before the next step', () => {
  it('declares the new page tools after a navigation', async () => {
    const registry = createDataSurfaceRegistry();
    let current = [tool('nav_site_section')];
    const listeners = new Set<(event: unknown) => void>();
    let finishNavigation!: () => void;

    registerLinkSurface({
      registry,
      surfaceId: 'site-sections',
      label: 'Sections',
      description: 'Sections',
      links: [{ id: 'events', label: 'Events', href: '/events' }],
      navigate: () =>
        new Promise<void>((resolve) => {
          finishNavigation = () => {
            // The new page mounts and registers its own tools.
            current = [tool('nav_site_section'), tool('events_open')];
            for (const listener of listeners) listener({ type: 'change' });
            resolve();
          };
        }),
    });

    const pageTools: AssistantClientToolSource = {
      list: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async execute() {
        await registry.execute({
          version: 1,
          commandId: 'open-1',
          identity: { surfaceId: 'site-sections', kind: 'list' },
          expectedRevision: 1,
          controlId: 'open',
          payload: { target: 'Events' },
        });
        // The navigation finishes a little after the command answers.
        setTimeout(() => finishNavigation(), 30);
        return '{"ok":true}';
      },
    };

    const transport = transportFor([
      { id: 'c1', name: 'nav_site_section', args: {}, effect: 'read' },
    ]);
    let hostSettled = 0;
    const controller = createAssistantDockController({
      transport,
      registry,
      pageTools,
      settle: () => {
        hostSettled += 1;
      },
    });
    await controller.loadThreads();
    await controller.openThread('t1');
    await controller.send('show me events');

    expect(hostSettled).toBe(1);
    expect(transport.resumed[0].clientTools?.map((t) => t.name)).toEqual([
      'nav_site_section',
      'events_open',
    ]);
    controller.dispose();
  });

  it('is bounded: a host hook that never resolves only delays the step', async () => {
    const transport = transportFor([
      { id: 'c1', name: 'nav_site_section', args: {}, effect: 'read' },
    ]);
    const controller = createAssistantDockController({
      transport,
      registry: createDataSurfaceRegistry(),
      pageTools: {
        list: () => [tool('nav_site_section')],
        execute: async () => '{}',
      },
      settle: () => new Promise<void>(() => {}),
      settleTimeoutMs: 50,
    });
    await controller.loadThreads();
    await controller.openThread('t1');
    await controller.send('go');
    expect(transport.resumed).toHaveLength(1);
    controller.dispose();
  });
});
