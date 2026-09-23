// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureSettingsView } from '../types.js';
import FeatureSettingsPanel from './FeatureSettingsPanel.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];

function render(props: Record<string, unknown> = {}): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(FeatureSettingsPanel, { target, props }));
  flushSync();
  return target;
}

afterEach(() => {
  while (mounted.length > 0) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const DRAFTS: FeatureSettingsView = {
  featureKey: '@test/app:Invoice#drafts',
  label: 'Invoice drafts',
  description: 'Save invoices as drafts before sending.',
  packageName: '@test/app',
  defaultEnabled: false,
  effectiveEnabled: false,
  globalEffect: null,
  tenantEffect: null,
};

function selectNamed(target: HTMLElement, name: string): HTMLSelectElement {
  const element = target.querySelector<HTMLSelectElement>(
    `select[name="${name}"]`,
  );
  if (!element) throw new Error(`no <select name="${name}">`);
  return element;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.textContent?.trim() ?? '');
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
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

describe('FeatureSettingsPanel', () => {
  it('renders the label, description, key and effective state of each feature', () => {
    const target = render({
      features: [
        DRAFTS,
        {
          featureKey: '@test/app:Invoice#reports',
          label: 'Reports',
          defaultEnabled: true,
          effectiveEnabled: true,
        },
      ],
    });

    const text = target.textContent ?? '';
    expect(text).toContain('Invoice drafts');
    expect(text).toContain('Save invoices as drafts before sending.');
    expect(text).toContain('@test/app:Invoice#drafts');
    expect(text).toContain('Disabled');
    expect(text).toContain('Reports');
    expect(text).toContain('Enabled');
    expect(target.querySelectorAll('form')).toHaveLength(2);
  });

  it('falls back to the key when a definition has no label or description', () => {
    const target = render({
      features: [
        {
          featureKey: '@test/app:Invoice#bare',
          defaultEnabled: false,
          effectiveEnabled: false,
        },
      ],
    });

    expect(target.querySelector('.fs-title')?.textContent?.trim()).toBe(
      '@test/app:Invoice#bare',
    );
  });

  it('renders an empty state when there are no features', () => {
    const target = render({ features: [] });

    expect(target.querySelector('form')).toBeNull();
    expect(target.textContent).toContain('No features are registered yet');
  });

  it('offers Default / Enable / Disable, naming the default it returns to', () => {
    const target = render({ features: [DRAFTS] });

    const tenant = selectNamed(target, 'tenantEffect');
    expect([...tenant.options].map((option) => option.value)).toEqual([
      'inherit',
      'enable',
      'disable',
    ]);
    expect(optionLabels(tenant)).toEqual([
      'Default (disabled)',
      'Enable',
      'Disable',
    ]);
    expect(tenant.value).toBe('inherit');
  });

  it('labels the default option from defaultEnabled', () => {
    const target = render({
      features: [{ ...DRAFTS, defaultEnabled: true, effectiveEnabled: true }],
    });

    expect(optionLabels(selectNamed(target, 'tenantEffect'))[0]).toBe(
      'Default (enabled)',
    );
  });

  it('preselects the current tenant override', () => {
    const target = render({
      features: [{ ...DRAFTS, tenantEffect: 'disable' }],
    });

    expect(selectNamed(target, 'tenantEffect').value).toBe('disable');
  });

  it('omits the global column unless the host asks for it', () => {
    const target = render({
      features: [{ ...DRAFTS, globalEffect: 'enable' }],
    });

    expect(target.querySelector('select[name="globalEffect"]')).toBeNull();
    expect(target.textContent).not.toContain('Global');
  });

  it('renders the global column read-only when it is shown but not editable', () => {
    const target = render({
      features: [{ ...DRAFTS, globalEffect: 'enable' }],
      showGlobal: true,
    });

    expect(target.querySelector('select[name="globalEffect"]')).toBeNull();
    expect(target.textContent).toContain('Global');
    expect(target.querySelector('.fs-readonly')?.textContent?.trim()).toBe(
      'Enabled',
    );
  });

  it('renders an editable global column for a platform-admin tier', () => {
    const target = render({
      features: [{ ...DRAFTS, globalEffect: 'enable' }],
      showGlobal: true,
      globalEditable: true,
    });

    const global = selectNamed(target, 'globalEffect');
    expect(global.value).toBe('enable');
    expect(optionLabels(global)).toEqual([
      'Default (disabled)',
      'Enable',
      'Disable',
    ]);
  });

  it('hands the chosen tenant effect to onSave instead of submitting', () => {
    const onSave = vi.fn();
    const target = render({ features: [DRAFTS], onSave });

    choose(selectNamed(target, 'tenantEffect'), 'enable');
    const event = submitFirstForm(target);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      featureKey: DRAFTS.featureKey,
      tenantEffect: 'enable',
    });
    // The host owns the write, so the form must not also POST.
    expect(event.defaultPrevented).toBe(true);
  });

  it('can return a feature to its default', () => {
    const onSave = vi.fn();
    const target = render({
      features: [{ ...DRAFTS, tenantEffect: 'disable' }],
      onSave,
    });

    choose(selectNamed(target, 'tenantEffect'), 'inherit');
    submitFirstForm(target);

    expect(onSave).toHaveBeenCalledWith({
      featureKey: DRAFTS.featureKey,
      tenantEffect: 'inherit',
    });
  });

  it('reports a global effect only when the global column is editable', () => {
    const readOnly = vi.fn();
    const readOnlyTarget = render({
      features: [DRAFTS],
      showGlobal: true,
      onSave: readOnly,
    });
    submitFirstForm(readOnlyTarget);
    expect(readOnly.mock.calls[0][0]).not.toHaveProperty('globalEffect');

    const editable = vi.fn();
    const editableTarget = render({
      features: [DRAFTS],
      showGlobal: true,
      globalEditable: true,
      onSave: editable,
    });
    choose(selectNamed(editableTarget, 'globalEffect'), 'disable');
    submitFirstForm(editableTarget);
    expect(editable).toHaveBeenCalledWith({
      featureKey: DRAFTS.featureKey,
      tenantEffect: 'inherit',
      globalEffect: 'disable',
    });
  });

  it('posts to a SvelteKit form action when no callback is given', () => {
    const target = render({ features: [DRAFTS], formAction: '?/saveFeature' });

    const form = target.querySelector('form');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form?.getAttribute('action')).toBe('?/saveFeature');
    expect(
      form?.querySelector<HTMLInputElement>('input[name="featureKey"]')?.value,
    ).toBe(DRAFTS.featureKey);

    expect(submitFirstForm(target).defaultPrevented).toBe(false);
  });

  it('disables saving while busy, and when the host wired neither a callback nor an action', () => {
    const idle = render({ features: [DRAFTS], onSave: vi.fn() });
    expect(
      idle.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(false);

    const busy = render({ features: [DRAFTS], onSave: vi.fn(), busy: true });
    expect(
      busy.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(true);
    expect(selectNamed(busy, 'tenantEffect').disabled).toBe(true);

    const unwired = render({ features: [DRAFTS] });
    expect(
      unwired.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
  });

  it('shows host-supplied status and error text', () => {
    const target = render({
      features: [DRAFTS],
      message: 'Feature overrides saved.',
      error: 'Not permitted.',
    });

    expect(target.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Feature overrides saved.',
    );
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Not permitted.',
    );
  });

  it('fetches nothing: the panel is presentational', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const target = render({ features: [DRAFTS], onSave: vi.fn() });
    choose(selectNamed(target, 'tenantEffect'), 'enable');
    submitFirstForm(target);

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
