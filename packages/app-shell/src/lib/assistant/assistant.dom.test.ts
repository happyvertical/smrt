import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AssistantPanel from './AssistantPanel.svelte';

let component: ReturnType<typeof mount>;
let container: HTMLDivElement;
afterEach(() => {
  if (component) unmount(component);
  container?.remove();
  vi.unstubAllGlobals();
});
describe('assistant copy labels', () => {
  it.each([
    'draft',
    'live',
  ] as const)('labels a streamed tool result for the %s copy', async (copy) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const path = String(input);
        if (path.includes('/turn'))
          return new Response(
            [
              {
                type: 'tool_call',
                id: 'tool',
                name: 'chore_create',
                args: '{}',
              },
              {
                type: 'tool_result',
                id: 'tool',
                name: 'chore_create',
                ok: true,
                summary: 'Created a chore',
                copy,
              },
              { type: 'done', stop: 'complete' },
            ]
              .map((e) => `event: turn\ndata: ${JSON.stringify(e)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        return new Response(
          JSON.stringify(
            path.includes('/status')
              ? { configured: true }
              : { threads: [], approvals: [] },
          ),
        );
      }),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    component = mount(AssistantPanel, {
      target: container,
      props: { open: true, buildingInDraft: true },
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Tell me what you want'),
    );
    const field = container.querySelector('textarea');
    if (!field) throw new Error('Missing assistant input');
    field.value = 'Add a chore';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        copy === 'draft'
          ? 'Draft copy. Your live app is unchanged.'
          : 'Live copy.',
      ),
    );
  });
});
