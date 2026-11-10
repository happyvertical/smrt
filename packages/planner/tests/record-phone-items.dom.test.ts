/**
 * The record page's edit mode on a phone (smrt#3718): the line-items editor
 * (`ChildRecords`) renders inside the edit sheet, not under it, and the
 * view page has no second line-items panel besides the overview's.
 */
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalog } from '../src/lib/catalog/index.ts';
import RecordView from '../src/lib/components/RecordView.svelte';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { childLinks } from '../src/lib/recipes/plumbing.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

/** A viewport `width` px wide, as `matchMedia` reports it. */
function viewport(width: number): void {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*([\d.]+)(rem|px)/.exec(query);
    const px = min ? Number(min[1]) * (min[2] === 'rem' ? 16 : 1) : 0;
    return {
      matches: width >= px,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

describe('the record page on a phone', () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    recipeState.clear();
    recipeState.add('commerce.sales');
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (app) unmount(app);
    app = undefined;
    target.remove();
    document.body.innerHTML = '';
  });

  async function render(mode: 'view' | 'edit', modelName = 'Order') {
    const source = createMemoryDataSource({
      children: {
        models: catalog.packages.flatMap((p) => p.models),
        links: (id) => childLinks(catalog, recipes, id),
      },
    });
    const shown = catalog.packages
      .flatMap((p) => p.models)
      .find((m) => m.id === `@happyvertical/smrt-commerce:${modelName}`);
    if (!shown) throw new Error(`${modelName} missing from the catalog`);
    const [row] = await source.list(shown);
    app = mount(RecordView, {
      target,
      props: {
        packageId: 'commerce',
        modelName,
        recordId: String(row?.id),
        mode,
        href: (path: string) => `#${path}`,
        navigate: () => {},
      },
      context: new Map([[DATA_SOURCE_KEY, source]]),
    });
    await settle();
  }

  it('puts the line-items editor inside the edit sheet', async () => {
    viewport(375);
    await render('edit');
    const sheet = document.querySelector(
      '[data-smrt-component="RecordScreen"] .smrt-record-screen__sheet-body',
    );
    expect(sheet).not.toBeNull();
    const items = sheet?.querySelector('.smrt-record-screen__items');
    expect(items?.textContent).toContain('Line items');
    // Not also under the sheet, in the page.
    const main = document.querySelector('.smrt-record-screen__main');
    expect(main?.querySelector('.smrt-record-screen__items')).toBeNull();
  });

  it('puts it in the edit column on desktop, and nowhere in view mode', async () => {
    viewport(1280);
    await render('edit');
    const aside = document.querySelector('.smrt-record-screen__aside');
    expect(
      aside?.querySelector('.smrt-record-screen__items')?.textContent,
    ).toContain('Line items');
    if (app) unmount(app);
    app = undefined;
    target.innerHTML = '';
    await render('view');
    expect(document.querySelector('.smrt-record-screen__items')).toBeNull();
  });

  it('heads a document with its kind and identifier, a party with its name once', async () => {
    viewport(1280);
    await render('view');
    const heading = document.querySelector('h1')?.textContent ?? '';
    expect(heading).toMatch(/^\s*Order [A-Z]{3}-\d{4}\s*$/);
    if (app) unmount(app);
    app = undefined;
    target.innerHTML = '';
    await render('view', 'Customer');
    const name = document.querySelector('h1')?.textContent?.trim() ?? '';
    expect(name.length).toBeGreaterThan(0);
    const screen = document.querySelector('.smrt-record-screen__main');
    const text = screen?.textContent ?? '';
    // The Profile name is the title, not also a fact or a details cell.
    expect(text.split(name).length - 1).toBe(1);
  });
});
