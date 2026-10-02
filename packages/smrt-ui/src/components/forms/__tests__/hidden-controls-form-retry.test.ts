/**
 * `createFormRetry()` around #3331's choice controls (#3291). `Listbox`,
 * `Combobox` and `MultiSelect` post their selection through hidden inputs, so
 * the "unchanged since submit" check must compare hidden inputs too — every
 * one except the retry helper's own key field, which rotates by design.
 *
 * A selection changed while a submit is in flight was never sent: the success
 * must keep it (and its key), and the next submit must post it.
 */
import { render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeEnhance,
  fakeRunOnceServer,
} from '../form-retry/__tests__/fake-kit.js';
import { memoryStorage } from '../form-retry/__tests__/storage.js';
import { createFormRetry } from '../form-retry/controller.js';
import { resetFormRetryMemory } from '../form-retry/submission-key.js';
import HiddenControlsForm from './hidden-controls-form.fixture.svelte';

beforeEach(() => {
  resetFormRetryMemory();
  sessionStorage.clear();
});

function setup() {
  const view = render(HiddenControlsForm);
  const form = view.container.querySelector('form') as HTMLFormElement;
  const server = fakeRunOnceServer();
  const retry = createFormRetry({ form: 'choices', storage: memoryStorage() });
  retry.attach(form);
  const kit = fakeEnhance(form, retry.enhance(), server);
  const title = form.querySelector('[name=title]') as HTMLInputElement;
  title.value = 'Hose';
  return { ...view, form, server, retry, kit, title };
}

const posted = (body: FormData, name: string) => body.getAll(name);

describe('hidden-input-backed controls under createFormRetry', () => {
  it.each([
    ['Listbox', 'listbox', 'b'],
    ['Combobox', 'combobox', 'b'],
    ['MultiSelect', 'multi', ['a', 'b']],
  ] as const)('a %s change during an in-flight submit survives the success', async (_name, prop, next) => {
    const { form, server, retry, kit, rerender } = setup();
    const token = retry.token;
    const field = prop;
    const before = posted(new FormData(form), field);
    const held = server.hold();
    const first = kit.submit();
    await vi.waitFor(() => expect(retry.state.status).toBe('submitting'));

    await rerender({ [prop]: next });
    const changed = posted(new FormData(form), field);
    expect(changed).not.toEqual(before);

    held.release();
    await first;
    expect(retry.state.status).toBe('success');
    expect(kit.updates).toEqual([{ reset: false }]);
    expect(posted(new FormData(form), field)).toEqual(changed);
    expect(retry.token).toBe(token);

    await kit.submit();
    expect(posted(server.requests[0], field)).toEqual(before);
    expect(posted(server.requests[1], field)).toEqual(changed);
    expect(server.rows).toHaveLength(2);
  });

  it('still resets when only the key field changed', async () => {
    const { form, retry, kit, title } = setup();
    const token = retry.token;
    await kit.submit();
    expect(kit.updates).toEqual([{ reset: true }]);
    expect(title.value).toBe('');
    expect(retry.token).not.toBe(token);
    expect(
      (form.querySelector('[name=submissionKey]') as HTMLInputElement).value,
    ).toBe(retry.token);
  });
});
