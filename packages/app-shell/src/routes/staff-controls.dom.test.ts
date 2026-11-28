// Staff see only the controls their grants allow (#5197 S5, jsdom). The
// record routes still decide; this hides what they would refuse.
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordList from '../lib/components/RecordList.svelte';
import type { Description, RecordRow } from '../lib/ui/types.ts';
import { description } from '../test/draft-fixtures.ts';
import RecordPage from './m/[model]/[id]/+page.svelte';
import NewPage from './m/[model]/new/+page.svelte';

vi.mock('$app/navigation', () => ({
  invalidate: vi.fn(async () => {}),
  goto: vi.fn(async () => {}),
}));

let container: HTMLDivElement;
let component: ReturnType<typeof mount>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
});

const row: RecordRow = { id: 'c1', name: 'Ada' };
function app(
  staff: boolean,
  access?: { read: boolean; create: boolean; update: boolean },
): Description {
  const d = description('live');
  d.models = {
    Customer: {
      ...d.models.Customer,
      label: 'Customers',
      fields: { name: { type: 'text' } },
      methods: {},
    },
  };
  if (staff) {
    d.staff = true;
    d.access = access ? { Customer: access } : {};
  }
  return d;
}
const hasButton = (label: string) =>
  [...container.querySelectorAll('button')].some((b) =>
    (b.textContent ?? '').trim().startsWith(label),
  );
const text = () => container.textContent ?? '';
const list = (d: Description, rows: RecordRow[] = [row]) => {
  component = mount(RecordList, {
    target: container,
    props: { model: 'Customer', description: d, rows },
  });
};

describe('staff controls', () => {
  it('the owner sees New, Edit and Delete', async () => {
    list(app(false));
    await tick();
    expect(text()).toContain('Edit');
    expect(hasButton('Delete')).toBe(true);
  });

  it('read-only staff see no Edit, Delete or New', async () => {
    list(app(true, { read: true, create: false, update: false }));
    await tick();
    expect(text()).toContain('Ada');
    expect(text()).not.toContain('Edit');
    expect(hasButton('Delete')).toBe(false);
    unmount(component);
    list(app(true, { read: true, create: false, update: false }), []);
    await tick();
    expect(text()).not.toContain('New customer');
  });

  it('staff with create and update see Edit and New, never Delete', async () => {
    const d = app(true, { read: true, create: true, update: true });
    list(d);
    await tick();
    expect(text()).toContain('Edit');
    expect(hasButton('Delete')).toBe(false);
    unmount(component);
    list(d, []);
    await tick();
    expect(text()).toContain('New customer');
  });

  it('a staff description with no entry for the model is closed', async () => {
    list(app(true));
    await tick();
    expect(text()).not.toContain('Edit');
  });

  it('the record page has no Edit or Delete for read-only staff', async () => {
    component = mount(RecordPage, {
      target: container,
      props: {
        data: {
          description: app(true, { read: true, create: false, update: false }),
          model: 'Customer',
          record: row,
          references: {},
          related: [],
          relatedReferences: {},
        },
      } as never,
    });
    await tick();
    expect(container.querySelector('dl')?.textContent).toContain('Ada');
    expect(
      [...container.querySelectorAll('button')].map((b) =>
        b.textContent?.trim(),
      ),
    ).not.toContain('Edit');
    expect(
      [...container.querySelectorAll('button')].map((b) =>
        b.textContent?.trim(),
      ),
    ).not.toContain('Delete');
  });

  it('the new page shows no form to staff without create', async () => {
    component = mount(NewPage, {
      target: container,
      props: {
        data: {
          description: app(true, { read: true, create: false, update: false }),
          model: 'Customer',
          references: {},
          prefill: {},
          returnTo: null,
        },
      } as never,
    });
    await tick();
    expect(container.querySelector('form')).toBeNull();
    expect(text()).toContain('not add');
  });
});
