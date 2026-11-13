import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { description, versions } from '../../test/draft-fixtures.ts';
import History from './+page.svelte';

let component: ReturnType<typeof mount>;
let container: HTMLDivElement;
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
  vi.unstubAllGlobals();
});
async function render(rows = versions) {
  component = mount(History, {
    target: container,
    props: {
      data: { versions: rows, description: description('live') },
    } as never,
  });
  await tick();
}

describe('publish history', () => {
  it.each([
    200, 202,
  ])('groups versions and undoes the publish through the first parent (%s)', async (status) => {
    const result =
      status === 202
        ? {
            status: 'pending_approval',
            approvalId: 'undo',
            summary: 'Undo publish',
            preview: {},
          }
        : { version: 1, summary: 'Undo publish' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(result), { status })),
    );
    await render();
    expect(
      [...container.querySelectorAll('h2')].filter(
        (h) => h.textContent === 'Better orders',
      ),
    ).toHaveLength(1);
    expect(container.textContent).toContain('Change 2');
    expect(container.textContent).toContain('Change 3');
    expect(
      [...container.querySelectorAll('button')].filter(
        (b) => b.textContent?.trim() === 'Undo this publish',
      ),
    ).toHaveLength(1);
    expect(button('Undo this change')).toBeUndefined();
    button('Undo this publish')?.click();
    await tick();
    expect(container.querySelector('dialog[open]')?.textContent).toContain(
      'Later changes are also taken back',
    );
    button('Undo')?.click();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/shell/undo-to?target=live',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ version: 1 }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        status === 202 ? 'Waiting for your approval' : 'Undone: Undo publish',
      ),
    );
    if (status === 202)
      expect(container.querySelector('a[href="/approvals"]')).toBeTruthy();
  });
  it('offers no undo for a publish that crossed a purged version', async () => {
    await render(versions.map((v) => ({ ...v, purged: v.version === 2 })));
    expect(button('Undo this publish')).toBeUndefined();
  });
});
