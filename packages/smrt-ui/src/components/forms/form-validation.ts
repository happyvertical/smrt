/**
 * Validate-before-submit for native forms (happyvertical/smrt#5346).
 *
 * `validateBeforeSubmit` is a Svelte action (`use:validateBeforeSubmit`) for any
 * `<form>`, including a plain SvelteKit form-action form
 * (`<form method="POST" action="?/save">`). It never takes over the POST: no
 * `fetch`, no `preventDefault` on a valid submit. It only
 *
 * - shows each invalid field's reason (the browser's `validationMessage` or a
 *   custom one from `setCustomValidity`) in words next to the field, wired with
 *   `aria-invalid` and `aria-describedby`, once the field has been touched or a
 *   submit was attempted (never on first render);
 * - keeps submit unavailable while the form is invalid: submit buttons get
 *   `aria-disabled="true"` (so they stay focusable and the reasons stay
 *   reachable) and a submit attempt is blocked, revealing every reason and
 *   focusing the first invalid field.
 *
 * It sets `novalidate` only once it has attached, so with JavaScript off the
 * form falls back to the browser's native validation.
 */

export interface FormValidationHandle {
  destroy(): void;
}

const STYLE_ID = 'smrt-form-validation-styles';
const STYLES = `
.smrt-field-error{margin:0.25rem 0 0;font-size:0.875rem;line-height:1.3;color:var(--smrt-color-error,#b3261e)}
[data-smrt-invalid="true"]{border-color:var(--smrt-color-error,#b3261e)}
.smrt-submit-blocked{opacity:0.6;cursor:not-allowed}
`;

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

function isField(el: Element): el is Field {
  if (
    !(
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    )
  ) {
    return false;
  }
  if (el.hasAttribute('data-smrt-skip-validation')) return false;
  return el.willValidate;
}

/** Words for a field's current problem; empty when it is valid. */
function reasonFor(field: Field): string {
  if (field.validity.valid) return '';
  if (field.validationMessage) return field.validationMessage;
  const v = field.validity;
  if (v.customError) return 'This value is not valid.';
  if (v.valueMissing) return 'Please fill out this field.';
  if (v.typeMismatch) {
    return field instanceof HTMLInputElement && field.type === 'email'
      ? 'Please enter an email address.'
      : 'Please enter a valid value.';
  }
  if (v.tooShort)
    return `Use at least ${(field as HTMLInputElement).minLength} characters.`;
  if (v.tooLong)
    return `Use at most ${(field as HTMLInputElement).maxLength} characters.`;
  if (v.patternMismatch) return 'Please match the requested format.';
  if (v.rangeUnderflow || v.rangeOverflow) return 'The value is out of range.';
  return 'This value is not valid.';
}

export function validateBeforeSubmit(
  form: HTMLFormElement,
  _options?: Record<string, never>,
): FormValidationHandle {
  const doc = form.ownerDocument;
  ensureStyles(doc);
  const touched = new WeakSet<Element>();
  const messages = new Map<Field, HTMLElement>();
  let attempted = false;
  let counter = 0;
  const hadNoValidate = form.noValidate;
  form.noValidate = true;
  form.setAttribute('data-smrt-validated', '');

  const fields = (): Field[] =>
    (Array.from(form.elements) as Element[]).filter(isField);

  const submitButtons = (): HTMLElement[] => {
    const own = Array.from(
      form.querySelectorAll<HTMLElement>(
        'button:not([type]), button[type="submit"], input[type="submit"]',
      ),
    );
    const id = form.id;
    const outside = id
      ? Array.from(
          doc.querySelectorAll<HTMLElement>(
            `button[form="${CSS.escape(id)}"]:not([type]), button[form="${CSS.escape(id)}"][type="submit"], input[type="submit"][form="${CSS.escape(id)}"]`,
          ),
        ).filter((b) => !own.includes(b))
      : [];
    return [...own, ...outside];
  };

  function setDescribedBy(field: Field, messageId: string, on: boolean): void {
    const ids = (field.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => t !== messageId);
    if (on) ids.push(messageId);
    if (ids.length) field.setAttribute('aria-describedby', ids.join(' '));
    else field.removeAttribute('aria-describedby');
  }

  function clearMessage(field: Field): void {
    const msg = messages.get(field);
    if (!msg) return;
    setDescribedBy(field, msg.id, false);
    msg.remove();
    messages.delete(field);
    field.removeAttribute('aria-invalid');
    field.removeAttribute('data-smrt-invalid');
  }

  function showMessage(field: Field, text: string): void {
    let msg = messages.get(field);
    if (!msg) {
      msg = doc.createElement('p');
      msg.id = `smrt-field-error-${Math.random().toString(36).slice(2, 8)}-${++counter}`;
      msg.className = 'smrt-field-error';
      msg.setAttribute('data-smrt-field-error', '');
      const anchor =
        field.closest<HTMLElement>('[data-smrt-error-anchor]') ?? field;
      anchor.insertAdjacentElement('afterend', msg);
      messages.set(field, msg);
      setDescribedBy(field, msg.id, true);
    }
    if (msg.textContent !== text) msg.textContent = text;
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('data-smrt-invalid', 'true');
  }

  function update(): void {
    const current = fields();
    for (const [field] of messages) {
      if (!current.includes(field)) clearMessage(field);
    }
    let valid = true;
    for (const field of current) {
      const reason = reasonFor(field);
      if (reason) valid = false;
      if (reason && (attempted || touched.has(field))) {
        showMessage(field, reason);
      } else {
        clearMessage(field);
      }
    }
    for (const button of submitButtons()) {
      if (valid) {
        button.removeAttribute('aria-disabled');
        button.classList.remove('smrt-submit-blocked');
      } else {
        button.setAttribute('aria-disabled', 'true');
        button.classList.add('smrt-submit-blocked');
      }
    }
  }

  function block(event: Event): boolean {
    attempted = true;
    update();
    const first = fields().find((f) => !f.validity.valid);
    if (!first) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    first.focus();
    return true;
  }

  const onTouch = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && isField(target)) touched.add(target);
    update();
    // Bound values commit after this handler; settle once more.
    queueMicrotask(update);
  };
  const onInput = () => {
    update();
    queueMicrotask(update);
  };
  const onClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('[aria-disabled="true"]');
    if (button && submitButtons().includes(button)) block(event);
  };
  // Reveal on mousedown, not only click: revealing the reasons inserts text
  // that shifts the layout, and a button that moves between mousedown and
  // mouseup never receives its click. Cancelling mousedown also keeps focus in
  // place so the blur does not shift the button first.
  const onMouseDown = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('[aria-disabled="true"]');
    if (button && submitButtons().includes(button)) block(event);
  };
  const onSubmit = (event: Event) => {
    block(event);
  };
  const onReset = () => {
    attempted = false;
    queueMicrotask(() => {
      for (const field of fields()) touched.delete(field);
      update();
    });
  };

  form.addEventListener('focusout', onTouch);
  form.addEventListener('input', onInput);
  form.addEventListener('change', onTouch);
  form.addEventListener('mousedown', onMouseDown, true);
  form.addEventListener('click', onClick, true);
  form.addEventListener('submit', onSubmit, true);
  form.addEventListener('reset', onReset);
  update();

  return {
    destroy() {
      form.removeEventListener('focusout', onTouch);
      form.removeEventListener('input', onInput);
      form.removeEventListener('change', onTouch);
      form.removeEventListener('mousedown', onMouseDown, true);
      form.removeEventListener('click', onClick, true);
      form.removeEventListener('submit', onSubmit, true);
      form.removeEventListener('reset', onReset);
      for (const field of [...messages.keys()]) clearMessage(field);
      for (const button of submitButtons()) {
        button.removeAttribute('aria-disabled');
        button.classList.remove('smrt-submit-blocked');
      }
      form.noValidate = hadNoValidate;
      form.removeAttribute('data-smrt-validated');
    },
  };
}
