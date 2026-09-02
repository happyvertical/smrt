// @vitest-environment jsdom

import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentListLifecyclePanel from './ContentListLifecyclePanel.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];
const identity = { surfaceId: 'content-list', kind: 'table' as const };

function lifecycleResult(
  phase: 'preview' | 'apply',
  overrides: Partial<DataSurfaceActionResult> = {},
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: 'request-1',
    identity,
    actionId: 'permanent-delete',
    phase,
    ok: true,
    ...(phase === 'preview' ? { confirmationToken: 'token-1' } : {}),
    details: {
      count: 2,
      accepted: phase === 'apply' ? 1 : 2,
      skipped: phase === 'apply' ? 1 : 0,
      failed: 0,
      representativeLabels: ['Article A', 'Document B'],
      auditReference: 'audit-2454',
      outcomes:
        phase === 'apply'
          ? [
              { rowId: 'article-1', status: 'accepted' },
              { rowId: 'document-2', status: 'skipped', reason: 'locked' },
            ]
          : [],
    },
    ...overrides,
  };
}

function button(target: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(target.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  const preview = vi.fn(async () => lifecycleResult('preview'));
  const apply = vi.fn(async () => lifecycleResult('apply'));
  const oncomplete = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ContentListLifecyclePanel, {
      target,
      props: {
        binding: {
          client: { preview, apply },
          identity,
        },
        mode: 'trash',
        selectedRowIds: ['article-1', 'document-2'],
        query: { version: 1, page: { limit: 20, offset: 0 } },
        queryFingerprint: 'server-query-fingerprint',
        exactMatchingCount: 2,
        viewKey: 'trash-query',
        oncomplete,
        ...overrides,
      },
    }),
  );
  flushSync();
  return { target, preview, apply, oncomplete };
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = '';
});

describe('ContentListLifecyclePanel', () => {
  it('exposes screen-reader-labelled restore and destructive trash actions', () => {
    const { target } = renderPanel();

    expect(
      target.querySelector('section[aria-label="Trash actions"]'),
    ).not.toBeNull();
    expect(
      target.querySelector('select[aria-label="Restore destination"]'),
    ).not.toBeNull();
    expect(button(target, 'Restore selected').disabled).toBe(false);
    expect(button(target, 'Delete selected permanently').disabled).toBe(false);
    expect(button(target, 'Empty trash').disabled).toBe(false);
  });

  it('binds empty trash to the settled server query fingerprint and count', async () => {
    const { target, preview } = renderPanel({ exactMatchingCount: 125 });
    button(target, 'Empty trash').click();
    await tick();
    await tick();

    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'permanent-delete',
        selection: {
          scope: 'all-matching',
          queryFingerprint: 'server-query-fingerprint',
        },
        target: expect.objectContaining({ expectedCount: 125 }),
      }),
    );
  });

  it('fails closed with an announced limit for a large matching selection', () => {
    const { target, preview } = renderPanel({ exactMatchingCount: 10_000 });

    expect(button(target, 'Empty trash').disabled).toBe(true);
    expect(target.textContent).toContain('Empty trash is limited to 200 items');
    expect(preview).not.toHaveBeenCalled();
  });

  it('requires the exact server-resolved count before permanent deletion', async () => {
    const { target, apply } = renderPanel();
    button(target, 'Delete selected permanently').click();
    await tick();
    await tick();

    const confirmation = target.querySelector<HTMLInputElement>(
      'input[aria-label="Type the resolved item count to confirm permanent deletion"]',
    );
    expect(confirmation).not.toBeNull();
    expect(button(target, 'Confirm 2').disabled).toBe(true);

    if (!confirmation) throw new Error('Missing count confirmation');
    confirmation.value = '1';
    confirmation.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSync();
    expect(button(target, 'Confirm 2').disabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();

    confirmation.value = '2';
    confirmation.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSync();
    expect(button(target, 'Confirm 2').disabled).toBe(false);
  });

  it('reports partial outcomes and an audit reference after apply', async () => {
    const { target, apply, oncomplete } = renderPanel();
    button(target, 'Delete selected permanently').click();
    await tick();
    await tick();
    const confirmation = target.querySelector<HTMLInputElement>(
      'input[aria-label="Type the resolved item count to confirm permanent deletion"]',
    );
    if (!confirmation) throw new Error('Missing count confirmation');
    confirmation.value = '2';
    confirmation.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSync();
    button(target, 'Confirm 2').click();
    await tick();
    await tick();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(oncomplete).toHaveBeenCalledTimes(1);
    expect(target.textContent).toContain('Audit reference:');
    expect(target.textContent).toContain('audit-2454');
    expect(target.textContent).toContain('document-2: locked');
  });

  it('announces visible progress while the lifecycle mutation is applying', async () => {
    let resolveApply!: (value: DataSurfaceActionResult) => void;
    const applyResult = new Promise<DataSurfaceActionResult>((resolve) => {
      resolveApply = resolve;
    });
    const apply = vi.fn(() => applyResult);
    const { target } = renderPanel({
      binding: {
        client: {
          preview: async () => lifecycleResult('preview'),
          apply,
        },
        identity,
      },
    });
    button(target, 'Delete selected permanently').click();
    await tick();
    await tick();
    const confirmation = target.querySelector<HTMLInputElement>(
      'input[aria-label="Type the resolved item count to confirm permanent deletion"]',
    );
    if (!confirmation) throw new Error('Missing count confirmation');
    confirmation.value = '2';
    confirmation.dispatchEvent(new InputEvent('input', { bubbles: true }));
    flushSync();

    button(target, 'Confirm 2').click();
    await tick();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      'Applying…',
    );
    expect(target.querySelector('button[aria-label="Close modal"]')).toBeNull();

    resolveApply(lifecycleResult('apply'));
    await tick();
    await tick();
  });

  it('closes the preview with Escape without applying', async () => {
    const { target, apply } = renderPanel();
    button(target, 'Delete selected permanently').click();
    await tick();
    await tick();
    const dialog = target.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    dialog?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await tick();

    expect(dialog?.open).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});
