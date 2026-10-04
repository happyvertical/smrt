// @vitest-environment jsdom
/**
 * AssemblyForm: the Assembly fields rendered through ObjectForm, a field the
 * policy hides left out, values reaching `onsubmit`, and accessibility.
 */
import type { ObjectFormProps } from '@happyvertical/smrt-fields/svelte';
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssemblyForm from '../components/AssemblyForm.svelte';
import { assemblyPolicy } from './fixtures.js';

const fields: NonNullable<ObjectFormProps['fields']> = {
  name: { type: 'text', required: true },
  partReference: { type: 'text' },
  price: { type: 'integer' },
  estimatedLabourMinutes: { type: 'integer' },
  description: { type: 'text' },
};

describe('AssemblyForm', () => {
  it('renders the Assembly fields the policy shows, with policy labels', () => {
    render(AssemblyForm, { props: { fields, policy: assemblyPolicy() } });
    expect(screen.getByRole('textbox', { name: /Name/ })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Part reference' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('spinbutton', { name: 'Price' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('spinbutton', { name: 'Estimated labour (minutes)' }),
    ).toBeInTheDocument();
  });

  it('leaves out a field the policy hides', () => {
    render(AssemblyForm, {
      props: { fields, policy: assemblyPolicy({ price: 'hidden' }) },
    });
    expect(
      screen.queryByRole('spinbutton', { name: 'Price' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Part reference' }),
    ).toBeInTheDocument();
  });

  it('refuses a policy for another object', () => {
    render(AssemblyForm, {
      props: {
        fields,
        policy: { ...assemblyPolicy(), objectRef: '@test:Other' },
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      "ObjectForm policy does not match '@happyvertical/smrt-manufacturing:Assembly'.",
    );
  });

  it('hands the entered values to onsubmit', async () => {
    let submitted: Record<string, FormDataEntryValue> = {};
    const onsubmit = vi.fn((event: SubmitEvent) => {
      submitted = Object.fromEntries(
        new FormData(event.currentTarget as HTMLFormElement),
      );
      return true;
    });
    render(AssemblyForm, {
      props: { fields, policy: assemblyPolicy(), onsubmit },
    });
    await userEvent.type(
      screen.getByRole('textbox', { name: /Name/ }),
      'Frame',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Part reference' }),
      'DWG-1001',
    );
    await userEvent.type(
      screen.getByRole('spinbutton', { name: 'Estimated labour (minutes)' }),
      '95',
    );
    const form = screen.getByRole('textbox', { name: /Name/ }).closest('form');
    form?.requestSubmit();
    await vi.waitFor(() => expect(onsubmit).toHaveBeenCalledOnce());
    expect(submitted).toMatchObject({
      name: 'Frame',
      partReference: 'DWG-1001',
      estimatedLabourMinutes: '95',
    });
  });

  it('is axe-clean', async () => {
    const { container } = render(AssemblyForm, {
      props: { fields, policy: assemblyPolicy() },
    });
    await expectNoA11yViolations(container);
  });
});
