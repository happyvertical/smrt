/**
 * FileUpload native-form wiring (#3260).
 *
 * jsdom has no `DataTransfer` constructor, so these tests cover attribute
 * forwarding, the visually-hidden (not `hidden`) input, the required-error
 * announcement, and the no-DataTransfer fallback. The DataTransfer path and the
 * `new FormData(form)` post are proven in a real browser by
 * `e2e/file-upload.spec.ts`; the form-reset cases below also run the mirror
 * against a jsdom `DataTransfer` stand-in.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileUpload from '../FileUpload.svelte';
import FileUploadResetFixture from './FileUploadReset.fixture.svelte';

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input;
}

const txt = (name: string, size = 4) =>
  new File(['a'.repeat(size)], name, { type: 'text/plain' });

describe('FileUpload — native form wiring', () => {
  it('forwards name, capture and required to the file input', () => {
    const { container } = render(FileUpload, {
      props: { name: 'photo', capture: 'environment', required: true },
    });
    const input = fileInput(container);
    expect(input).toHaveAttribute('name', 'photo');
    expect(input).toHaveAttribute('capture', 'environment');
    expect(input).toBeRequired();
  });

  it('omits name, capture and required by default', () => {
    const { container } = render(FileUpload);
    const input = fileInput(container);
    expect(input).not.toHaveAttribute('name');
    expect(input).not.toHaveAttribute('capture');
    expect(input).not.toBeRequired();
  });

  it('keeps the input focusable for native validation but out of the a11y tree and tab order', () => {
    const { container } = render(FileUpload, { props: { required: true } });
    const input = fileInput(container);
    // `hidden` would make the control unfocusable, so the browser could not
    // show its required bubble and would silently block the submit.
    expect(input).not.toHaveAttribute('hidden');
    expect(input).toHaveClass('file-upload__input');
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveAttribute('tabindex', '-1');
    // Not nested inside the role="button" drop zone (nested-interactive).
    expect(screen.getByRole('button').contains(input)).toBe(false);
  });

  it('announces a failed required check through the error live region', async () => {
    const { container } = render(FileUpload, { props: { required: true } });
    const input = fileInput(container);
    expect(input.checkValidity()).toBe(false);
    await fireEvent(input, new Event('invalid'));
    expect(screen.getByRole('alert').textContent?.trim()).not.toBe('');
  });

  it('is axe-clean with name, capture and required', async () => {
    const { container } = render(FileUpload, {
      props: {
        label: 'Mill cert photo',
        name: 'photo',
        capture: 'environment',
        required: true,
      },
    });
    await expectNoA11yViolations(container);
  });
});

describe('FileUpload — fallback without the DataTransfer constructor', () => {
  it('runs in an environment without DataTransfer', () => {
    expect(typeof (globalThis as { DataTransfer?: unknown }).DataTransfer).toBe(
      'undefined',
    );
  });

  it('keeps the native selection when it matches the accepted list', async () => {
    const { container } = render(FileUpload, { props: { name: 'doc' } });
    const input = fileInput(container);
    await userEvent.upload(input, txt('a.txt'));
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(input.files).toHaveLength(1);
    expect(input.files?.[0].name).toBe('a.txt');
  });

  it('clears the input when a file is removed, so it never posts', async () => {
    const { container } = render(FileUpload, { props: { name: 'doc' } });
    const input = fileInput(container);
    await userEvent.upload(input, txt('a.txt'));
    await userEvent.click(
      screen.getByRole('button', { name: /remove a\.txt/i }),
    );
    expect(input.files).toHaveLength(0);
  });

  it('clears the input when the pick is rejected, so it never posts', async () => {
    const { container } = render(FileUpload, {
      props: { name: 'doc', maxSize: 1 },
    });
    const input = fileInput(container);
    await userEvent.upload(input, txt('big.txt'));
    expect(screen.queryByText('big.txt')).not.toBeInTheDocument();
    expect(input.files).toHaveLength(0);
  });

  it('clears the input when an accumulated list no longer matches it', async () => {
    const { container } = render(FileUpload, {
      props: { name: 'doc', multiple: true },
    });
    const input = fileInput(container);
    await userEvent.upload(input, txt('a.txt'));
    await userEvent.upload(input, txt('b.txt'));
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
    expect(input.files).toHaveLength(0);
  });
});

/**
 * A real jsdom `FileList` holding `files`: jsdom's `input.files` setter only
 * accepts genuine instances and has no constructor, so the list comes from a
 * detached input and is filled through its implementation object (mirrors
 * smrt-ui's capture test environment).
 */
function createFileList(files: File[]): FileList {
  const implOf = <T>(wrapper: object, guard: (v: unknown) => boolean): T => {
    const holder = wrapper as Record<symbol, unknown>;
    const key = Object.getOwnPropertySymbols(wrapper).find((s) =>
      guard(holder[s]),
    );
    if (!key) throw new Error('jsdom wrapper has no implementation symbol');
    return holder[key] as T;
  };
  const list = document.createElement('input');
  list.type = 'file';
  const fileList = list.files as FileList;
  const impl = implOf<unknown[]>(fileList, Array.isArray);
  for (const file of files) {
    impl.push(implOf(file, (v) => typeof v === 'object' && v !== null));
  }
  return fileList;
}

/** Browser-shaped `DataTransfer` for jsdom: `items.add()` plus a real `files`. */
class TestDataTransfer {
  readonly #files: File[] = [];
  readonly items = {
    add: (file: File) => {
      this.#files.push(file);
      return null;
    },
  };
  get files(): FileList {
    return createFileList(this.#files);
  }
}

/**
 * A reset of the owning form (#3260): SvelteKit `enhance`'s `update()` after a
 * success, `createFormRetry()`'s conditional reset, a reset button and
 * `form.reset()` all empty a native file input, so the list must empty with
 * it. jsdom's reset does not empty file inputs (browsers do), so these
 * assertions prove the component empties its own input.
 */
describe.each([
  ['the DataTransfer mirror', true],
  ['the no-DataTransfer fallback', false],
])('FileUpload — form reset with %s', (_label, withDataTransfer) => {
  beforeEach(() => {
    if (withDataTransfer) vi.stubGlobal('DataTransfer', TestDataTransfer);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mount(props: Record<string, unknown> = {}) {
    const onchange = vi.fn();
    const result = render(FileUploadResetFixture, {
      props: { onchange, ...props },
    });
    const form = result.container.querySelector('form') as HTMLFormElement;
    const bound = () => screen.getByTestId('bound').getAttribute('data-files');
    return {
      ...result,
      form,
      onchange,
      bound,
      input: fileInput(result.container),
    };
  }

  async function pick(input: HTMLInputElement, files: File[]) {
    input.files = createFileList(files);
    await fireEvent.change(input);
  }

  /** Names of the non-empty `doc` entries a native submit would post. */
  const posted = (form: HTMLFormElement) =>
    (new FormData(form).getAll('doc') as File[])
      .filter((file) => file.name !== '')
      .map((file) => file.name);

  it('form.reset() empties the list, its error and what posts', async () => {
    const { form, input, onchange, bound } = mount({ maxSize: 10 });
    await pick(input, [txt('a.txt'), txt('big.txt', 50)]);
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(bound()).toBe('a.txt');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    if (withDataTransfer) expect(posted(form)).toEqual(['a.txt']);

    form.reset();
    await tick();
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onchange).toHaveBeenLastCalledWith([]);
    expect(bound()).toBe('');
    expect(input.files).toHaveLength(0);
    expect(posted(form)).toEqual([]);

    // The next pick posts alone; the reset list is never re-mirrored.
    await pick(input, [txt('b.txt')]);
    expect(screen.getByText('b.txt')).toBeInTheDocument();
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
    expect(posted(form)).toEqual(['b.txt']);
  });

  it('a reset button empties the list and required blocks again', async () => {
    const { form, input } = mount({ required: true });
    await pick(input, [txt('a.txt')]);
    expect(input.checkValidity()).toBe(true);

    await fireEvent.click(screen.getByRole('button', { name: 'Reset form' }));
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
    expect(posted(form)).toEqual([]);
    expect(input.validity.valueMissing).toBe(true);
  });

  it('empties the list even while disabled, as it empties a disabled input', async () => {
    const { form, input, rerender, bound } = mount();
    await pick(input, [txt('a.txt')]);
    await rerender({ disabled: true });
    expect(screen.getByText('a.txt')).toBeInTheDocument();

    form.reset();
    await tick();
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
    expect(bound()).toBe('');
    expect(input.files).toHaveLength(0);
  });

  it('does not report an empty list that was already empty', async () => {
    const { form, onchange } = mount();
    form.reset();
    await tick();
    expect(onchange).not.toHaveBeenCalled();
  });

  it('ignores the reset of another form', async () => {
    const { input, onchange } = mount();
    await pick(input, [txt('a.txt')]);
    onchange.mockClear();
    const other = document.createElement('form');
    document.body.append(other);

    other.reset();
    await tick();
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(onchange).not.toHaveBeenCalled();
  });
});
