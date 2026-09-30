import {
  type FormField,
  type OpenAiFormReply,
  validateOpenAiForm,
  validateOpenAiFormReply,
} from './forms.js';
/**
 * Functional application-form fallback. Text is rendered inertly; no remote
 * thumbnails are loaded and no credentials/native file paths are requested.
 * Submit must call the authenticated owning application route, which persists
 * the bound reply through submitOpenAiForm. This renderer confers no authority.
 */
export function renderOpenAiForm(
  container: HTMLElement,
  options: {
    schema: unknown;
    submit: (reply: OpenAiFormReply) => Promise<void>;
  },
): { dispose: () => void } {
  const schema = validateOpenAiForm(options.schema);
  const doc = container.ownerDocument;
  const form = doc.createElement('form');
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const reads = new Map<string, () => unknown>();
  let active = true;
  let pending = false;
  for (const [name, field] of Object.entries(schema.properties)) {
    const label = doc.createElement('label');
    const title = doc.createElement('span');
    title.textContent = field.title ?? name;
    label.append(title);
    if (field.description) {
      const desc = doc.createElement('span');
      desc.textContent = field.description;
      label.append(desc);
    }
    const choices = fieldOptions(field);
    let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (choices) {
      const select = doc.createElement('select');
      select.multiple = field.type === 'array';
      if (!select.multiple) {
        const empty = doc.createElement('option');
        empty.value = '';
        empty.textContent = 'Choose a value';
        select.append(empty);
      }
      for (const choice of choices) {
        const option = doc.createElement('option');
        option.value = choice.value;
        option.textContent = choice.title;
        if (field.default !== undefined)
          option.selected = Array.isArray(field.default)
            ? field.default.includes(choice.value)
            : field.default === choice.value;
        select.append(option);
      }
      control = select;
      reads.set(name, () =>
        select.multiple
          ? [...select.selectedOptions].map((o) => o.value)
          : select.selectedIndex === 0
            ? undefined
            : select.value,
      );
    } else if (field.type === 'array') {
      const area = doc.createElement('textarea');
      area.value = field.default?.join('\n') ?? '';
      area.maxLength = 4096;
      control = area;
      reads.set(name, () => (area.value ? area.value.split('\n') : []));
    } else {
      const input = doc.createElement('input');
      input.type =
        field.type === 'boolean'
          ? 'checkbox'
          : field.type === 'number' || field.type === 'integer'
            ? 'number'
            : 'text';
      if (field.type === 'boolean') input.checked = field.default ?? false;
      else if (field.default !== undefined) input.value = String(field.default);
      if (field.type === 'number' || field.type === 'integer') {
        input.step = field.type === 'integer' ? '1' : 'any';
        if (field.minimum !== undefined) input.min = String(field.minimum);
        if (field.maximum !== undefined) input.max = String(field.maximum);
      } else if (field.type === 'string' && 'maxLength' in field)
        input.maxLength = field.maxLength ?? 4096;
      control = input;
      reads.set(name, () =>
        field.type === 'boolean'
          ? input.checked
          : field.type === 'number' || field.type === 'integer'
            ? input.value === ''
              ? undefined
              : Number(input.value)
            : input.value,
      );
    }
    if (
      field.type === 'array' &&
      field.default === undefined &&
      !schema.required?.includes(name)
    ) {
      let touched = false;
      const markTouched = () => {
        touched = true;
      };
      control.addEventListener('input', markTouched);
      control.addEventListener('change', markTouched);
      const read = reads.get(name)!;
      reads.set(name, () => (touched ? read() : undefined));
    }
    control.name = name;
    control.setAttribute('aria-label', field.title ?? name);

    label.append(control);
    form.append(label);
  }
  const buttons: HTMLButtonElement[] = [];
  const send = async (reply: OpenAiFormReply) => {
    if (!active || pending) return;
    pending = true;
    for (const b of buttons) b.disabled = true;
    status.textContent = 'Submitting input';
    try {
      await options.submit(validateOpenAiFormReply(schema, reply));
      if (active)
        status.textContent =
          'Input submitted. Continue on the application review page.';
    } catch {
      if (active)
        status.textContent =
          'Input was not submitted. Check the form or refresh the review page.';
    } finally {
      pending = false;
      if (active) for (const b of buttons) b.disabled = false;
    }
  };
  for (const action of ['accept', 'decline', 'cancel'] as const) {
    const button = doc.createElement('button');
    button.type = action === 'accept' ? 'submit' : 'button';
    button.textContent =
      action === 'accept'
        ? 'Submit input'
        : action === 'cancel'
          ? 'Cancel'
          : 'Decline';
    if (action !== 'accept')
      button.addEventListener('click', () => void send({ action }));
    buttons.push(button);
    form.append(button);
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const content: Record<string, unknown> = {};
    for (const [name, read] of reads) {
      const v = read();
      if (v !== undefined && (v !== '' || schema.required?.includes(name)))
        content[name] = v;
    }
    try {
      void send(validateOpenAiFormReply(schema, { action: 'accept', content }));
    } catch {
      status.textContent = 'Check the form values before submitting.';
    }
  });
  form.append(status);
  container.append(form);
  return {
    dispose: () => {
      active = false;
      form.remove();
    },
  };
}
function fieldOptions(
  f: FormField,
): { value: string; title: string }[] | undefined {
  if ('x-openai-input' in f) {
    if (
      f['x-openai-input'].userOptions ||
      ('selection' in f['x-openai-input'] &&
        f['x-openai-input'].selection === 'implicit')
    )
      return undefined;
    return f['x-openai-input'].options.map((o) => ({
      value: o.uri,
      title: o.title ?? o.name,
    }));
  }
  if ('oneOf' in f)
    return f.oneOf.map((o) => ({ value: o.const, title: o.title }));
  if ('enum' in f)
    return f.enum.map((v, i) => ({ value: v, title: f.enumNames?.[i] ?? v }));
  if (f.type === 'array') {
    if ('anyOf' in f.items)
      return f.items.anyOf.map((o) => ({ value: o.const, title: o.title }));
    if ('enum' in f.items)
      return f.items.enum.map((value) => ({ value, title: value }));
  }
  return undefined;
}
