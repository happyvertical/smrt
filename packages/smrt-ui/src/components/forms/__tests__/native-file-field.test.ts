/**
 * Native file-field posting strategies (smrt#3290).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignFileWithDataTransfer,
  attachFormDataFallback,
  attachFormResetListener,
  clearFileInput,
  detectNativeFileFieldStrategy,
  fileNameForType,
} from '../native-file-field.js';
import {
  submittedEntries,
  TestDataTransfer,
  TestFormDataEvent,
} from './capture-test-env.js';

function fileInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'file';
  return input;
}

const env = (overrides: Record<string, unknown>) => ({
  File,
  createFileInput: fileInput,
  ...overrides,
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('detectNativeFileFieldStrategy', () => {
  it('prefers DataTransfer when an input accepts its files', () => {
    expect(
      detectNativeFileFieldStrategy(
        env({
          DataTransfer: TestDataTransfer,
          FormDataEvent: TestFormDataEvent,
        }),
      ),
    ).toBe('data-transfer');
  });

  it('falls back to the formdata event without DataTransfer', () => {
    expect(
      detectNativeFileFieldStrategy(env({ FormDataEvent: TestFormDataEvent })),
    ).toBe('formdata-event');
  });

  it('falls back when the DataTransfer constructor throws (old engines)', () => {
    class IllegalConstructor {
      constructor() {
        throw new TypeError('Illegal constructor');
      }
    }
    expect(
      detectNativeFileFieldStrategy(
        env({
          DataTransfer: IllegalConstructor,
          FormDataEvent: TestFormDataEvent,
        }),
      ),
    ).toBe('formdata-event');
  });

  it('falls back when the input rejects the files assignment', () => {
    class PlainDataTransfer {
      items = { add: () => null };
      files = [] as unknown as FileList;
    }
    expect(
      detectNativeFileFieldStrategy(
        env({
          DataTransfer: PlainDataTransfer,
          FormDataEvent: TestFormDataEvent,
        }),
      ),
    ).toBe('formdata-event');
  });

  it('reports none when neither API exists, and during SSR', () => {
    expect(detectNativeFileFieldStrategy(env({}))).toBe('none');
    expect(detectNativeFileFieldStrategy({})).toBe('none');
  });
});

describe('assignFileWithDataTransfer / clearFileInput', () => {
  it('puts the file into the input so a native submit posts it, then clears it', () => {
    const form = document.createElement('form');
    const input = fileInput();
    input.name = 'photo';
    form.append(input);
    const file = new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' });

    expect(assignFileWithDataTransfer(input, file, TestDataTransfer)).toBe(
      true,
    );
    expect(new FormData(form).get('photo')).toBe(file);

    clearFileInput(input);
    const empty = new FormData(form).get('photo') as File;
    expect(empty.name).toBe('');
    expect(empty.size).toBe(0);
  });

  it('returns false without a DataTransfer constructor', () => {
    expect(
      assignFileWithDataTransfer(fileInput(), new File([], 'x'), undefined),
    ).toBe(false);
  });
});

describe('attachFormDataFallback', () => {
  it('appends the committed file to its own form only, until disposed', () => {
    const form = document.createElement('form');
    const other = document.createElement('form');
    document.body.append(form, other);
    const file = new File(['png'], 'signature.png', { type: 'image/png' });
    const dispose = attachFormDataFallback(document, () => ({
      form,
      name: 'signature',
      file,
    }));

    expect(submittedEntries(form).getAll('signature')).toEqual([file]);
    expect(submittedEntries(other).has('signature')).toBe(false);

    dispose();
    expect(submittedEntries(form).has('signature')).toBe(false);
  });

  it('posts the native empty-file entry when nothing is committed', () => {
    const form = document.createElement('form');
    document.body.append(form);
    attachFormDataFallback(document, () => ({
      form,
      name: 'photo',
      file: null,
    }));

    const entry = submittedEntries(form).get('photo') as File;
    expect(entry.name).toBe('');
    expect(entry.size).toBe(0);
    expect(entry.type).toBe('application/octet-stream');
  });

  it('contributes nothing when the entry is unavailable', () => {
    const form = document.createElement('form');
    document.body.append(form);
    const read = vi.fn(() => null);
    attachFormDataFallback(document, read);

    expect([...submittedEntries(form).keys()]).toEqual([]);
    expect(read).toHaveBeenCalled();
  });
});

describe('fileNameForType', () => {
  it('maps known image types and falls back to bin', () => {
    expect(fileNameForType('photo', 'image/jpeg')).toBe('photo.jpg');
    expect(fileNameForType('photo', 'image/png')).toBe('photo.png');
    expect(fileNameForType('photo', 'image/webp')).toBe('photo.webp');
    expect(fileNameForType('photo', 'image/heic')).toBe('photo.bin');
  });
});

describe('attachFormResetListener', () => {
  it('fires for the owning form only, read at dispatch time, until disposed', () => {
    document.body.innerHTML = '<form id="a"></form><form id="b"></form>';
    const a = document.getElementById('a') as HTMLFormElement;
    const b = document.getElementById('b') as HTMLFormElement;
    let owner: HTMLFormElement | null = a;
    const onReset = vi.fn();
    const dispose = attachFormResetListener(document, () => owner, onReset);

    b.reset();
    expect(onReset).not.toHaveBeenCalled();
    a.reset();
    expect(onReset).toHaveBeenCalledTimes(1);

    owner = b;
    b.reset();
    expect(onReset).toHaveBeenCalledTimes(2);
    owner = null;
    b.reset();
    expect(onReset).toHaveBeenCalledTimes(2);

    owner = a;
    dispose();
    a.reset();
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('is not hidden by a page listener that stops propagation', () => {
    document.body.innerHTML = '<form></form>';
    const form = document.querySelector('form') as HTMLFormElement;
    form.addEventListener('reset', (event) => event.stopPropagation());
    const onReset = vi.fn();
    const dispose = attachFormResetListener(document, () => form, onReset);

    form.reset();
    expect(onReset).toHaveBeenCalledTimes(1);
    dispose();
  });
});
