/**
 * Whether a form still holds what it submitted, so a successful submit knows
 * if it may clear the fields (#3291).
 *
 * The problem this solves is created by the in-flight refusal in
 * `submission-key.ts`. A submit over a slow link is unresolved for a while;
 * the fields stay editable, so the person can type the NEXT entry into them.
 * They cannot send it yet — that is the point — but when the first submit
 * finally succeeds, `enhance`'s `update()` resets the form by default and the
 * typed draft is gone. Nothing downstream can recover it: it never reached the
 * server, so no claim has ever seen it.
 *
 * So the reset becomes conditional. If the fields still hold exactly what was
 * submitted, clearing them is right — the ordinary case, and what makes the
 * next entry a fresh form with a fresh key. If they do not, the person has
 * moved on and their work is kept.
 *
 * Only controls a PERSON edits are compared. Hidden fields are excluded on
 * purpose: the submission key is rotated by a confirmed write, so including it
 * would make every form look edited and nothing would ever reset.
 *
 * @module
 */

/** The values a person can see and change, keyed by position and name. */
export type FormDraft = ReadonlyMap<string, string>;

function isEditableControl(element: Element): element is HTMLElement {
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement) &&
    !(element instanceof HTMLSelectElement)
  ) {
    return false;
  }
  if (element instanceof HTMLInputElement) {
    const type = element.type;
    if (
      type === 'hidden' ||
      type === 'submit' ||
      type === 'button' ||
      type === 'reset' ||
      type === 'image'
    ) {
      return false;
    }
  }
  return true;
}

function controlValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return element.checked ? 'on' : '';
    }
    if (element.type === 'file') {
      // A file input cannot be restored from script, so the chosen files'
      // identity (name, size, type) is all that can honestly be compared.
      return Array.from(
        element.files ?? [],
        (file) => `${file.name}\u0000${file.size}\u0000${file.type}`,
      ).join('\u0001');
    }
    return element.value;
  }
  if (element instanceof HTMLSelectElement && element.multiple) {
    return Array.from(element.selectedOptions, (option) => option.value).join(
      '\u0001',
    );
  }
  return (element as HTMLTextAreaElement | HTMLSelectElement).value;
}

/** What the person could see in `form` at this moment. */
export function draftOf(form: HTMLFormElement): FormDraft {
  const draft = new Map<string, string>();
  let index = 0;
  for (const element of Array.from(form.elements)) {
    if (!isEditableControl(element)) continue;
    const name = (element as HTMLInputElement).name || `#${index}`;
    // Several controls can share a name (a radio group, repeated fields); the
    // index keeps them distinct so a change in any one of them is visible.
    draft.set(`${index}:${name}`, controlValue(element));
    index += 1;
  }
  return draft;
}

/**
 * Has `form` been edited since `submitted` was taken? `true` means the person
 * has typed something the server has never seen, so a reset would destroy it.
 */
export function draftChanged(
  form: HTMLFormElement,
  submitted: FormDraft,
): boolean {
  const now = draftOf(form);
  if (now.size !== submitted.size) return true;
  for (const [key, value] of now) {
    if (submitted.get(key) !== value) return true;
  }
  return false;
}

/**
 * Did this submit leave the form EMPTY — the one question key retirement turns
 * on (`settleSubmit()`)? Both of these must be no:
 *
 * - the person edited the fields while the submit was unresolved, so a reset
 *   would destroy work the server has never seen;
 * - **the submitted form is no longer in the document.** A form remounted
 *   under a `{#key}` block, or unmounted when its panel closes, leaves a
 *   detached node that still holds exactly what it submitted, so an
 *   unchanged-check alone would retire the key — while the VISIBLE
 *   replacement may hold the same content, one tap from a second record under
 *   a fresh claim.
 *
 * A detached form therefore never counts as cleared. That is the safe
 * direction: keeping a key can only make a later submit of the same content
 * collapse onto the row that already exists, while retiring one wrongly is
 * what records a duplicate.
 */
export function formWasCleared(
  form: HTMLFormElement,
  submitted: FormDraft,
): boolean {
  if (!form.isConnected) return false;
  return !draftChanged(form, submitted);
}
