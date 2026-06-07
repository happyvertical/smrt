import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const formsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function source(component: string) {
  return readFileSync(resolve(formsDir, component), 'utf8');
}

describe('form primitive accessibility relationships', () => {
  it.each([
    'TextInput.svelte',
    'TextareaInput.svelte',
    'SelectInput.svelte',
  ])('%s links dynamic supporting text to the field', (component) => {
    const content = source(component);

    expect(content).toContain('supportingTextId');
    expect(content).toContain('aria-describedby={hasSupportingText ? supportingTextId : undefined}');
    expect(content).toContain('id={supportingTextId}');
  });

  it.each([
    'TextInput.svelte',
    'TextareaInput.svelte',
    'NumberInput.svelte',
    'MoneyInput.svelte',
  ])('%s exposes invalid state to assistive technology', (component) => {
    const content = source(component);

    expect(content).toContain('aria-invalid=');
  });

  it.each([
    'TextInput.svelte',
    'TextareaInput.svelte',
    'NumberInput.svelte',
    'MoneyInput.svelte',
  ])('%s announces validation and status changes politely', (component) => {
    const content = source(component);

    expect(content).toContain('aria-live="polite"');
  });

  it.each(['NumberInput.svelte', 'MoneyInput.svelte'])(
    '%s links validation errors to the field',
    (component) => {
      const content = source(component);

      expect(content).toContain('validationErrorId');
      expect(content).toContain('aria-describedby={showInvalid ? validationErrorId : undefined}');
      expect(content).toContain('id={validationErrorId}');
    },
  );
});
