import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { result } from '../../test/report-fixtures.ts';
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
          ? 'Tried in a draft. Your live app is unchanged.'
          : 'Changed in your live app.',
      ),
    );
  });
});

it('reopens old tool chips as human lines without JSON, SQL or snapshot paths', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      return new Response(
        JSON.stringify(
          path.includes('/status')
            ? { configured: true }
            : path.endsWith('/old?target=live')
              ? {
                  messages: [
                    {
                      id: '1',
                      seq: 1,
                      role: 'tool',
                      content: '',
                      tool: {
                        id: '1',
                        name: 'app_addfield',
                        ok: true,
                        summary:
                          '{"data":{"summary":"add Product.notes","statements":["ALTER TABLE products"],"snapshot":"/private/tmp/app.db"}}',
                      },
                    },
                    {
                      id: '2',
                      seq: 2,
                      role: 'tool',
                      content: '',
                      tool: {
                        id: '2',
                        name: 'app_describe',
                        ok: true,
                        summary: '{"data":{"mode":"live"',
                      },
                    },
                  ],
                }
              : { threads: [{ id: 'old' }], approvals: [] },
        ),
      );
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  component = mount(AssistantPanel, {
    target: container,
    props: { open: true },
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain('add Product.notes'),
  );
  expect(container.textContent).toContain('Checked the app structure');
  for (const chip of container.querySelectorAll('.chip')) {
    expect(chip.textContent).not.toMatch(/[{}]|ALTER TABLE|\/private/);
    expect(chip.getAttribute('title')).not.toMatch(
      /[{}]|ALTER TABLE|\/private/,
    );
  }
});

it('renders an assistant-run report with the shared result component and record links', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      if (path.includes('/turn'))
        return new Response(
          [
            { type: 'tool_call', id: 'r', name: 'app_runreport', args: '{}' },
            {
              type: 'tool_result',
              id: 'r',
              name: 'app_runreport',
              ok: true,
              summary: 'Ran Sales: 1 rows',
              report: {
                result: { ...result, chart: { type: 'table' } },
                href: '/reports/sales',
              },
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
  document.body.append(container);
  component = mount(AssistantPanel, {
    target: container,
    props: { open: true },
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Tell me what you want'),
  );
  const field = container.querySelector('textarea');
  if (!field) throw new Error('Missing composer');
  field.value = 'Run sales';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(
      container.querySelector('[data-smrt-component="ReportResult"]'),
    ).toBeTruthy(),
  );
  expect(container.querySelector('td a')?.textContent).toBe('Acme Ltd');
  expect(container.querySelector('a[href="/reports/sales"]')?.textContent).toBe(
    'Open report',
  );
});

it('shows a working indicator with the current step while a turn runs', async () => {
  const sse = (e: unknown) =>
    new TextEncoder().encode(`event: turn\ndata: ${JSON.stringify(e)}\n\n`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      if (path.includes('/turn'))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                sse({
                  type: 'tool_call',
                  id: 't',
                  name: 'app_describe',
                  args: '{}',
                }),
              );
            },
          }),
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
  const target = document.createElement('div');
  document.body.appendChild(target);
  const mounted = mount(AssistantPanel, { target, props: { open: true } });
  await vi.waitFor(() =>
    expect(target.textContent).toContain('Tell me what you want'),
  );
  const field = target.querySelector('textarea');
  if (!field) throw new Error('Missing assistant input');
  field.value = 'Look around';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  target
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(
      target.querySelector('[data-testid="assistant-working"]')?.textContent,
    ).toContain('Looking at your app'),
  );
  expect(target.textContent).not.toContain('Describe');
  unmount(mounted);
  target.remove();
});
