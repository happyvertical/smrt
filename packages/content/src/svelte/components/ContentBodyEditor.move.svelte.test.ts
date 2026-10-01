// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentBodyEditor from './ContentBodyEditor.svelte';

const STORY =
  '<p>one</p><p>two</p><img src="/a/1.jpg" alt="" data-smrt-asset-id="a-1" data-smrt-inline-image="true" data-smrt-placement="block">';

const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  while (mounted.length) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
});

/** A host that keeps the editor's value, as the article editor does. */
function renderStory() {
  const onChange = vi.fn((change: { body: string }) => {
    props.value = change.body;
  });
  const props = $state({ value: STORY, format: 'html', onChange });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(ContentBodyEditor, { target, props }));
  flushSync();
  return { target, onChange };
}

describe('ContentBodyEditor moving a picture in the story', () => {
  function bodyOrder(surface: HTMLElement): string[] {
    return Array.from(surface.childNodes)
      .map((node) =>
        node.nodeName === 'IMG' ? 'img' : (node.textContent?.trim() ?? ''),
      )
      .filter(Boolean);
  }

  function selectPicture(surface: HTMLElement) {
    const image = surface.querySelector('img') as HTMLImageElement;
    image.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
  }

  function popoverButton(root: HTMLElement, label: string): HTMLButtonElement {
    const button = root.querySelector(
      `.image-control-popover button[aria-label="${label}"]`,
    ) as HTMLButtonElement | null;
    if (!button) throw new Error(`no "${label}" button`);
    return button;
  }

  it('moves the selected picture up and down, to the very top, with Move up / Move down', () => {
    const { target, onChange } = renderStory();
    const surface = target.querySelector('[contenteditable]') as HTMLElement;
    selectPicture(surface);
    expect(popoverButton(target, 'Move down').disabled).toBe(true);

    popoverButton(target, 'Move up').click();
    flushSync();
    expect(bodyOrder(surface)).toEqual(['one', 'img', 'two']);
    popoverButton(target, 'Move up').click();
    flushSync();
    expect(bodyOrder(surface)).toEqual(['img', 'one', 'two']);
    expect(popoverButton(target, 'Move up').disabled).toBe(true);
    // The story (and so the main picture rule) sees the new order.
    const last = onChange.mock.calls.at(-1)?.[0] as { body: string };
    expect(last.body.indexOf('data-smrt-asset-id="a-1"')).toBeLessThan(
      last.body.indexOf('one'),
    );

    popoverButton(target, 'Move down').click();
    flushSync();
    expect(bodyOrder(surface)).toEqual(['one', 'img', 'two']);
  });

  it('drags a picture in the story above the first paragraph, showing where it will land', () => {
    const { target, onChange } = renderStory();
    const surface = target.querySelector('[contenteditable]') as HTMLElement;
    const image = surface.querySelector('img') as HTMLImageElement;
    const data = new Map<string, string>();
    const dataTransfer = {
      files: [],
      effectAllowed: '',
      dropEffect: '',
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
    };
    function dragEvent(type: string, clientY: number): DragEvent {
      const event = new Event(type, {
        bubbles: true,
        cancelable: true,
      }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'clientX', { value: 10 });
      Object.defineProperty(event, 'clientY', { value: clientY });
      return event;
    }
    image.dispatchEvent(dragEvent('dragstart', 0));
    surface.dispatchEvent(dragEvent('dragover', -10));
    flushSync();
    expect(
      target.querySelector('[data-testid="body-drop-indicator"]'),
    ).not.toBeNull();
    surface.dispatchEvent(dragEvent('drop', -10));
    flushSync();
    expect(bodyOrder(surface)).toEqual(['img', 'one', 'two']);
    expect(
      target.querySelector('[data-testid="body-drop-indicator"]'),
    ).toBeNull();
    expect(onChange).toHaveBeenCalled();
  });

  it('gives Move up / Move down full 44px targets (CSS contract)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/svelte/components/ContentBodyEditor.svelte'),
      'utf8',
    );
    const rule =
      /\.editor-popover-button\.editor-popover-button--move\) \{([^}]*)\}/.exec(
        source,
      )?.[1] ?? '';
    expect(rule).toMatch(/width:\s*2\.75rem;/);
    expect(rule).toMatch(/height:\s*2\.75rem;/);
  });
});
