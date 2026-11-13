import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordList from '../lib/components/RecordList.svelte';
import { description } from '../test/draft-fixtures.ts';

const navigation = vi.hoisted(() => ({ invalidate: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => navigation);
let component: ReturnType<typeof mount>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
  vi.unstubAllGlobals();
});

describe('record delete by copy', () => {
  it.each([
    'live',
    'draft',
  ] as const)('handles the %s response and tells the owner what happens', async (target) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              target === 'draft'
                ? { deleted: 'row' }
                : {
                    status: 'pending_approval',
                    approvalId: 'delete',
                    summary: 'Delete customer',
                    preview: {},
                  },
            ),
            { status: target === 'draft' ? 200 : 202 },
          ),
      ),
    );
    component = mount(RecordList, {
      target: container,
      props: {
        model: 'Customer',
        description: description(target),
        rows: [{ id: 'row', name: 'Anna' }],
      },
    });
    await tick();
    container.querySelector<HTMLButtonElement>('td button')?.click();
    await tick();
    const dialog = container.querySelector('dialog');
    expect(dialog?.textContent).toContain(
      target === 'draft'
        ? 'Your live record stays unchanged'
        : 'stays until you approve it',
    );
    dialog?.querySelectorAll<HTMLButtonElement>('button')[1]?.click();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `/api/shell/records/Customer/row?target=${target}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    if (target === 'draft')
      await vi.waitFor(() =>
        expect(navigation.invalidate).toHaveBeenCalledWith('smrt:records'),
      );
    else
      await vi.waitFor(() =>
        expect(container.textContent).toContain('Waiting for your approval'),
      );
  });
});
