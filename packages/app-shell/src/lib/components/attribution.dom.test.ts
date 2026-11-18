import { mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import Approvals from '../../routes/approvals/+page.svelte';
import History from '../../routes/history/+page.svelte';
import {
  description,
  publishApproval,
  versions,
} from '../../test/draft-fixtures.ts';

let component: ReturnType<typeof mount>;
let container: HTMLDivElement;
afterEach(async () => {
  if (component) await unmount(component);
  container?.remove();
});
const session = {
  authenticated: true,
  user: { id: '21bef521-6007-80e0-bfb7-313b8b80f7cb', name: 'Jamie' },
};

it('shows the owner name with spaces in requested and decided approval attribution', async () => {
  container = document.createElement('div');
  document.body.append(container);
  component = mount(Approvals, {
    target: container,
    props: {
      data: {
        session,
        description: description('live'),
        approvals: [
          {
            ...publishApproval(),
            requestedBy: session.user.id,
            decidedBy: session.user.id,
            status: 'approved',
            createdAt: new Date().toISOString(),
            decidedAt: new Date().toISOString(),
          },
        ],
      },
    } as never,
  });
  expect(container.textContent?.replace(/\s+/g, ' ')).toContain(
    'Asked just now by Jamie',
  );
  expect(container.textContent?.replace(/\s+/g, ' ')).toContain(
    'approved just now by Jamie',
  );
  expect(container.textContent).not.toContain(session.user.id);
});
it('resolves history names while retaining recorded assistant and engine attribution', async () => {
  // A publish group shows its newest entry's author, so vary who wrote it.
  const authors = [
    { newest: 'engine', expected: 'engine · ' },
    { newest: 'assistant', expected: 'the assistant · ' },
  ];
  for (const { newest, expected } of authors) {
    container = document.createElement('div');
    document.body.append(container);
    component = mount(History, {
      target: container,
      props: {
        data: {
          session,
          description: description('live'),
          versions: versions.map((v, i) => ({
            ...v,
            author: [session.user.id, 'assistant', newest][i],
          })),
        },
      },
    } as never);
    const text = container.textContent?.replace(/\s+/g, ' ');
    expect(text).toContain('Jamie · ');
    expect(text).toContain(expected);
    expect(text).not.toContain(session.user.id);
    await unmount(component);
    container.remove();
  }
});
