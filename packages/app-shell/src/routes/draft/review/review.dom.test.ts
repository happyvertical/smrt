import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  description,
  draftInfo,
  preview,
  publishApproval,
} from '../../../test/draft-fixtures.ts';
import Review from './+page.svelte';

const navigation = vi.hoisted(() => ({
  goto: vi.fn(async () => {}),
  invalidateAll: vi.fn(async () => {}),
}));
vi.mock('$app/navigation', () => navigation);
let container: HTMLDivElement;
let component: ReturnType<typeof mount>;
let changedAt: 'request' | 'decision' | null;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => {
  changedAt = null;
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const path = String(input);
      if (path.includes('/preview')) return json({ draft: draftInfo, preview });
      if (path.includes('/publish')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          expect: preview.digest,
        });
        return changedAt === 'request'
          ? json({ error: 'The draft changed since this preview.' }, 409)
          : json(
              {
                status: 'pending_approval',
                approvalId: 'approval-publish',
                summary: 'Publish Better orders',
                preview,
              },
              202,
            );
      }
      if (path.includes('/approvals/'))
        return changedAt === 'decision'
          ? json({
              id: 'approval-publish',
              status: 'failed',
              error: 'The draft changed since this preview.',
            })
          : json({ id: 'approval-publish', status: 'approved' });
      if (path.includes('/approvals'))
        return json({ approvals: [publishApproval()] });
      throw new Error(`Unexpected request ${path}`);
    }),
  );
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  component = mount(Review, {
    target: container,
    props: { data: { description: description() } } as never,
  });
  await vi.waitFor(() => expect(button('Publish')).toBeTruthy());
}

describe('publish review', () => {
  it('renders the preview counts, changes and every method in full', async () => {
    await render();
    const text = container.textContent;
    for (const expected of [
      'Better orders',
      'Add model Order',
      'Remove model Note',
      'Customer.age: text to integer',
      'Archived values: 7',
      'Archived tables: 1',
      'Counts can change until you publish',
      'All method code (2)',
    ])
      expect(text).toContain(expected);
    expect(
      [...container.querySelectorAll('pre code')].map((c) => c.textContent),
    ).toEqual(preview.methods.map((m) => m.code));
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/draft/preview?target=draft',
      expect.objectContaining({ method: 'POST' }),
    );
  });
  it('requests the digest-pinned Approval and resolves it using the existing card', async () => {
    await render();
    button('Publish')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('button')?.textContent).toContain(
        'Approve',
      ),
    );
    const approve = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((b) => b.textContent?.startsWith('Approve'));
    expect(approve).toBeTruthy();
    expect(button('Publish')).toBeUndefined();
    approve?.click();
    await vi.waitFor(() =>
      expect(navigation.goto).toHaveBeenCalledWith('/', {
        invalidateAll: true,
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/approvals/approval-publish?target=live',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ approve: true }),
      }),
    );
  });
  it.each([
    'request',
    'decision',
  ] as const)('shows a changed-chain refusal at %s and offers a fresh review', async (at) => {
    changedAt = at;
    await render();
    button('Publish')?.click();
    if (at === 'decision') {
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll('button')].some((b) =>
            b.textContent?.startsWith('Approve'),
          ),
        ).toBe(true),
      );
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.startsWith('Approve'))
        ?.click();
    }
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        'The draft changed since this preview.',
      ),
    );
    expect(button('Review again')).toBeTruthy();
    expect(navigation.goto).not.toHaveBeenCalled();
    changedAt = null;
    button('Review again')?.click();
    await vi.waitFor(() => expect(button('Publish')).toBeTruthy());
    await tick();
    expect(container.textContent).not.toContain(
      'The draft changed since this preview.',
    );
  });
});
