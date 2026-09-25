// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptSettingsView } from '../types.js';
import PanelContextHarness from './__tests__/panel-context-harness.svelte';
import PromptSettingsPanel from './PromptSettingsPanel.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];

function render(props: Record<string, unknown> = {}): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(PromptSettingsPanel, { target, props }));
  flushSync();
  return target;
}

/** Mount the panel behind a harness that can replace `prompts` afterwards. */
function renderWithHarness(props: Record<string, unknown>): {
  target: HTMLElement;
  harness: {
    setPrompts: (next: PromptSettingsView[]) => void;
    setContextKey: (next: unknown) => void;
  };
} {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const harness = mount(PanelContextHarness, { target, props }) as unknown as {
    setPrompts: (next: PromptSettingsView[]) => void;
    setContextKey: (next: unknown) => void;
  };
  mounted.push(harness as unknown as ReturnType<typeof mount>);
  flushSync();
  return { target, harness };
}

afterEach(() => {
  while (mounted.length > 0) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const DRAFTS: PromptSettingsView = {
  key: '@test/app:Invoice#drafts',
  description: 'Invoice drafts prompt',
  effectiveTemplate: 'Draft the invoice.',
  supplyingLevel: 'default',
  editable: { template: true },
  appTemplate: null,
  tenantTemplate: null,
  appDefaultTemplate: 'Draft the invoice.',
  inheritedTemplate: 'Draft the invoice.',
};

function checkboxNamed(target: HTMLElement, name: string): HTMLInputElement {
  const element = target.querySelector<HTMLInputElement>(
    `input[type="checkbox"][name="${name}"]`,
  );
  if (!element) throw new Error(`no checkbox named "${name}"`);
  return element;
}

function textareaNamed(target: HTMLElement, name: string): HTMLTextAreaElement {
  const element = target.querySelector<HTMLTextAreaElement>(
    `textarea[name="${name}"]`,
  );
  if (!element) throw new Error(`no textarea named "${name}"`);
  return element;
}

function toggleCheckbox(checkbox: HTMLInputElement, checked: boolean): void {
  checkbox.checked = checked;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function submitFirstForm(target: HTMLElement): Event {
  const form = target.querySelector('form');
  if (!form) throw new Error('no <form> rendered');
  const event = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  flushSync();
  return event;
}

describe('PromptSettingsPanel', () => {
  it('renders the key, description, effective text, and supplying level', () => {
    const target = render({
      prompts: [
        DRAFTS,
        {
          key: '@test/app:Invoice#reports',
          description: 'Reports prompt',
          effectiveTemplate: 'Report override text.',
          supplyingLevel: 'tenant',
        },
      ],
    });

    const text = target.textContent ?? '';
    expect(text).toContain('Invoice drafts prompt');
    expect(text).toContain('@test/app:Invoice#drafts');
    expect(text).toContain('Draft the invoice.');
    expect(text).toContain('Registry default');
    expect(text).toContain('Reports prompt');
    expect(text).toContain('Report override text.');
    expect(text).toContain('Tenant override');
    expect(target.querySelectorAll('form')).toHaveLength(2);
  });

  it('falls back to the key when a definition has no description', () => {
    const target = render({
      prompts: [
        {
          key: '@test/app:Invoice#bare',
          effectiveTemplate: 'Bare text.',
        },
      ],
    });

    expect(target.querySelector('.ps-title')?.textContent?.trim()).toBe(
      '@test/app:Invoice#bare',
    );
  });

  it('renders an empty state when there are no prompts', () => {
    const target = render({ prompts: [] });

    expect(target.querySelector('form')).toBeNull();
    expect(target.textContent).toContain('No prompts are registered yet');
  });

  it('preselects the tenant override checkbox and text from the row', () => {
    const target = render({
      prompts: [{ ...DRAFTS, tenantTemplate: 'Custom tenant text.' }],
    });

    expect(checkboxNamed(target, 'tenantOverride').checked).toBe(true);
    expect(textareaNamed(target, 'tenantTemplate').value).toBe(
      'Custom tenant text.',
    );
  });

  it('leaves the tenant checkbox unchecked and shows the revert preview when there is no override', () => {
    const target = render({ prompts: [DRAFTS] });

    expect(checkboxNamed(target, 'tenantOverride').checked).toBe(false);
    expect(textareaNamed(target, 'tenantTemplate').value).toBe(
      'Draft the invoice.',
    );
    expect(target.textContent).toContain(
      'Unchecked reverts to: Draft the invoice.',
    );
  });

  it('omits the app column unless the host asks for it', () => {
    const target = render({
      prompts: [{ ...DRAFTS, appTemplate: 'App text.' }],
    });

    expect(
      target.querySelector('input[type="checkbox"][name="appOverride"]'),
    ).toBeNull();
    expect(target.textContent).not.toContain('App override');
  });

  it('renders the app column read-only when shown but not editable', () => {
    const target = render({
      prompts: [{ ...DRAFTS, appTemplate: 'App text.' }],
      showApp: true,
    });

    expect(
      target.querySelector('input[type="checkbox"][name="appOverride"]'),
    ).toBeNull();
    expect(target.querySelector('.ps-readonly')?.textContent?.trim()).toBe(
      'App text.',
    );
  });

  it('renders an editable app column for a platform-admin tier', () => {
    const target = render({
      prompts: [{ ...DRAFTS, appTemplate: 'App text.' }],
      showApp: true,
      appEditable: true,
    });

    expect(checkboxNamed(target, 'appOverride').checked).toBe(true);
    expect(textareaNamed(target, 'appTemplate').value).toBe('App text.');
  });

  it('hands the chosen tenant text to onSave instead of submitting', () => {
    const onSave = vi.fn();
    const target = render({ prompts: [DRAFTS], onSave });

    toggleCheckbox(checkboxNamed(target, 'tenantOverride'), true);
    typeInto(textareaNamed(target, 'tenantTemplate'), 'New tenant text.');
    const event = submitFirstForm(target);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      key: DRAFTS.key,
      tenantTemplate: 'New tenant text.',
    });
    // The host owns the write, so the form must not also POST.
    expect(event.defaultPrevented).toBe(true);
  });

  it('reports a revert (null) when the tenant checkbox is unchecked, regardless of the textarea text', () => {
    const onSave = vi.fn();
    const target = render({
      prompts: [{ ...DRAFTS, tenantTemplate: 'Existing override.' }],
      onSave,
    });

    toggleCheckbox(checkboxNamed(target, 'tenantOverride'), false);
    submitFirstForm(target);

    expect(onSave).toHaveBeenCalledWith({
      key: DRAFTS.key,
      tenantTemplate: null,
    });
  });

  it('reports an app change only when the app column is editable', () => {
    const readOnly = vi.fn();
    const readOnlyTarget = render({
      prompts: [DRAFTS],
      showApp: true,
      onSave: readOnly,
    });
    submitFirstForm(readOnlyTarget);
    expect(readOnly.mock.calls[0][0]).not.toHaveProperty('appTemplate');

    const editable = vi.fn();
    const editableTarget = render({
      prompts: [DRAFTS],
      showApp: true,
      appEditable: true,
      onSave: editable,
    });
    toggleCheckbox(checkboxNamed(editableTarget, 'appOverride'), true);
    typeInto(textareaNamed(editableTarget, 'appTemplate'), 'New app text.');
    submitFirstForm(editableTarget);
    expect(editable).toHaveBeenCalledWith({
      key: DRAFTS.key,
      // The tenant checkbox was never checked, so it reverts regardless of
      // the (unedited) textarea text.
      tenantTemplate: null,
      appTemplate: 'New app text.',
    });
  });

  it('posts to a SvelteKit form action when no callback is given', () => {
    const target = render({ prompts: [DRAFTS], formAction: '?/savePrompt' });

    const form = target.querySelector('form');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form?.getAttribute('action')).toBe('?/savePrompt');
    expect(
      form?.querySelector<HTMLInputElement>('input[name="key"]')?.value,
    ).toBe(DRAFTS.key);

    expect(submitFirstForm(target).defaultPrevented).toBe(false);
  });

  it('disables saving while busy, and when the host wired neither a callback nor an action', () => {
    const idle = render({ prompts: [DRAFTS], onSave: vi.fn() });
    expect(
      idle.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(false);

    const busy = render({ prompts: [DRAFTS], onSave: vi.fn(), busy: true });
    expect(
      busy.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(true);
    expect(checkboxNamed(busy, 'tenantOverride').disabled).toBe(true);
    expect(textareaNamed(busy, 'tenantTemplate').disabled).toBe(true);

    const unwired = render({ prompts: [DRAFTS] });
    expect(
      unwired.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
  });

  it('disables the editor entirely when the definition marks the template not editable', () => {
    const target = render({
      prompts: [{ ...DRAFTS, editable: { template: false } }],
    });

    expect(checkboxNamed(target, 'tenantOverride').disabled).toBe(true);
    expect(textareaNamed(target, 'tenantTemplate').disabled).toBe(true);
  });

  it('never submits a non-editable row, so an existing override is not silently reverted', () => {
    const onSave = vi.fn();
    const target = render({
      prompts: [
        {
          ...DRAFTS,
          editable: { template: false },
          tenantTemplate: 'Existing tenant text.',
          supplyingLevel: 'tenant',
        },
      ],
      onSave,
      formAction: '?/savePrompt',
    });

    expect(
      target.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
    const event = submitFirstForm(target);
    expect(onSave).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows host-supplied status and error text', () => {
    const target = render({
      prompts: [DRAFTS],
      message: 'Prompt overrides saved.',
      error: 'Not permitted.',
    });

    expect(target.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Prompt overrides saved.',
    );
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Not permitted.',
    );
  });

  it('discards an unsaved edit when the prompt rows are replaced', () => {
    const onSave = vi.fn();
    const { target, harness } = renderWithHarness({
      initial: [DRAFTS],
      onSave,
    });

    toggleCheckbox(checkboxNamed(target, 'tenantOverride'), true);
    typeInto(textareaNamed(target, 'tenantTemplate'), 'Unsaved edit.');
    // A reload, or a switch to another tenant whose rows carry the same keys.
    harness.setPrompts([{ ...DRAFTS }]);
    flushSync();

    expect(checkboxNamed(target, 'tenantOverride').checked).toBe(false);
    submitFirstForm(target);
    expect(onSave).toHaveBeenCalledWith({
      key: DRAFTS.key,
      tenantTemplate: null,
    });
  });

  it('discards an unsaved edit when contextKey changes', () => {
    const { target, harness } = renderWithHarness({
      initial: [DRAFTS],
      contextKey: 'tenant-a',
      onSave: vi.fn(),
    });

    toggleCheckbox(checkboxNamed(target, 'tenantOverride'), true);
    harness.setContextKey('tenant-b');
    flushSync();

    expect(checkboxNamed(target, 'tenantOverride').checked).toBe(false);
  });

  it('keeps an unsaved edit while the context is unchanged', () => {
    const { target, harness } = renderWithHarness({
      initial: [DRAFTS],
      contextKey: 'tenant-a',
      onSave: vi.fn(),
    });

    toggleCheckbox(checkboxNamed(target, 'tenantOverride'), true);
    harness.setPrompts([{ ...DRAFTS }]);
    flushSync();

    expect(checkboxNamed(target, 'tenantOverride').checked).toBe(true);
  });

  it('fetches nothing: the panel is presentational', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const target = render({ prompts: [DRAFTS], onSave: vi.fn() });
    toggleCheckbox(checkboxNamed(target, 'tenantOverride'), true);
    submitFirstForm(target);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
