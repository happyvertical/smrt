import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import { createControlInteractionRegistry } from '../control-interaction.js';
import Fixture from './multiselect-form.fixture.svelte';

function form() {
  return screen.getByRole('form', { name: 'Roles form' }) as HTMLFormElement;
}
function data() {
  return new FormData(form());
}
async function open() {
  await userEvent.click(screen.getByRole('button', { name: /Roles/ }));
}
describe('MultiSelect native form values', () => {
  it('posts repeated values in selection order and removes deselected inputs', async () => {
    render(Fixture);
    await open();
    await userEvent.click(
      screen.getByRole('option', { name: 'Administrator' }),
    );
    await userEvent.click(screen.getByRole('option', { name: 'Operator' }));
    expect(data().getAll('roles')).toEqual(['admin', '42']);
    await userEvent.click(
      screen.getByRole('option', { name: 'Administrator' }),
    );
    expect(data().getAll('roles')).toEqual(['42']);
    await userEvent.click(
      screen.getByRole('option', { name: 'Disabled role' }),
    );
    expect(data().getAll('roles')).toEqual(['42']);
  });
  it('posts canonical numeric selections from legacy strings', () => {
    render(Fixture, { props: { values: ['42'] } });
    expect(data().getAll('roles')).toEqual(['42']);
  });
  it('omits empty selections, empty names and unnamed controls', async () => {
    const { rerender } = render(Fixture);
    expect([...data()]).toEqual([]);
    await rerender({ values: [42], name: '' });
    expect([...data()]).toEqual([]);
    await rerender({ values: [42], unnamed: true });
    expect([...data()]).toEqual([]);
  });
  it.each([
    { disabled: true },
    { fieldsetDisabled: true },
  ])('omits disabled selections %j', (props) => {
    render(Fixture, { props: { ...props, values: [42, 'admin'] } });
    expect([...data()]).toEqual([]);
  });
  it('restores initial selected values on native reset', async () => {
    render(Fixture, { props: { values: [42] } });
    await open();
    await userEvent.click(
      screen.getByRole('option', { name: 'Administrator' }),
    );
    form().reset();
    await tick();
    expect(data().getAll('roles')).toEqual(['42']);
    await open();
    expect(screen.getByRole('option', { name: 'Operator' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('option', { name: 'Administrator' }),
    ).toHaveAttribute('aria-selected', 'false');
  });
  it('preserves changed values when reset is canceled', async () => {
    render(Fixture);
    await open();
    await userEvent.click(screen.getByRole('option', { name: 'Operator' }));
    form().addEventListener('reset', (event) => event.preventDefault());
    form().reset();
    await tick();
    expect(data().getAll('roles')).toEqual(['42']);
  });
  it('preserves registry identity and posts only applied canonical values', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { registry } });
    const identity = { formId: 'roles-form', controlId: 'roles' };
    await registry.execute(
      { action: 'stage', identity, value: ['42', 'admin'] },
      { source: 'agent' },
    );
    expect([...data()]).toEqual([]);
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply valid changes' }),
    );
    expect(data().getAll('roles')).toEqual(['42', 'admin']);
    expect(registry.get(identity)?.state.value).toEqual([42, 'admin']);
  });
});
