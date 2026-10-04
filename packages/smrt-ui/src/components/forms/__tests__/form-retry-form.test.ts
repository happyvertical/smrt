/**
 * `createFormRetry()` with smrt-ui's own `Form` (#3291, deferred on #3265).
 *
 * `Form` forwards Svelte attachments to its native `<form>` (#3265, shipped in
 * #3331), so the pairing is SvelteKit's `enhance` through `fromAction` with
 * the retry submit function, plus `retry.attach` for the hidden key field.
 * `enhance` is the structural fake from the form-retry tests, attached as the
 * real action and driven by real submit events; the action behind it records
 * rows the way `runOnce()` does.
 */
import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeEnhanceAction,
  fakeRunOnceServer,
} from '../form-retry/__tests__/fake-kit.js';
import { memoryStorage } from '../form-retry/__tests__/storage.js';
import { createFormRetry } from '../form-retry/controller.js';
import { resetFormRetryMemory } from '../form-retry/submission-key.js';
import FormRetryFormFixture from './form-retry-form.fixture.svelte';

beforeEach(() => {
  resetFormRetryMemory();
  sessionStorage.clear();
});

function setup() {
  const server = fakeRunOnceServer();
  const kit = fakeEnhanceAction(server);
  const retry = createFormRetry({ form: 'report', storage: memoryStorage() });
  const { container } = render(FormRetryFormFixture, {
    props: { enhance: kit.action, retry },
  });
  const form = container.querySelector('form') as HTMLFormElement;
  const title = screen.getByRole('textbox', { name: 'Title' });
  const send = async () => {
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  };
  const type = async (value: string) => {
    await fireEvent.input(title, { target: { value } });
  };
  return { server, kit, retry, form, title, send, type };
}

describe('createFormRetry with an enhanced smrt-ui Form', () => {
  it('keeps the key field inside Form and posts the key in the body', async () => {
    const { server, kit, retry, form, send, type } = setup();
    const token = retry.token;
    const fields = form.querySelectorAll<HTMLInputElement>(
      'input[name="submissionKey"]',
    );
    expect(fields).toHaveLength(1);
    expect(fields[0].value).toBe(token);

    await type('Hose');
    await send();
    await kit.settle();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].get('submissionKey')).toBe(token);
    expect(server.requests[0].get('title')).toBe('Hose');
  });

  it('refuses a double submit while the first is in flight', async () => {
    const { server, kit, retry, send, type } = setup();
    await type('Hose');
    const held = server.hold();
    await send();
    await vi.waitFor(() => expect(retry.state.status).toBe('submitting'));
    await send();
    expect(retry.state.status).toBe('busy');
    held.release();
    await kit.settle();
    expect(kit.enhanced.cancelled).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect(server.rows).toHaveLength(1);
  });

  it('retries a lost response under the same key, recording one row', async () => {
    const { server, kit, retry, title, send, type } = setup();
    await type('Hose');
    const token = retry.token;
    server.next('lost-response');
    await send();
    await kit.settle();
    expect(retry.state.status).toBe('transport-error');
    expect(kit.enhanced.unmounted).toBe(0);
    expect((title as HTMLInputElement).value).toBe('Hose');

    await send();
    await kit.settle();
    expect(server.requests.map((body) => body.get('submissionKey'))).toEqual([
      token,
      token,
    ]);
    expect(server.rows).toHaveLength(1);
  });

  it('resets on success only when the form is unchanged', async () => {
    const { server, kit, retry, title, send, type } = setup();
    await type('First');
    const token = retry.token;
    const held = server.hold();
    await send();
    await vi.waitFor(() => expect(retry.state.status).toBe('submitting'));
    await type('Second');
    held.release();
    await kit.settle();
    expect(retry.state.status).toBe('success');
    expect((title as HTMLInputElement).value).toBe('Second');
    expect(retry.token).toBe(token);

    await send();
    await kit.settle();
    expect(server.rows.map((row) => row.fields.title)).toEqual([
      ['First'],
      ['Second'],
    ]);
    expect((title as HTMLInputElement).value).toBe('');
    expect(retry.token).not.toBe(token);
  });
});
