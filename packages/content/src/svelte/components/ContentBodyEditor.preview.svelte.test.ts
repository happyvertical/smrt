// @vitest-environment jsdom
/**
 * previewImage: a picture shown in place without changing the story. The
 * preview never reaches the body or `onChange`, and replaceImage (accepting a
 * picture) takes its place.
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentBodyEditor from './ContentBodyEditor.svelte';

const STORY =
  '<p>one words</p><img src="/a/1.jpg" alt="Town hall" data-smrt-asset-id="a-1" data-smrt-inline-image="true" data-smrt-placement="block"><p>two</p>';

const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  while (mounted.length) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
});

function renderStory() {
  const bodies: string[] = [];
  const onChange = vi.fn((change: { body: string }) => {
    bodies.push(change.body);
    props.value = change.body;
  });
  const props = $state({ value: STORY, format: 'html', onChange });
  const target = document.createElement('div');
  document.body.appendChild(target);
  let editor: {
    previewImage(index: number, src: string | null): boolean;
    clearImagePreviews(): void;
    replaceImage(index: number, asset: unknown): boolean;
    insertImageAsset(asset: unknown): void;
  } | null = null;
  mounted.push(
    mount(ContentBodyEditor, {
      target,
      props: {
        get value() {
          return props.value;
        },
        format: 'html',
        onChange,
      },
    }),
  );
  flushSync();
  const surface = target.querySelector('[contenteditable]') as HTMLElement;
  // The component instance exposes the exported functions.
  editor = mounted[mounted.length - 1] as unknown as typeof editor;
  return {
    surface,
    editor: editor as NonNullable<typeof editor>,
    bodies,
    onChange,
  };
}

describe('ContentBodyEditor previewImage', () => {
  it('shows the preview in place, swaps it, and restores the original', () => {
    const { surface, editor, onChange } = renderStory();
    const image = surface.querySelector('img') as HTMLImageElement;
    expect(editor.previewImage(0, '/a/2.jpg?preview=1')).toBe(true);
    expect(image.getAttribute('src')).toBe('/a/2.jpg?preview=1');
    expect(editor.previewImage(0, '/a/3.jpg')).toBe(true);
    expect(image.getAttribute('src')).toBe('/a/3.jpg');
    expect(editor.previewImage(0, null)).toBe(true);
    expect(image.getAttribute('src')).toBe('/a/1.jpg');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never lets a preview into the body, even when another edit happens', async () => {
    const { surface, editor, bodies } = renderStory();
    expect(editor.previewImage(0, '/a/2.jpg?preview=1')).toBe(true);
    // An unrelated edit (typing) reports the body.
    const paragraph = surface.querySelector('p') as HTMLElement;
    paragraph.textContent = 'one words changed';
    surface.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    flushSync();
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toContain('/a/1.jpg');
      expect(body).not.toContain('preview=1');
    }
    // The picture is still shown as a preview on screen.
    expect(
      (surface.querySelector('img') as HTMLImageElement).getAttribute('src'),
    ).toBe('/a/2.jpg?preview=1');
  });

  it('refuses other origins and missing pictures', () => {
    const { surface, editor } = renderStory();
    expect(editor.previewImage(0, 'https://evil.test/x.jpg')).toBe(false);
    expect(editor.previewImage(0, '//evil.test/x.jpg')).toBe(false);
    expect(editor.previewImage(5, '/a/2.jpg')).toBe(false);
    expect(
      (surface.querySelector('img') as HTMLImageElement).getAttribute('src'),
    ).toBe('/a/1.jpg');
  });

  it('accepting a picture replaces the preview and clearImagePreviews puts the rest back', () => {
    const { surface, editor, bodies } = renderStory();
    editor.previewImage(0, '/a/2.jpg');
    expect(
      editor.replaceImage(0, { id: 'a-2', name: 'Two', src: '/a/2.jpg' }),
    ).toBe(true);
    flushSync();
    expect(bodies.at(-1)).toContain('/a/2.jpg');
    editor.previewImage(0, '/a/9.jpg');
    editor.clearImagePreviews();
    expect(
      (surface.querySelector('img') as HTMLImageElement).getAttribute('src'),
    ).toBe('/a/2.jpg');
  });
});
