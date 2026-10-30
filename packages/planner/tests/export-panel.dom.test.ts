/**
 * The Export tab mounted in a DOM: the summary, prompt and download cards all
 * visible by default, Import and Reset collapsed apart from them, and the Copy
 * button with a stubbed clipboard.
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

  it('runs a host action first with exact context and preserves download after failure', async () => {
    const run = vi.fn(
      async (
        _context: import('../src/lib/planner/types.ts').PlannerExportContext,
      ) => {
        throw new Error('Host unavailable');
      },
    );
    app = mount(ExportPanel, {
      target,
      context,
      props: { exportAction: { label: 'Continue', run } },
    });
    await settle();
    const actions = target.querySelector('[data-export-actions="primary"]');
    if (!actions) throw new Error('Expected primary export actions');
    expect(buttons(actions)[0]).toBe('Continue');
    const hostAction = actions.querySelector('button');
    if (!hostAction) throw new Error('Expected primary host action');
    hostAction.click();
    await settle();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      export: { cookbook: cookbookStore.snapshot() },
      conversation: [],
    });
    expect(target.textContent).toContain('Host unavailable');
    const download = [
      ...target.querySelectorAll(
        '[data-export-section="file"] [data-export-actions="download"] button',
      ),
    ].find((b) => b.textContent?.trim() === 'Download cookbook') as
      | HTMLButtonElement
      | undefined;
    expect(download?.disabled).toBe(false);
  });

  it('puts the host action above the cards and keeps only Import and Reset collapsed', async () => {
    app = mount(ExportPanel, {
      target,
      context,
      props: { exportAction: { label: 'Build it', run: vi.fn() } },
    });
    await settle();
    expect(buttons(target).slice(0, 3)).toEqual([
      'Build it',
      'Copy prompt',
      'Copy command',
    ]);
    const build = target.querySelector('.build-step');
    const cards = [...target.querySelectorAll('[data-smrt-component="Card"]')];
    expect(build?.textContent).toContain('Build your app');
    expect(cards).toHaveLength(2);
    for (const card of cards)
      expect(
        (build?.compareDocumentPosition(card) ?? 0) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    expect(target.querySelector('h2')?.textContent).toBe('Export');
    expect(
      [...target.querySelectorAll('h3')].map((h) => h.textContent),
    ).toEqual([
      'Build your app',
      'In this cookbook',
      'Copy prompt',
      'Download cookbook',
    ]);
    const closed = [...target.querySelectorAll('details')];
    expect(
      closed.map((d) =>
        d.querySelector('summary')?.textContent?.replace('⌄', '').trim(),
      ),
    ).toEqual(['Preview JSON', 'Import or reset project']);
    for (const details of closed) expect(details.open).toBe(false);
  });

  it('downloads the exact same native export text and filename the host receives', async () => {
    let captured:
      | import('../src/lib/planner/types.ts').PlannerExportContext
      | undefined;
    let blob: Blob | undefined;
    let filename = '';
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((value) => {
        blob = value as Blob;
        return 'blob:export-test';
      });
    const revoke = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        filename = this.download;
      });
    try {
      app = mount(ExportPanel, {
        target,
        context,
        props: {
          exportAction: {
            label: 'Continue',
            run(
              value: import('../src/lib/planner/types.ts').PlannerExportContext,
            ) {
              captured = value;
            },
          },
        },
      });
      await settle();
      const find = (label: string) => {
        const found = [...target.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === label,
        );
        if (!found) throw new Error(`Expected a ${label} button`);
        return found;
      };
      find('Continue').click();
      await settle();
      find('Download cookbook').click();
      await settle();
      expect(filename).toBe(captured?.export.fileName);
      expect(await blob?.text()).toBe(captured?.export.text);
    } finally {
      create.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
    }
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

    // Summary, prompt and run command are never inside a closed disclosure.
    expect(summary?.closest('details')).toBeNull();
    expect(section('prompt')?.closest('details')).toBeNull();
    const box = section('prompt')?.querySelector('textarea');
    expect(box?.closest('details')).toBeNull();
    expect(box?.readOnly).toBe(true);
    expect(box?.getAttribute('aria-label')).toBe(
      'Prompt for your coding agent',
    );
    expect(box?.value).toBe(buildAgentPrompt(cookbookStore.snapshot()).text);
    expect(section('prompt')?.textContent).toMatch(/About \d+(\.\d)? KB/);

    const file = section('file');
    expect(file?.textContent).toContain('bakery.cookbook.json');
    expect(file?.textContent).toMatch(/\(\d+(\.\d)? KB\)/);
    expect(
      file?.querySelector('[data-export-command]')?.closest('details'),
    ).toBeNull();
    expect(file?.querySelector('[data-export-command]')?.textContent).toMatch(
      /^npx -y @happyvertical\/smrt-cli@\d+\.\d+\.\d+ cookbook apply bakery\.cookbook\.json bakery$/,
    );
    const preview = file?.querySelector('details');
    expect(preview?.textContent).toContain('Preview JSON');
    expect(
      JSON.parse(preview?.querySelector('pre')?.textContent ?? ''),
    ).toEqual(cookbookStore.snapshot());
  });

  it('keeps Import and Reset collapsed, apart from the cards', async () => {
    app = mount(ExportPanel, { target, context });
    await settle();
    const download = target.querySelector('[data-export-actions="download"]');
    const replace = target.querySelector('[data-export-actions="replace"]');
    expect(download && buttons(download)).toEqual(['Download cookbook']);
    expect(replace && buttons(replace)).toEqual(['Import cookbook…']);
    const section = target.querySelector('[data-export-section="replace"]');
    expect(section?.textContent).toContain('Reset project');
    expect(section?.querySelector('details')?.open).toBe(false);
    expect(section?.querySelector('summary')?.textContent).toContain(
      'Import or reset project',
    );
    const all = buttons(target);
    expect(all.indexOf('Reset project')).toBeGreaterThan(
      all.indexOf('Copy command'),
    );
  });

  it('adds Send to kitchen to the download card when a kitchen is linked', async () => {
    kitchenState.configure({ endpoint: '/api/kitchen/cookbook' }, 'tok');
    app = mount(ExportPanel, { target, context });
    await settle();
    const download = target.querySelector('[data-export-actions="download"]');
    expect(download && buttons(download)).toEqual([
      'Download cookbook',
      'Send to kitchen',
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
    expect(box?.closest('details')).toBeNull();
    expect(document.activeElement).toBe(box);
    expect(
      target.querySelector('[data-export-section="prompt"] [role="status"]')
        ?.textContent,
    ).toContain('Ctrl+C');
  });
});
