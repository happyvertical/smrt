/**
 * The Export tab mounted in a DOM: its sections, the action groups (Reset is
 * never beside Copy prompt), and the Copy button with a stubbed clipboard.
 */
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExportPanel from '../src/lib/components/ExportPanel.svelte';
import { buildAgentPrompt } from '../src/lib/cookbook/prompt.ts';
import {
  CookbookStore,
  cookbookStore,
} from '../src/lib/cookbook/store.svelte.ts';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import { kitchenState } from '../src/lib/kitchen/state.svelte.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';

const bakery = getLibraryCookbook('bakery');
if (!bakery) throw new Error('the bakery cookbook is missing');

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

const buttons = (root: ParentNode) =>
  [...root.querySelectorAll('button')].map((b) => b.textContent?.trim());

describe('the export panel', () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | undefined;
  const previous = new CookbookStore();
  const context = new Map<unknown, unknown>([[DATA_SOURCE_KEY, {}]]);

  beforeEach(() => {
    previous.apply(cookbookStore.snapshot());
    cookbookStore.apply({ ...bakery.document, name: 'Bakery' });
    kitchenState.configure(undefined);
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (app) unmount(app);
    app = undefined;
    target.remove();
    cookbookStore.apply(previous.snapshot());
    vi.useRealTimers();
  });

  it('renders the summary, the prompt, the file and the replace sections', async () => {
    app = mount(ExportPanel, { target, context });
    await settle();
    const section = (id: string) =>
      target.querySelector(`[data-export-section="${id}"]`);
    const summary = section('summary');
    expect(summary?.querySelector('dt')?.textContent).toBe(
      `${bakery.document.recipes.length} recipes`,
    );
    expect(
      summary?.querySelectorAll('[data-smrt-component="Chip"]').length,
    ).toBeGreaterThanOrEqual(bakery.document.recipes.length);
    expect(summary?.textContent).toContain('Theme');
    expect(summary?.textContent).toContain('brand colour #b45309');
    expect(summary?.textContent).toContain('Layout');

    const box = section('prompt')?.querySelector('textarea');
    expect(box?.readOnly).toBe(true);
    expect(box?.value).toBe(buildAgentPrompt(cookbookStore.snapshot()).text);
    expect(section('prompt')?.textContent).toMatch(/About \d+(\.\d)? KB/);

    const file = section('file');
    expect(file?.textContent).toContain('bakery.cookbook.json');
    expect(file?.textContent).toMatch(/\(\d+(\.\d)? KB\)/);
    expect(file?.querySelector('[data-export-command]')?.textContent).toMatch(
      /^npx -y @happyvertical\/smrt-cli@\d+\.\d+\.\d+ cookbook apply bakery\.cookbook\.json bakery$/,
    );
    const preview = file?.querySelector('details');
    expect(preview?.textContent).toContain('Preview JSON');
    expect(
      JSON.parse(preview?.querySelector('pre')?.textContent ?? ''),
    ).toEqual(cookbookStore.snapshot());
  });

  it('keeps Reset away from the primary actions', async () => {
    app = mount(ExportPanel, { target, context });
    await settle();
    const primary = target.querySelector('[data-export-actions="primary"]');
    const replace = target.querySelector('[data-export-actions="replace"]');
    expect(primary && buttons(primary)).toEqual([
      'Copy prompt',
      'Download cookbook',
    ]);
    expect(replace && buttons(replace)).toEqual(['Import cookbook…', 'Reset']);
    const all = buttons(target);
    expect(all.indexOf('Reset')).toBeGreaterThan(all.indexOf('Copy command'));
  });

  it('adds Send to kitchen to the primary group when a kitchen is linked', async () => {
    kitchenState.configure({ endpoint: '/api/kitchen/cookbook' }, 'tok');
    app = mount(ExportPanel, { target, context });
    await settle();
    const primary = target.querySelector('[data-export-actions="primary"]');
    expect(primary && buttons(primary)).toEqual([
      'Copy prompt',
      'Send to kitchen',
      'Download cookbook',
    ]);
  });

  it('says nothing is customised for an empty cookbook', async () => {
    cookbookStore.reset();
    app = mount(ExportPanel, { target, context });
    await settle();
    const summary = target.querySelector('[data-export-section="summary"]');
    expect(summary?.textContent).toContain('Nothing customised yet');
    expect(summary?.querySelector('dl')).toBeNull();
    expect(target.textContent).toContain('my-app.cookbook.json');
  });

  it('copies the prompt and confirms, then returns to its label', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_text: string) => {});
    app = mount(ExportPanel, { target, props: { write }, context });
    flushSync();
    const copy = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Copy prompt',
    );
    copy?.click();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(
      buildAgentPrompt(cookbookStore.snapshot()).text,
    );
    expect(copy?.textContent?.trim()).toBe('Copied');
    expect(
      target.querySelector('[data-export-section="prompt"] [role="status"]')
        ?.textContent,
    ).toBe('Prompt copied.');
    await vi.advanceTimersByTimeAsync(2100);
    flushSync();
    expect(copy?.textContent?.trim()).toBe('Copy prompt');
  });

  it('selects the text and says how to copy when the clipboard fails', async () => {
    const write = vi.fn(async (_text: string) => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    app = mount(ExportPanel, { target, props: { write }, context });
    flushSync();
    const copy = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Copy prompt',
    );
    copy?.click();
    await settle();
    expect(copy?.textContent?.trim()).toBe('Copy prompt');
    const box = target.querySelector<HTMLTextAreaElement>(
      '[data-export-section="prompt"] textarea',
    );
    expect(document.activeElement).toBe(box);
    expect(
      target.querySelector('[data-export-section="prompt"] [role="status"]')
        ?.textContent,
    ).toContain('Ctrl+C');
  });
});
