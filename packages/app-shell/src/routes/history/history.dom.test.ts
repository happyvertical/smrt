import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VersionInfo } from '../../lib/ui/types.ts';
import { description, versions } from '../../test/draft-fixtures.ts';
import History from './+page.svelte';

let component: ReturnType<typeof mount>;
let container: HTMLDivElement;
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
  vi.unstubAllGlobals();
});
async function render(
  rows: VersionInfo[] = versions.map((version) => ({
    ...version,
    humanSummary: version.summary,
  })),
) {
  component = mount(History, {
    target: container,
    props: {
      data: { versions: rows, description: description('live') },
    } as never,
  });
  await tick();
}

describe('publish history', () => {
  it.each([
    200, 202,
  ])('groups versions and undoes the publish through the first parent (%s)', async (status) => {
    const result =
      status === 202
        ? {
            status: 'pending_approval',
            approvalId: 'undo',
            summary: 'Undo publish',
            preview: {},
          }
        : { version: 1, summary: 'Undo publish' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(result), { status })),
    );
    await render();
    expect(
      [...container.querySelectorAll('h2')].filter(
        (h) => h.textContent === 'Better orders',
      ),
    ).toHaveLength(1);
    expect(container.textContent).toContain('Change 2');
    expect(container.textContent).toContain('Change 3');
    expect(
      [...container.querySelectorAll('button')].filter(
        (b) => b.textContent?.trim() === 'Undo this publish',
      ),
    ).toHaveLength(1);
    expect(button('Undo this change')).toBeUndefined();
    button('Undo this publish')?.click();
    await tick();
    expect(container.querySelector('dialog[open]')?.textContent).toContain(
      'Later changes are also taken back',
    );
    button('Undo')?.click();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/shell/undo-to?target=live',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ version: 1 }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        status === 202
          ? 'Waiting for your approval'
          : 'Undone: the selected change',
      ),
    );
    if (status === 202)
      expect(container.querySelector('a[href="/approvals"]')).toBeTruthy();
  });
  it('offers no undo for a publish that crossed a purged version', async () => {
    await render(versions.map((v) => ({ ...v, purged: v.version === 2 })));
    expect(button('Undo this publish')).toBeUndefined();
  });
});

it('renders label headings from real engine versions, including rename, removal and undo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-labels-'));
  try {
    const output = join(dir, 'versions.json');
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'test-support/history-engine-summaries.ts', output],
      { timeout: 60000 },
    );
    const payload = JSON.parse(readFileSync(output, 'utf8'));
    await render(payload.versions);
    const headings = [...container.querySelectorAll('h2')].map(
      (h) => h.textContent,
    );
    expect(headings).toContain('Load 2 records into Orders');
    expect(headings).toContain('Merge 1 record in Orders');
    expect(headings).toContain('Change calculation: Total in Orders');
    expect(headings).toContain('Add code to Orders');
    expect(headings).toContain('Change code in Orders');
    expect(payload.headings.some((h: string) => h.startsWith('Undo:'))).toBe(
      true,
    );
    expect(headings).toContain('Make linked records from Category in Orders');
    expect(headings).toContain(
      'Rename field Original value to renamedValue in Orders',
    );
    expect(headings).toContain('Remove field: Original value in Orders');
    expect(headings.join(' ')).not.toMatch(
      /Order\.|oldValue|[a-f0-9]{8}-[a-f0-9]{4}-/,
    );
    expect(payload.headings).toContain('Merge 1 record in Orders');
    mkdirSync('/tmp/smrt-4916-inplace/round5', { recursive: true });
    writeFileSync(
      '/tmp/smrt-4916-inplace/round5/f3-history-headings.txt',
      headings.join('\n'),
    );
    await unmount(component);
    await render(
      payload.versions.map((version: Record<string, unknown>) => ({
        ...version,
        humanSummary: undefined,
      })),
    );
    expect(
      [...container.querySelectorAll('article h2')].every(
        (heading) => heading.textContent?.trim() === 'Change to your app',
      ),
    ).toBe(true);
    button('Undo this change')?.click();
    await tick();
    expect(container.textContent).not.toMatch(
      /Order\.|oldValue|[a-f0-9]{8}-[a-f0-9]{4}-/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
