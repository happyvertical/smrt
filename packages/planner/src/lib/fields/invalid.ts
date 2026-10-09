/** Moves focus to the first control of a form whose field is marked invalid. */
export function focusFirstInvalid(form: EventTarget | null): void {
  if (!(form instanceof HTMLElement)) return;
  form
    .querySelector<HTMLElement>(
      '[data-invalid] :is(input, select, textarea, button):not([type="hidden"])',
    )
    ?.focus();
}
