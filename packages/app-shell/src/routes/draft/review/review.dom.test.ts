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

it('groups definition changes into counted sections before ordered changes and method code', async () => {
  await render();
  const group = (name: string) =>
    container.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  expect(group('Added')?.textContent).toContain('Add model Order');
  expect(group('Added')?.textContent).toContain('Add field Customer.email');
  expect(
    group('Added')?.querySelector('[data-smrt-component="Badge"]')?.textContent,
  ).toBe('3');
  expect(group('Added')?.textContent).toContain('Add method Order.total()');
  expect(group('Removed')?.textContent).toContain('Remove model Note');
  expect(group('Removed')?.textContent).toContain(
    'Remove field Customer.oldName',
  );
  expect(group('Changed')?.textContent).toContain(
    'Customer.age: text to integer',
  );
  expect(group('Archived')?.textContent).toContain('Archived values: 7');
  expect(group('Archived')?.textContent).toContain('Archived tables: 1');
  expect(
    group('Archived')?.querySelector('[data-smrt-component="Badge"]')
      ?.textContent,
  ).toBe('8');
  const changes = container.querySelector('ol');
  expect(changes?.querySelectorAll('li').length).toBe(2);
  expect(
    Boolean(
      (group('Archived')?.compareDocumentPosition(changes as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBe(true);
  expect(
    Boolean(
      (changes?.compareDocumentPosition(
        container.querySelector('pre') as Node,
      ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBe(true);
  expect(
    container.querySelectorAll('[data-smrt-component="Card"]').length,
  ).toBe(4);
});

it('keeps empty change groups visible with zero counts', async () => {
  vi.mocked(fetch).mockResolvedValue(
    json({
      draft: draftInfo,
      preview: {
        ...preview,
        versions: [],
        methods: [],
        archives: { values: 0, tables: 0 },
        definition: {
          modelsAdded: [],
          modelsRemoved: [],
          recipesAdded: [],
          recipesRemoved: [],
          models: {},
        },
      },
    }),
  );
  await render();
  for (const name of ['Added', 'Removed', 'Changed', 'Archived']) {
    const group = container.querySelector(`section[aria-label="${name}"]`);
    expect(
      group?.querySelector('[data-smrt-component="Badge"]')?.textContent,
    ).toBe('0');
  }
  expect(container.querySelector('ol')?.children.length).toBe(0);
});

it('does not request a preview when mounted without a ready draft', async () => {
  component = mount(Review, {
    target: container,
    props: {
      data: { description: { ...description(), draft: null } },
    } as never,
  });
  await tick();
  await tick();
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
