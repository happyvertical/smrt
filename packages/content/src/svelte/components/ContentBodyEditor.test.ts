// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentBodyEditor from './ContentBodyEditor.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];

function renderEditor(props: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ContentBodyEditor, {
    target,
    props: { value: '<p>Hello</p>', format: 'html', ...props },
  });
  mounted.push(component);
  flushSync();
  return target;
}

const panel = createRawSnippet(() => ({
  render: () =>
    '<div class="test-panel"><button type="button">Upload</button></div>',
}));

afterEach(() => {
  while (mounted.length) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
});

describe('ContentBodyEditor toolbar icons', () => {
  it('draws every toolbar icon at one size', () => {
    const target = renderEditor();
    const icons = Array.from(
      target.querySelectorAll('.body-editor-toolbar svg'),
    );
    expect(icons.length).toBeGreaterThanOrEqual(2);
    const sizes = new Set(
      icons.map(
        (icon) =>
          `${icon.getAttribute('width')}x${icon.getAttribute('height')}`,
      ),
    );
    expect(sizes).toEqual(new Set(['18x18']));
    for (const icon of icons) {
      expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
    }
  });

  it('keeps icon buttons from squeezing their icons (CSS contract)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/svelte/components/ContentBodyEditor.svelte'),
      'utf8',
    );
    const buttonRule =
      /\.body-editor-toolbar :global\(\.editor-toolbar-button\) \{([^}]*)\}/.exec(
        source,
      )?.[1] ?? '';
    // smrt-ui's size="sm" padding would leave ~6px for the icon in a 2rem box.
    expect(buttonRule).toMatch(/padding:\s*0;/);
    const popoverRule =
      /\.image-control-popover :global\(\.editor-popover-button\) \{([^}]*)\}/.exec(
        source,
      )?.[1] ?? '';
    expect(popoverRule).toMatch(/padding:\s*0;/);
    const iconRule =
      /:global\(\.editor-toolbar-button svg\),\s*\.image-control-popover :global\(\.editor-popover-button svg\) \{([^}]*)\}/.exec(
        source,
      )?.[1] ?? '';
    expect(iconRule).toMatch(/flex-shrink:\s*0;/);
    expect(source).toMatch(
      /@media \(pointer: coarse\) \{[\s\S]*?\.editor-toolbar-button\) \{[^}]*width: 2\.75rem;[^}]*height: 2\.75rem;/,
    );
    expect(iconRule).toMatch(
      /width:\s*var\(--smrt-content-editor-icon-size, 1\.125rem\);/,
    );
    expect(iconRule).toMatch(
      /height:\s*var\(--smrt-content-editor-icon-size, 1\.125rem\);/,
    );
  });
});

describe('ContentBodyEditor format picker', () => {
  it('is hidden by default', () => {
    const target = renderEditor();
    expect(target.querySelector('.format-select')).toBeNull();
  });

  it('shows the HTML/Markdown picker when the host opts in', () => {
    const target = renderEditor({ showFormatPicker: true });
    const options = Array.from(
      target.querySelectorAll('.format-select option'),
    ).map((option) => option.getAttribute('value'));
    expect(options).toEqual(['html', 'markdown']);
  });
});

describe('ContentBodyEditor image panel', () => {
  it('opens between the toolbar and the text, labelled and linked to its button', async () => {
    const target = renderEditor({ imagePanel: panel, imagePanelOpen: true });
    const root = target.querySelector('.content-body-editor');
    const children = Array.from(root?.children ?? []);
    const toolbarIndex = children.findIndex((el) =>
      el.classList.contains('body-editor-toolbar'),
    );
    const panelIndex = children.findIndex((el) =>
      el.classList.contains('body-editor-image-panel'),
    );
    const surfaceIndex = children.findIndex((el) =>
      el.classList.contains('body-editor-surface'),
    );
    expect(toolbarIndex).toBe(0);
    expect(panelIndex).toBeGreaterThan(toolbarIndex);
    expect(panelIndex).toBeLessThan(surfaceIndex);

    const region = children[panelIndex] as HTMLElement;
    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('aria-label')).toBe('Pictures');
    expect(region.querySelector('.test-panel')).not.toBeNull();

    const button = target.querySelector('button[aria-label="Insert image"]');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(button?.getAttribute('aria-controls')).toBe(region.id);

    await Promise.resolve();
    expect(document.activeElement).toBe(region);
  });

  it('stays closed until asked and reports aria-expanded=false', () => {
    const target = renderEditor({ imagePanel: panel, imagePanelOpen: false });
    expect(target.querySelector('.body-editor-image-panel')).toBeNull();
    const button = target.querySelector('button[aria-label="Insert image"]');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  it('asks to close on Escape and toggles from the toolbar button', () => {
    const onCloseImagePanel = vi.fn();
    const onOpenImageChooser = vi.fn();
    const target = renderEditor({
      imagePanel: panel,
      imagePanelOpen: true,
      onCloseImagePanel,
      onOpenImageChooser,
    });
    const region = target.querySelector(
      '.body-editor-image-panel',
    ) as HTMLElement;
    region
      .querySelector('button')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    expect(onCloseImagePanel).toHaveBeenCalledTimes(1);

    (
      target.querySelector(
        'button[aria-label="Insert image"]',
      ) as HTMLButtonElement
    ).click();
    expect(onOpenImageChooser).toHaveBeenCalledTimes(1);
  });

  it('has no aria-expanded when no panel is supplied', () => {
    const target = renderEditor();
    const button = target.querySelector('button[aria-label="Insert image"]');
    expect(button?.hasAttribute('aria-expanded')).toBe(false);
    expect(button?.hasAttribute('aria-controls')).toBe(false);
  });
});
