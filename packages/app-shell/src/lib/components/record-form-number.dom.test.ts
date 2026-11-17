import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { description } from '../../test/draft-fixtures.ts';
import type { Description } from '../ui/types.ts';
import RecordForm from './RecordForm.svelte';

const navigation = vi.hoisted(() => ({
  invalidate: vi.fn(async () => {}),
  goto: vi.fn(async () => {}),
}));
vi.mock('$app/navigation', () => navigation);

let component: ReturnType<typeof mount>;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

function withCount(required: boolean): Description {
  const base = description('draft');
  return {
    ...base,
    models: {
      ...base.models,
      Customer: {
        ...base.models.Customer,
        fields: {
          name: { type: 'text' },
          seats: { type: 'integer', required },
        },
        ownFields: ['name', 'seats'],
      },
    },
  };
}

function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit() {
  container.querySelector('form')?.requestSubmit();
  await tick();
  await new Promise((r) => setTimeout(r, 0));
}

function sentBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ id: 'row' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
  vi.unstubAllGlobals();
});

describe('number input in the record form', () => {
  it('creates a record with the typed number, including a required one', async () => {
    component = mount(RecordForm, {
      target: container,
      props: { model: 'Customer', description: withCount(true) },
    });
    await tick();
    const [name, seats] = [
      ...container.querySelectorAll<HTMLInputElement>('input'),
    ];
    expect(seats.type).toBe('number');
    type(name, 'Anna');
    type(seats, '12');
    await tick();
    await submit();
    expect(container.textContent).not.toContain('This field is required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody()).toMatchObject({ name: 'Anna', seats: 12 });
  });

  it('keeps an existing number when editing another field', async () => {
    component = mount(RecordForm, {
      target: container,
      props: {
        model: 'Customer',
        description: withCount(false),
        record: { id: 'row', name: 'Anna', seats: 7 },
      },
    });
    await tick();
    const [name, seats] = [
      ...container.querySelectorAll<HTMLInputElement>('input'),
    ];
    expect(seats.value).toBe('7');
    type(name, 'Anna B');
    await tick();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = sentBody();
    expect(body.name).toBe('Anna B');
    expect(body.seats === undefined || body.seats === 7).toBe(true);
  });

  it('saves an edited number', async () => {
    component = mount(RecordForm, {
      target: container,
      props: {
        model: 'Customer',
        description: withCount(false),
        record: { id: 'row', name: 'Anna', seats: 7 },
      },
    });
    await tick();
    const seats = container.querySelectorAll<HTMLInputElement>('input')[1];
    type(seats, '9');
    await tick();
    await submit();
    expect(sentBody()).toMatchObject({ seats: 9 });
  });
});
