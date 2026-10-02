/**
 * The restore-after-reload draft (#3291): restored only under the key it was
 * submitted with, only for the owner who submitted it, only while fresh, only
 * when well-formed — and never at the cost of a thrown storage error.
 */

import { describe, expect, it } from 'vitest';
import type { FormRetryStorage } from '../submission-key.js';
import {
  applyDraftToForm,
  clearSubmittedDraft,
  describeFormData,
  readSubmittedDraft,
  saveSubmittedDraft,
} from '../submitted-draft.js';
import { memoryStorage, refusingStorage, stickyStorage } from './storage.js';

const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'tenant-1:person-1';
const NAME = 'smrt:form-retry:report:draft';
const ALWAYS = () => true;
const SAVED_AT = new Date('2026-10-01T12:00:00Z');

function save(storage: FormRetryStorage, owner = OWNER) {
  saveSubmittedDraft(storage, NAME, {
    token: TOKEN,
    owner,
    savedAt: SAVED_AT,
    fields: [
      ['title', 'Trip over a hose'],
      ['qty', '1'],
      ['qty', '2'],
    ],
    files: [{ field: 'photo', name: 'a.jpg', type: 'image/jpeg', size: 3 }],
    values: { captureKey: 'k-1' },
  });
}

describe('saveSubmittedDraft / readSubmittedDraft', () => {
  it('restores exactly what was submitted, under the same key and owner', () => {
    const storage = memoryStorage();
    save(storage);
    expect(
      readSubmittedDraft(storage, NAME, {
        token: TOKEN,
        owner: OWNER,
        fresh: ALWAYS,
      }),
    ).toEqual({
      token: TOKEN,
      savedAt: SAVED_AT,
      fields: [
        ['title', 'Trip over a hose'],
        ['qty', '1'],
        ['qty', '2'],
      ],
      files: [{ field: 'photo', name: 'a.jpg', type: 'image/jpeg', size: 3 }],
      values: { captureKey: 'k-1' },
    });
  });

  it('does not restore under a new key, and drops the stale draft', () => {
    const storage = memoryStorage();
    save(storage);
    expect(
      readSubmittedDraft(storage, NAME, {
        token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owner: OWNER,
        fresh: ALWAYS,
      }),
    ).toBeNull();
    expect(storage.store.size).toBe(0);
  });

  it('never restores one person’s draft for another on shared hardware', () => {
    const storage = memoryStorage();
    save(storage);
    expect(
      readSubmittedDraft(storage, NAME, {
        token: TOKEN,
        owner: 'tenant-1:person-2',
        fresh: ALWAYS,
      }),
    ).toBeNull();
    expect(storage.store.size).toBe(0);
  });

  it('never restores for an empty owner', () => {
    const storage = memoryStorage();
    save(storage, '');
    expect(
      readSubmittedDraft(storage, NAME, {
        token: TOKEN,
        owner: '',
        fresh: ALWAYS,
      }),
    ).toBeNull();
  });

  it('drops an expired draft', () => {
    const storage = memoryStorage();
    save(storage);
    const seen: Date[] = [];
    expect(
      readSubmittedDraft(storage, NAME, {
        token: TOKEN,
        owner: OWNER,
        fresh: (savedAt) => {
          seen.push(savedAt);
          return false;
        },
      }),
    ).toBeNull();
    expect(seen).toEqual([SAVED_AT]);
    expect(storage.store.size).toBe(0);
  });

  it('drops a draft that is malformed or not JSON', () => {
    const storage = memoryStorage();
    const bad = [
      '{not json',
      JSON.stringify({
        v: 2,
        token: TOKEN,
        owner: OWNER,
        savedAt: 1,
        fields: [],
        files: [],
      }),
      JSON.stringify({
        v: 1,
        token: TOKEN,
        owner: OWNER,
        fields: [],
        files: [],
      }),
      JSON.stringify({
        v: 1,
        token: TOKEN,
        owner: OWNER,
        savedAt: 1,
        fields: [['a', 1]],
        files: [],
      }),
      JSON.stringify({
        v: 1,
        token: TOKEN,
        owner: OWNER,
        savedAt: 1,
        fields: [],
        files: [{ field: 'p' }],
      }),
    ];
    for (const raw of bad) {
      storage.store.set(NAME, raw);
      expect(
        readSubmittedDraft(storage, NAME, {
          token: TOKEN,
          owner: OWNER,
          fresh: ALWAYS,
        }),
        raw,
      ).toBeNull();
      expect(storage.store.size, raw).toBe(0);
    }
  });

  it('clears', () => {
    const storage = memoryStorage();
    save(storage);
    clearSubmittedDraft(storage, NAME);
    expect(storage.store.size).toBe(0);
  });

  it('survives a browser that refuses storage (private window)', () => {
    const storage = refusingStorage();
    expect(() =>
      saveSubmittedDraft(storage, NAME, {
        token: TOKEN,
        owner: OWNER,
        savedAt: SAVED_AT,
        fields: [],
        files: [],
      }),
    ).not.toThrow();
    expect(() => clearSubmittedDraft(storage, NAME)).not.toThrow();
  });

  it('skips a values capture that cannot be serialized', () => {
    const storage = memoryStorage();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    saveSubmittedDraft(storage, NAME, {
      token: TOKEN,
      owner: OWNER,
      savedAt: SAVED_AT,
      fields: [],
      files: [],
      values: cyclic,
    });
    expect(storage.store.size).toBe(0);
  });
});

describe('a later attempt whose values cannot be serialized', () => {
  it('clears the earlier attempt’s draft instead of leaving it to be restored', () => {
    const storage = memoryStorage();
    save(storage);
    expect(storage.store.has(NAME)).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    saveSubmittedDraft(storage, NAME, {
      token: TOKEN,
      owner: OWNER,
      savedAt: SAVED_AT,
      fields: [['title', 'A different submission']],
      files: [],
      values: cyclic,
    });
    expect(
      readSubmittedDraft(storage, NAME, {
        token: TOKEN,
        owner: OWNER,
        fresh: ALWAYS,
      }),
    ).toBeNull();
    expect(storage.store.has(NAME)).toBe(false);
  });
});

describe('a store that refuses to remove the draft', () => {
  const read = (storage: FormRetryStorage) =>
    readSubmittedDraft(storage, NAME, {
      token: TOKEN,
      owner: OWNER,
      fresh: ALWAYS,
    });

  it.each([
    ['writes still work', false],
    ['writes are refused too', true],
  ] as const)('clearing leaves nothing to restore (%s)', (_label, refuseWrites) => {
    const storage = stickyStorage();
    save(storage);
    expect(read(storage)).not.toBeNull();
    storage.refuseWrites = refuseWrites;
    clearSubmittedDraft(storage, NAME);
    expect(read(storage)).toBeNull();
  });

  it.each([
    ['writes still work', false],
    ['writes are refused too', true],
  ] as const)('an unserializable later attempt leaves nothing to restore (%s)', (_label, refuseWrites) => {
    const storage = stickyStorage();
    save(storage);
    storage.refuseWrites = refuseWrites;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    saveSubmittedDraft(storage, NAME, {
      token: TOKEN,
      owner: OWNER,
      savedAt: SAVED_AT,
      fields: [['title', 'A different submission']],
      files: [],
      values: cyclic,
    });
    expect(read(storage)).toBeNull();
  });

  it('a draft rejected at read time (another owner) is not restored later', () => {
    const storage = stickyStorage();
    save(storage);
    expect(
      readSubmittedDraft(storage, NAME, {
        token: TOKEN,
        owner: 'tenant-1:person-2',
        fresh: ALWAYS,
      }),
    ).toBeNull();
    expect(read(storage)).toBeNull();
  });

  it('a later save replaces the invalidation', () => {
    const storage = stickyStorage();
    save(storage);
    clearSubmittedDraft(storage, NAME);
    save(storage);
    expect(read(storage)?.fields[0]).toEqual(['title', 'Trip over a hose']);
  });
});

describe('describeFormData', () => {
  it('keeps text entries in order, describes chosen files, skips excluded names', () => {
    const data = new FormData();
    data.append('submissionKey', TOKEN);
    data.append('title', 'x');
    data.append('photo', new File(['abc'], 'a.jpg', { type: 'image/jpeg' }));
    data.append(
      'photo',
      new File([], '', { type: 'application/octet-stream' }),
    );
    data.append('title', 'y');
    expect(describeFormData(data, new Set(['submissionKey']))).toEqual({
      fields: [
        ['title', 'x'],
        ['title', 'y'],
      ],
      files: [{ field: 'photo', name: 'a.jpg', type: 'image/jpeg', size: 3 }],
    });
  });
});

describe('applyDraftToForm', () => {
  function formOf(html: string): HTMLFormElement {
    document.body.innerHTML = `<form>${html}</form>`;
    const form = document.body.querySelector('form');
    if (!form) throw new Error('no form');
    return form;
  }

  it('puts values back by name and order, and notifies bindings', () => {
    const form = formOf(`
      <input type="hidden" name="jobId" value="server" />
      <input name="title" />
      <input name="qty" /><input name="qty" />
      <textarea name="notes"></textarea>
      <select name="unit"><option value="pcs">pcs</option><option value="ft">ft</option></select>
      <select name="tags" multiple><option value="a" selected>a</option><option value="b">b</option></select>
      <input type="checkbox" name="urgent" value="yes" />
      <input type="checkbox" name="checked" value="on" checked />
      <input type="radio" name="sev" value="minor" checked /><input type="radio" name="sev" value="major" />
      <input type="password" name="pin" />
      <input type="file" name="photo" />
      <input name="secret" />
    `);
    const events: string[] = [];
    form.addEventListener('input', (event) => {
      events.push((event.target as HTMLInputElement).name);
    });
    applyDraftToForm(
      form,
      {
        fields: [
          ['jobId', 'restored'],
          ['title', 'Trip'],
          ['qty', '1'],
          ['qty', '2'],
          ['notes', 'by the hose'],
          ['unit', 'ft'],
          ['tags', 'b'],
          ['urgent', 'yes'],
          ['sev', 'major'],
          ['pin', '1234'],
          ['secret', 'leaked'],
        ],
      },
      new Set(['secret']),
    );
    const value = (selector: string) =>
      (form.querySelector(selector) as HTMLInputElement).value;
    const checked = (selector: string) =>
      (form.querySelector(selector) as HTMLInputElement).checked;
    expect(value('[name=jobId]')).toBe('server');
    expect(value('[name=title]')).toBe('Trip');
    expect(
      Array.from(
        form.querySelectorAll<HTMLInputElement>('[name=qty]'),
        (q) => q.value,
      ),
    ).toEqual(['1', '2']);
    expect(value('[name=notes]')).toBe('by the hose');
    expect(value('[name=unit]')).toBe('ft');
    expect(
      Array.from(
        (form.querySelector('[name=tags]') as HTMLSelectElement)
          .selectedOptions,
        (o) => o.value,
      ),
    ).toEqual(['b']);
    expect(checked('[name=urgent]')).toBe(true);
    // Submitted unchecked (absent from the draft): unchecked again.
    expect(checked('[name=checked]')).toBe(false);
    expect(checked('[value=major]')).toBe(true);
    expect(value('[name=pin]')).toBe('');
    expect(value('[name=secret]')).toBe('');
    expect(events).toEqual(
      expect.arrayContaining([
        'title',
        'qty',
        'notes',
        'unit',
        'tags',
        'urgent',
        'checked',
        'sev',
      ]),
    );
    expect(events).not.toContain('jobId');
    expect(events).not.toContain('pin');
  });
});
