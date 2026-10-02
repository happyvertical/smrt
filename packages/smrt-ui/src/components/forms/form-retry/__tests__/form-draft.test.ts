/**
 * The conditional reset that keeps a typed next entry alive (#3291).
 */

import { describe, expect, it } from 'vitest';
import { draftChanged, draftOf, formWasCleared } from '../form-draft.js';

function formOf(html: string): HTMLFormElement {
  document.body.innerHTML = `<form>${html}</form>`;
  const form = document.body.querySelector('form');
  if (!form) throw new Error('no form');
  return form;
}

const ENTRY_FORM = `
  <input type="hidden" name="submissionKey" value="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />
  <input type="text" name="reference" value="R-1" />
  <input type="text" name="grade" value="A36" />
  <textarea name="notes">from bay 2</textarea>
  <select name="unit"><option value="pcs" selected>pcs</option><option value="ft">ft</option></select>
  <select name="tags" multiple><option value="a" selected>a</option><option value="b">b</option></select>
  <input type="checkbox" name="urgent" />
  <button type="submit">Record</button>
`;

const field = <T extends Element = HTMLInputElement>(
  form: HTMLFormElement,
  selector: string,
): T => {
  const element = form.querySelector<T>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
};

describe('draftChanged', () => {
  it('is false for a form nobody has touched', () => {
    const form = formOf(ENTRY_FORM);
    expect(draftChanged(form, draftOf(form))).toBe(false);
  });

  it('is true once any visible field is edited', () => {
    const form = formOf(ENTRY_FORM);
    const submitted = draftOf(form);
    field(form, '[name=reference]').value = 'R-2';
    expect(draftChanged(form, submitted)).toBe(true);
  });

  it('sees a textarea, a select, a multi-select and a checkbox', () => {
    const edits: Array<(form: HTMLFormElement) => void> = [
      (form) => {
        field<HTMLTextAreaElement>(form, 'textarea').value = 'from bay 3';
      },
      (form) => {
        field<HTMLSelectElement>(form, '[name=unit]').value = 'ft';
      },
      (form) => {
        field<HTMLSelectElement>(form, '[name=tags]').options[1].selected =
          true;
      },
      (form) => {
        field(form, '[name=urgent]').checked = true;
      },
    ];
    for (const edit of edits) {
      const form = formOf(ENTRY_FORM);
      const submitted = draftOf(form);
      edit(form);
      expect(draftChanged(form, submitted)).toBe(true);
    }
  });

  it('IGNORES the rotated hidden key, or nothing would ever reset', () => {
    const form = formOf(ENTRY_FORM);
    const submitted = draftOf(form);
    field(form, '[name=submissionKey]').value =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(draftChanged(form, submitted)).toBe(false);
  });

  it('sees a hidden input a control posts through (a Listbox selection)', () => {
    const form = formOf(
      `${ENTRY_FORM}<input type="hidden" name="choice" value="a" />`,
    );
    const submitted = draftOf(form);
    field(form, '[name=choice]').value = 'b';
    expect(draftChanged(form, submitted)).toBe(true);
  });

  it('ignores exactly the fields it is told to — the configured key field', () => {
    const form = formOf(`
      <input type="hidden" name="retryKey" value="k-1" />
      <input type="hidden" name="choice" value="a" />
    `);
    const ignore = new Set(['retryKey']);
    const submitted = draftOf(form, ignore);
    field(form, '[name=retryKey]').value = 'k-2';
    expect(draftChanged(form, submitted, ignore)).toBe(false);
    expect(formWasCleared(form, submitted, ignore)).toBe(true);
    field(form, '[name=choice]').value = 'b';
    expect(draftChanged(form, submitted, ignore)).toBe(true);
  });

  it('notices a field being cleared, a control removed, and a repeated name', () => {
    let form = formOf(ENTRY_FORM);
    let submitted = draftOf(form);
    field(form, '[name=grade]').value = '';
    expect(draftChanged(form, submitted)).toBe(true);

    form = formOf(ENTRY_FORM);
    submitted = draftOf(form);
    field(form, '[name=grade]').remove();
    expect(draftChanged(form, submitted)).toBe(true);

    form = formOf(
      '<input name="qty" value="1" /><input name="qty" value="2" />',
    );
    submitted = draftOf(form);
    form.querySelectorAll<HTMLInputElement>('[name=qty]')[1].value = '3';
    expect(draftChanged(form, submitted)).toBe(true);
  });
});

describe('formWasCleared', () => {
  it('is true only for a form still in the document and unchanged', () => {
    const form = formOf(ENTRY_FORM);
    expect(formWasCleared(form, draftOf(form))).toBe(true);
    const edited = formOf(ENTRY_FORM);
    const submitted = draftOf(edited);
    field(edited, '[name=reference]').value = 'R-2';
    expect(formWasCleared(edited, submitted)).toBe(false);
  });

  it('is false for a DETACHED form, however unchanged it looks', () => {
    const form = formOf(ENTRY_FORM);
    const submitted = draftOf(form);
    form.remove();
    expect(draftChanged(form, submitted)).toBe(false);
    expect(formWasCleared(form, submitted)).toBe(false);
  });
});

describe('posted files', () => {
  /** Browsers fire `formdata` while `new FormData(form)` builds; jsdom does not. */
  function fireFormDataOnConstruct(): () => void {
    const Native = globalThis.FormData;
    class BrowserFormData extends Native {
      constructor(form?: HTMLFormElement) {
        super(form);
        if (!form) return;
        const event = new Event('formdata');
        Object.defineProperty(event, 'formData', { value: this });
        form.dispatchEvent(event);
      }
    }
    globalThis.FormData = BrowserFormData;
    return () => {
      globalThis.FormData = Native;
    };
  }

  it('sees a file a formdata listener appends, though no element shows it', () => {
    const restore = fireFormDataOnConstruct();
    try {
      const form = formOf('<input type="file" hidden />');
      let file: File | null = new File(['first'], 'photo.jpg', {
        type: 'image/jpeg',
      });
      form.addEventListener('formdata', (event) => {
        const formData = (event as Event & { formData: FormData }).formData;
        formData.append('photo', file ?? new File([], ''));
      });
      const submitted = draftOf(form);
      expect(draftChanged(form, submitted)).toBe(false);

      file = new File(['second photo'], 'photo.jpg', { type: 'image/jpeg' });
      expect(draftChanged(form, submitted)).toBe(true);

      file = null;
      expect(draftChanged(form, submitted)).toBe(true);
    } finally {
      restore();
    }
  });

  it('ignores the fresh "no file chosen" entry of an empty file input', async () => {
    const form = formOf('<input type="file" name="photo" />');
    const submitted = draftOf(form);
    // The empty entry is re-minted with a new lastModified on every build.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(draftChanged(form, submitted)).toBe(false);
  });
});
