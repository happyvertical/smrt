// @vitest-environment jsdom

import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentData } from '../../mock-smrt-client.js';
import ContentList from './ContentList.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];
const identity = { surfaceId: 'content-list', kind: 'table' as const };
const contents: ContentData[] = [
  {
    id: 'article-1',
    type: 'article',
    title: 'Deleted article',
    status: 'deleted',
  },
  {
    id: 'document-2',
    type: 'document',
    title: 'Deleted document',
    status: 'deleted',
  },
  { id: 'mirror-3', type: 'mirror', title: 'Active mirror', status: 'draft' },
];

function result(phase: 'preview' | 'apply'): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: 'lifecycle-request',
    identity,
    actionId: 'restore',
    phase,
    ok: true,
    ...(phase === 'preview' ? { confirmationToken: 'restore-token' } : {}),
    details: {
      count: 2,
      accepted: phase === 'apply' ? 1 : 2,
      skipped: phase === 'apply' ? 1 : 0,
      failed: 0,
      auditReference: 'audit-restore',
      outcomes:
        phase === 'apply'
          ? [
              { rowId: 'article-1', status: 'accepted' },
              {
                rowId: 'document-2',
                status: 'skipped',
                reason: 'publish_readiness_failed',
              },
            ]
          : [],
    },
  };
}

function button(target: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(target.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
}

function checkbox(target: HTMLElement, name: string): HTMLInputElement {
  const found = target.querySelector<HTMLInputElement>(
    `input[type="checkbox"][aria-label="${name}"]`,
  );
  if (!found) throw new Error(`No checkbox named ${name}`);
  return found;
}

function renderTrash() {
  const preview = vi.fn(async () => result('preview'));
  const apply = vi.fn(async () => result('apply'));
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ContentList, {
      target,
      props: {
        contents,
        lifecycleMode: 'trash',
        lifecycle: { client: { preview, apply }, identity },
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        onAdd: vi.fn(),
      },
    }),
  );
  flushSync();
  return { target, preview, apply };
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = '';
});

describe('ContentList trash lifecycle integration', () => {
  it('locks the trash predicate and removes legacy edit/delete mutations', () => {
    const { target } = renderTrash();

    expect(target.textContent).toContain('Deleted article');
    expect(target.textContent).toContain('Deleted document');
    expect(target.textContent).not.toContain('Active mirror');
    expect(
      target.querySelector('select[aria-label="Filter by status"]'),
    ).toBeNull();
    expect(target.querySelector('button[aria-label="Delete"]')).toBeNull();
    expect(target.querySelector('button[aria-label="Edit"]')).toBeNull();
  });

  it('keeps server-skipped rows selected after restore and shows the audit', async () => {
    const { target, preview, apply } = renderTrash();
    checkbox(target, 'Select Deleted article').click();
    checkbox(target, 'Select Deleted document').click();
    flushSync();
    expect(target.textContent).toContain('2 selected');

    button(target, 'Restore selected').click();
    await tick();
    await tick();
    button(target, 'Confirm 2').click();
    await tick();
    await tick();

    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'restore',
        selection: {
          scope: 'explicit-ids',
          rowIds: ['article-1', 'document-2'],
        },
        payload: { status: 'draft' },
      }),
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(target.textContent).toContain('1 selected');
    expect(target.textContent).toContain('audit-restore');
    expect(target.textContent).toContain(
      'document-2: publish_readiness_failed',
    );
  });
});
