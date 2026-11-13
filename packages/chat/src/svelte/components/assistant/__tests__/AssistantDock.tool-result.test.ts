// @vitest-environment jsdom
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import {
  createInMemoryAssistantTransport,
  normalizeAssistantMessage,
} from '../assistant-transport.js';
import ToolResultFixture from './ToolResultFixture.svelte';

describe('generic tool result component seam', () => {
  it('preserves structured tool results through the HTTP normalizer', () => {
    const toolCallData = {
      name: 'reports.runtime.define',
      result: { phase: 'awaiting_confirmation' },
    };
    expect(
      normalizeAssistantMessage({ id: 'm', role: 'tool', toolCallData })
        .toolCallData,
    ).toEqual(toolCallData);
  });
  it('renders a host-selected component for tool messages and retains unknown text', async () => {
    const transport = createInMemoryAssistantTransport();
    if (!transport.createThread)
      throw new Error('fixture cannot create threads');
    const thread = await transport.createThread('Reports');
    transport.loadMessages = async () => [
      {
        id: 'known',
        threadId: thread.id,
        role: 'tool',
        content: 'known text',
        createdAt: new Date(),
      },
      {
        id: 'unknown',
        threadId: thread.id,
        role: 'tool',
        content: 'fallback text',
        createdAt: new Date(),
      },
      {
        id: 'user',
        threadId: thread.id,
        role: 'user',
        content: 'user text',
        createdAt: new Date(),
      },
    ];
    render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
        conversations: 'single',
        toolResultComponent: (message) =>
          message.id === 'known' ? ToolResultFixture : undefined,
      },
    });
    expect(await screen.findByText('Result for known')).toBeTruthy();
    expect(screen.getByText('fallback text')).toBeTruthy();
    expect(screen.getByText('user text')).toBeTruthy();
    expect(screen.queryByText('known text')).toBeNull();
  });
  it('renders generic person-facing legacy tool activity without names, summaries or payload details', async () => {
    const transport = createInMemoryAssistantTransport();
    if (!transport.createThread)
      throw new Error('fixture cannot create threads');
    const thread = await transport.createThread('Records');
    transport.loadMessages = async () => [
      {
        id: 'legacy',
        threadId: thread.id,
        role: 'tool',
        createdAt: new Date(),
        content: 'PRIVATE TenantId ProfileId @fixture/models:Member',
        toolCallData: { name: 'app_describe', args: { schema: 'PRIVATE' } },
      },
      {
        id: 'ordinary',
        threadId: thread.id,
        role: 'tool',
        createdAt: new Date(),
        content: 'PRIVATE raw outcome summary',
        toolCallData: {
          name: 'record_update',
          summary: 'PRIVATE JSON',
          args: { value: 'PRIVATE' },
        },
      },
      {
        id: 'user',
        threadId: thread.id,
        role: 'user',
        createdAt: new Date(),
        content: 'Keep this human message',
      },
      {
        id: 'answer',
        threadId: thread.id,
        role: 'assistant',
        createdAt: new Date(),
        content: 'Keep this ordinary answer',
      },
    ];
    const view = render(AssistantDock, {
      props: {
        transport,
        registry: createDataSurfaceRegistry(),
        contextMode: 'server',
        conversations: 'single',
        toolPresentation: 'generic',
      },
    });
    expect(await screen.findByText('Checked the app structure')).toBeTruthy();
    expect(screen.getByText('Completed this action')).toBeTruthy();
    expect(screen.getByText('Keep this human message')).toBeTruthy();
    expect(screen.getByText('Keep this ordinary answer')).toBeTruthy();
    expect(view.container.textContent).not.toMatch(
      /PRIVATE|TenantId|ProfileId|@fixture|record_update|app_describe/,
    );
  });
});
