/**
 * `createFormRetry()` end to end (#3291): a plain `<form method="POST">`
 * wired through a structural fake of SvelteKit's `use:enhance`, posting to a
 * fake action whose write is guarded by a `runOnce()`-style claim over
 * (submission key, content digest).
 *
 * The "Done when" cases of the issue: a double submit, a lost response, a
 * reload, a private window, and "typed the next entry before the first
 * resolved".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormRetry, type FormRetryOptions } from '../controller.js';
import { resetFormRetryMemory } from '../submission-key.js';
import type { FormRetrySubmitFunction } from '../types.js';
import { fakeEnhance, fakeRunOnceServer } from './fake-kit.js';
import { memoryStorage, refusingStorage } from './storage.js';

/**
 * `SubmitFunction` from `@sveltejs/kit` 2.70.3 (`types/index.d.ts`), copied
 * verbatim apart from inlining `ActionResult`, so this file proves the helper
 * is assignable to kit's contract without smrt-ui depending on kit.
 */
type KitActionResult =
  | { type: 'success'; status: number; data?: Record<string, any> }
  | { type: 'failure'; status: number; data?: Record<string, any> }
  | { type: 'redirect'; status: number; location: string }
  | { type: 'error'; status?: number; error: any };
type KitSubmitFunction = (input: {
  action: URL;
  formData: FormData;
  formElement: HTMLFormElement;
  controller: AbortController;
  submitter: HTMLElement | null;
  cancel: () => void;
}) =>
  | void
  | Promise<void>
  | ((opts: {
      formData: FormData;
      formElement: HTMLFormElement;
      action: URL;
      result: KitActionResult;
      update: (options?: {
        reset?: boolean;
        invalidateAll?: boolean;
      }) => Promise<void>;
    }) => void | Promise<void>)
  | Promise<
      | void
      | ((opts: {
          formData: FormData;
          formElement: HTMLFormElement;
          action: URL;
          result: KitActionResult;
          update: (options?: {
            reset?: boolean;
            invalidateAll?: boolean;
          }) => Promise<void>;
        }) => void | Promise<void>)
    >;

const FORM_HTML = `
  <input name="title" value="" />
  <input name="qty" value="" />
  <input type="file" name="photo" />
  <button type="submit">Send</button>
`;

function mountForm(html = FORM_HTML): HTMLFormElement {
  document.body.innerHTML = `<form method="POST">${html}</form>`;
  const form = document.body.querySelector('form');
  if (!form) throw new Error('no form');
  return form;
}

function fill(form: HTMLFormElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const control = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!control) throw new Error(`no ${name}`);
    control.value = value;
  }
}

const fieldValue = (form: HTMLFormElement, name: string) =>
  form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value;

function setup(options: Partial<FormRetryOptions> = {}, html?: string) {
  const form = mountForm(html);
  const server = fakeRunOnceServer();
  const retry = createFormRetry({ form: 'report', ...options });
  const detach = retry.attach(form);
  const kit = fakeEnhance(form, retry.enhance(), server);
  return { form, server, retry, kit, detach };
}

beforeEach(() => {
  resetFormRetryMemory();
  sessionStorage.clear();
});

describe('the SvelteKit contract', () => {
  it('is assignable to kit’s SubmitFunction without importing kit', () => {
    const retry = createFormRetry({ form: 'report', storage: null });
    const asKit: KitSubmitFunction = retry.enhance();
    const inner: KitSubmitFunction = () => {};
    const composed: KitSubmitFunction = retry.enhance(
      inner as FormRetrySubmitFunction,
    );
    expect(typeof asKit).toBe('function');
    expect(typeof composed).toBe('function');
  });
});

describe('a double submit', () => {
  it('sends once: the second activation is refused while the first is in flight', async () => {
    const { form, server, retry, kit } = setup({ storage: memoryStorage() });
    fill(form, { title: 'Hose', qty: '1' });
    const held = server.hold();
    const first = kit.submit();
    await vi.waitFor(() => expect(retry.state.status).toBe('submitting'));
    await kit.submit();
    expect(kit.cancelled).toBe(1);
    expect(retry.state.status).toBe('busy');
    held.release();
    await first;
    expect(server.requests).toHaveLength(1);
    expect(server.rows).toHaveLength(1);
    expect(retry.state.status).toBe('success');
  });

  it('puts the key in the body even when the hidden field is stale', async () => {
    const { form, server, retry, kit } = setup({ storage: memoryStorage() });
    const hidden = form.querySelector<HTMLInputElement>('[name=submissionKey]');
    expect(hidden?.type).toBe('hidden');
    expect(hidden?.value).toBe(retry.token);
    if (hidden) hidden.value = 'tampered';
    const token = retry.token;
    fill(form, { title: 'Hose' });
    await kit.submit();
    expect(server.requests[0].get('submissionKey')).toBe(token);
  });
});

describe('a lost response', () => {
  it('keeps the form, the key and the mount; the unchanged retry records ONE row', async () => {
    const { form, server, retry, kit } = setup({ storage: memoryStorage() });
    fill(form, { title: 'Hose', qty: '1' });
    const token = retry.token;
    server.next('lost-response');
    await kit.submit();

    expect(server.rows).toHaveLength(1);
    expect(retry.state.status).toBe('transport-error');
    // update() was not called: in kit it would apply the error and unmount.
    expect(kit.updates).toHaveLength(0);
    expect(kit.unmounted).toBe(0);
    expect(fieldValue(form, 'title')).toBe('Hose');
    expect(retry.token).toBe(token);

    await kit.submit();
    expect(server.requests).toHaveLength(2);
    expect(server.rows).toHaveLength(1);
    expect(retry.state.status).toBe('success');
    // Confirmed and unchanged: reset, and the next fill gets a new key.
    expect(fieldValue(form, 'title')).toBe('');
    expect(retry.token).not.toBe(token);
    expect(fieldValue(form, 'submissionKey')).toBe(retry.token);
  });

  it('a retry with DIFFERENT content is a new submission, never the old claim (#3136)', async () => {
    const { form, server, kit } = setup({ storage: memoryStorage() });
    fill(form, { title: 'Hose', qty: '1' });
    server.next('lost-response');
    await kit.submit();
    fill(form, { qty: '2' });
    await kit.submit();
    expect(server.rows.map((row) => row.fields.qty)).toEqual([['1'], ['2']]);
  });

  it('an unreachable server writes nothing; the retry writes once', async () => {
    const { form, server, retry, kit } = setup({ storage: memoryStorage() });
    fill(form, { title: 'Hose' });
    server.next('unreachable');
    await kit.submit();
    expect(server.rows).toHaveLength(0);
    expect(retry.state.status).toBe('transport-error');
    await kit.submit();
    expect(server.rows).toHaveLength(1);
  });

  it('an aborted request settles like a transport error instead of wedging the form', async () => {
    const { form, server, retry, kit } = setup({ storage: memoryStorage() });
    fill(form, { title: 'Hose' });
    const token = retry.token;
    const held = server.hold();
    const pending = kit.submit();
    await vi.waitFor(() => expect(kit.controllers).toHaveLength(1));
    kit.controllers[0].abort();
    held.release();
    await pending;
    expect(retry.state).toMatchObject({
      status: 'transport-error',
      inFlight: null,
    });
    expect(retry.token).toBe(token);
    await kit.submit();
    expect(server.rows).toHaveLength(1);
  });
});

describe('a validation failure', () => {
  it('keeps the key and the typed values; the corrected submit carries the same key', async () => {
    const storage = memoryStorage();
    const { form, server, retry, kit } = setup({
      storage,
      restore: { owner: 'person-1' },
    });
    fill(form, { title: 'Hose' });
    const token = retry.token;
    server.next('fail');
    await kit.submit();
    expect(retry.state.status).toBe('failure');
    expect(fieldValue(form, 'title')).toBe('Hose');
    expect(retry.token).toBe(token);
    // Nothing was recorded, so nothing is kept for a reload.
    expect(storage.store.has('smrt:form-retry:report:draft')).toBe(false);
    await kit.submit();
    expect(server.requests[1].get('submissionKey')).toBe(token);
  });
});

describe('typed the next entry before the first resolved', () => {
  it('keeps the new entry, refuses to send it early, and records it as its own submission', async () => {
    const { form, server, retry, kit } = setup({ storage: memoryStorage() });
    fill(form, { title: 'First', qty: '1' });
    const token = retry.token;
    const held = server.hold();
    const first = kit.submit();
    await vi.waitFor(() => expect(retry.state.status).toBe('submitting'));

    // The person moves on while the first is still in flight.
    fill(form, { title: 'Second', qty: '2' });
    await kit.submit();
    expect(retry.state.status).toBe('busy');

    held.release();
    await first;
    expect(retry.state.status).toBe('success');
    // Not reset: the typed second entry is still there.
    expect(kit.updates).toEqual([{ reset: false }]);
    expect(fieldValue(form, 'title')).toBe('Second');
    // The form still shows content, so the key is kept (see settleSubmit).
    expect(retry.token).toBe(token);

    await kit.submit();
    expect(server.rows.map((row) => row.fields.title)).toEqual([
      ['First'],
      ['Second'],
    ]);
    expect(fieldValue(form, 'title')).toBe('');
    expect(retry.token).not.toBe(token);
  });
});

describe('a reload', () => {
  it('keeps the key across a reload even without restore', async () => {
    const storage = memoryStorage();
    const before = createFormRetry({ form: 'report', storage });
    resetFormRetryMemory();
    const after = createFormRetry({ form: 'report', storage });
    expect(after.token).toBe(before.token);
    expect(after.state.persistent).toBe(true);
  });

  it('restores what was submitted so the retry is byte-identical — ONE row', async () => {
    const storage = memoryStorage();
    let captured = 'capture-1';
    const restoredValues: unknown[] = [];
    const options: Partial<FormRetryOptions> = {
      storage,
      restore: {
        owner: 'tenant:person-1',
        values: {
          capture: () => ({ captured }),
          restore: (value) => restoredValues.push(value),
        },
      },
    };
    const first = setup(options);
    fill(first.form, { title: 'Hose', qty: '3' });
    first.server.next('lost-response');
    await first.kit.submit();
    expect(first.server.rows).toHaveLength(1);
    const token = first.retry.token;

    // Full reload: a fresh document, fresh module memory, same tab storage.
    first.detach();
    resetFormRetryMemory();
    captured = 'never-read';
    const form = mountForm();
    const retry = createFormRetry({ form: 'report', ...options });
    expect(retry.token).toBe(token);
    expect(retry.state.restored).toBe(true);
    expect(restoredValues).toEqual([{ captured: 'capture-1' }]);
    expect(retry.restored?.fields).toEqual([
      ['title', 'Hose'],
      ['qty', '3'],
    ]);
    retry.attach(form);
    expect(fieldValue(form, 'title')).toBe('Hose');
    expect(fieldValue(form, 'qty')).toBe('3');

    const kit = fakeEnhance(form, retry.enhance(), first.server);
    await kit.submit();
    expect(first.server.rows).toHaveLength(1);
    expect(retry.state).toMatchObject({ status: 'success', restored: false });
    expect(storage.store.has('smrt:form-retry:report:draft')).toBe(false);
  });

  it('never restores for a different person on the same tab', async () => {
    const storage = memoryStorage();
    const first = setup({ storage, restore: { owner: 'person-1' } });
    fill(first.form, { title: 'Private' });
    first.server.next('lost-response');
    await first.kit.submit();
    resetFormRetryMemory();
    const retry = createFormRetry({
      form: 'report',
      storage,
      restore: { owner: 'person-2' },
    });
    expect(retry.restored).toBeNull();
    expect(storage.store.has('smrt:form-retry:report:draft')).toBe(false);
  });

  it('never stores a draft without an owner, and clears a stale one', async () => {
    const storage = memoryStorage();
    storage.store.set('smrt:form-retry:report:draft', '{"stale":true}');
    const { form, server, kit } = setup({ storage, restore: { owner: '' } });
    fill(form, { title: 'Private' });
    server.next('lost-response');
    await kit.submit();
    expect(storage.store.has('smrt:form-retry:report:draft')).toBe(false);
  });

  it('never restores a draft older than maxAgeMs', async () => {
    const storage = memoryStorage();
    let now = new Date('2026-10-01T08:00:00Z');
    const options: Partial<FormRetryOptions> = {
      storage,
      now: () => now,
      restore: { owner: 'person-1', maxAgeMs: 60_000 },
    };
    const first = setup(options);
    fill(first.form, { title: 'Old' });
    first.server.next('lost-response');
    await first.kit.submit();
    resetFormRetryMemory();
    now = new Date('2026-10-01T08:02:00Z');
    expect(createFormRetry({ form: 'report', ...options }).restored).toBeNull();
  });

  it('reports a file that must be chosen again instead of submitting without it', async () => {
    const storage = memoryStorage();
    const options: Partial<FormRetryOptions> = {
      storage,
      restore: { owner: 'person-1' },
    };
    const first = setup(options);
    fill(first.form, { title: 'With photo' });
    first.server.next('lost-response');
    const photo = () => new File(['abc'], 'a.jpg', { type: 'image/jpeg' });
    await first.kit.submit((data) => data.set('photo', photo()));
    expect(first.server.rows).toHaveLength(1);

    resetFormRetryMemory();
    const form = mountForm();
    const retry = createFormRetry({ form: 'report', ...options });
    retry.attach(form);
    expect(retry.state.filesToReselect).toEqual(['photo']);
    expect(retry.restored?.files).toEqual([
      { field: 'photo', name: 'a.jpg', type: 'image/jpeg', size: 3 },
    ]);

    const kit = fakeEnhance(form, retry.enhance(), first.server);
    await kit.submit();
    expect(kit.cancelled).toBe(1);
    expect(retry.state).toMatchObject({
      status: 'files-required',
      filesToReselect: ['photo'],
      inFlight: null,
    });
    expect(first.server.requests).toHaveLength(1);

    // The same file chosen again: same name, type and size, so the same digest
    // and the same claim.
    await kit.submit((data) => data.set('photo', photo()));
    expect(first.server.rows).toHaveLength(1);
    expect(retry.state).toMatchObject({
      status: 'success',
      filesToReselect: [],
    });
  });

  it('never writes a password or an excluded field to storage', async () => {
    const storage = memoryStorage();
    const { form, server, kit } = setup(
      { storage, restore: { owner: 'person-1', exclude: ['card'] } },
      `<input name="title" /><input type="password" name="pin" /><input name="card" />`,
    );
    fill(form, { title: 'T', pin: '1234', card: '4111' });
    server.next('lost-response');
    await kit.submit();
    const raw = storage.store.get('smrt:form-retry:report:draft') ?? '';
    expect(raw).toContain('"title"');
    expect(raw).not.toContain('1234');
    expect(raw).not.toContain('4111');
    expect(raw).not.toContain('submissionKey');
  });

  it('a values hook that rejects the stored value discards the whole draft', async () => {
    const storage = memoryStorage();
    const restore = {
      owner: 'person-1',
      values: {
        capture: () => ({ keys: ['k-1'] }),
        restore: () => {
          throw new Error('not a valid capture');
        },
      },
    };
    const first = setup({ storage, restore });
    fill(first.form, { title: 'Hose' });
    first.server.next('lost-response');
    await first.kit.submit();
    resetFormRetryMemory();
    const retry = createFormRetry({ form: 'report', storage, restore });
    expect(retry.restored).toBeNull();
    expect(retry.state.restored).toBe(false);
    expect(storage.store.has('smrt:form-retry:report:draft')).toBe(false);
  });

  it('discard() abandons the restored fill: draft dropped, key rotated', async () => {
    const storage = memoryStorage();
    const first = setup({ storage, restore: { owner: 'person-1' } });
    fill(first.form, { title: 'Hose' });
    first.server.next('lost-response');
    await first.kit.submit();
    resetFormRetryMemory();
    const retry = createFormRetry({
      form: 'report',
      storage,
      restore: { owner: 'person-1' },
    });
    const token = retry.token;
    retry.discard();
    expect(retry.token).not.toBe(token);
    expect(retry.restored).toBeNull();
    expect(retry.state).toMatchObject({ restored: false, status: 'idle' });
    expect(storage.store.has('smrt:form-retry:report:draft')).toBe(false);
  });
});

describe('a private window (storage throws)', () => {
  it('still sends one claim per fill, and the key survives a remount', async () => {
    const storage = refusingStorage();
    const { form, server, retry, kit, detach } = setup({
      storage,
      restore: { owner: 'person-1' },
    });
    expect(retry.state.persistent).toBe(false);
    fill(form, { title: 'Hose' });
    const token = retry.token;
    server.next('lost-response');
    await kit.submit();

    // `enhance`'s error path remounts the component: same page, same memory.
    detach();
    const remounted = createFormRetry({ form: 'report', storage });
    expect(remounted.token).toBe(token);
    const remountedKit = fakeEnhance(form, remounted.enhance(), server);
    await remountedKit.submit();
    expect(server.rows).toHaveLength(1);
    expect(remounted.state.status).toBe('success');
  });

  it('works when the sessionStorage property itself throws', async () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      'sessionStorage',
    );
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      const { form, server, retry, kit } = setup();
      fill(form, { title: 'Hose' });
      server.next('lost-response');
      await kit.submit();
      await kit.submit();
      expect(server.rows).toHaveLength(1);
      expect(retry.state.status).toBe('success');
    } finally {
      if (original)
        Object.defineProperty(globalThis, 'sessionStorage', original);
    }
  });
});

describe('redirects', () => {
  it('keep the key and the draft by default — a redirect cannot vouch for a write', async () => {
    const storage = memoryStorage();
    const { form, server, retry, kit } = setup({
      storage,
      restore: { owner: 'p' },
    });
    fill(form, { title: 'Hose' });
    const token = retry.token;
    server.next('redirect');
    await kit.submit();
    expect(retry.state.status).toBe('redirect');
    expect(retry.token).toBe(token);
    expect(storage.store.has('smrt:form-retry:report:draft')).toBe(true);
    expect(kit.applied).toEqual(['redirect']);
  });

  it('rotate with redirectConfirmsWrite', async () => {
    const storage = memoryStorage();
    const { form, server, retry, kit } = setup({
      storage,
      redirectConfirmsWrite: true,
      restore: { owner: 'p' },
    });
    fill(form, { title: 'Hose' });
    const token = retry.token;
    server.next('redirect');
    await kit.submit();
    expect(retry.state.status).toBe('redirect');
    expect(retry.token).not.toBe(token);
    expect(storage.store.has('smrt:form-retry:report:draft')).toBe(false);
  });
});

describe('composing with the page’s own submit function', () => {
  it('runs it after the gate with the key in formData, and hands it the safe reset', async () => {
    const form = mountForm();
    const server = fakeRunOnceServer();
    const retry = createFormRetry({ form: 'report', storage: memoryStorage() });
    retry.attach(form);
    const seen: Array<string | null> = [];
    const resets: Array<boolean | undefined> = [];
    const kit = fakeEnhance(
      form,
      retry.enhance(({ formData }) => {
        seen.push(formData.get('submissionKey') as string | null);
        return async ({ update }) => {
          await update();
          resets.push(kit.updates.at(-1)?.reset);
        };
      }),
      server,
    );
    fill(form, { title: 'Hose' });
    await kit.submit();
    expect(seen).toEqual([server.requests[0].get('submissionKey')]);
    expect(resets).toEqual([true]);
  });

  it('releases the slot when the page cancels or throws', async () => {
    const form = mountForm();
    const server = fakeRunOnceServer();
    const retry = createFormRetry({ form: 'report', storage: memoryStorage() });
    let mode: 'cancel' | 'throw' | 'send' = 'cancel';
    const kit = fakeEnhance(
      form,
      retry.enhance(({ cancel }) => {
        if (mode === 'cancel') cancel();
        if (mode === 'throw') throw new Error('page bug');
      }),
      server,
    );
    await kit.submit();
    expect(retry.state).toMatchObject({ status: 'idle', inFlight: null });
    mode = 'throw';
    await expect(kit.submit()).rejects.toThrow('page bug');
    expect(retry.state).toMatchObject({ status: 'idle', inFlight: null });
    mode = 'send';
    await kit.submit();
    expect(server.requests).toHaveLength(1);
  });
});

describe('the store contract and the attachment', () => {
  it('notifies subscribers now and on every change, until unsubscribed', async () => {
    const { form, retry, kit } = setup({ storage: memoryStorage() });
    const statuses: string[] = [];
    const unsubscribe = retry.subscribe((state) => statuses.push(state.status));
    fill(form, { title: 'Hose' });
    await kit.submit();
    unsubscribe();
    await kit.submit();
    expect(statuses).toEqual(['idle', 'submitting', 'success']);
  });

  it('keeps one hidden key field in sync, and stops when detached', async () => {
    const { form, retry, kit, detach } = setup({ storage: memoryStorage() });
    const fields = () =>
      Array.from(
        form.querySelectorAll<HTMLInputElement>('[name=submissionKey]'),
      );
    expect(fields().map((field) => field.value)).toEqual([retry.token]);
    fill(form, { title: 'Hose' });
    await kit.submit();
    expect(fields().map((field) => field.value)).toEqual([retry.token]);
    detach();
    const stale = retry.token;
    fill(form, { title: 'Again' });
    await kit.submit();
    expect(fields()[0].value).toBe(stale);
  });

  it('reuses a hidden field the page rendered, and works as a use: action', () => {
    const form = mountForm(
      '<input type="hidden" name="key" value="server-rendered" /><input name="title" />',
    );
    const retry = createFormRetry({
      form: 'report',
      fieldName: 'key',
      storage: memoryStorage(),
    });
    const handle = retry.action(form);
    const fields = form.querySelectorAll<HTMLInputElement>('[name=key]');
    expect(fields).toHaveLength(1);
    expect(fields[0].value).toBe(retry.token);
    handle.destroy();
  });
});
