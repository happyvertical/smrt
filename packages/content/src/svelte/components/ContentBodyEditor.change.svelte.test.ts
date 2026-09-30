// @vitest-environment jsdom
/**
 * "Change this picture": the toolbar button and the badge on a selected
 * picture ask the host (listen: false); pressing and holding a picture asks
 * with listen: true; moving first is a drag and asks nothing; the context
 * menu is held back only during a press on a picture. Without a host
 * callback none of it shows.
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentBodyEditor from './ContentBodyEditor.svelte';

const STORY =
  '<p>one words</p><img src="/a/1.jpg" alt="Town hall" data-smrt-asset-id="a-1" data-smrt-inline-image="true" data-smrt-placement="block"><p>two</p>';

const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  vi.useRealTimers();
  while (mounted.length) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
});

function renderStory(onRequestImageChange?: (request: unknown) => void) {
  const props = $state({
    value: STORY,
    format: 'html',
    onChange: () => {},
    onRequestImageChange,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(ContentBodyEditor, { target, props }));
  flushSync();
  const surface = target.querySelector('[contenteditable]') as HTMLElement;
  const image = surface.querySelector('img') as HTMLImageElement;
  return { target, surface, image };
}

function pointer(
  target: EventTarget,
  type: string,
  init: Record<string, unknown> = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    isPrimary: true,
    pointerId: 5,
    pointerType: 'touch',
    button: 0,
    clientX: 50,
    clientY: 50,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('ContentBodyEditor change this picture', () => {
  it('shows nothing without a host callback', () => {
    const { target, image } = renderStory();
    image.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(
      target.querySelector('[aria-label="Change this picture"]'),
    ).toBeNull();
  });

  it('the toolbar button and the badge ask for a change of the selected picture', () => {
    const onRequest = vi.fn();
    const { target, image } = renderStory(onRequest);
    image.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    const toolbarButton = target.querySelector(
      '.image-control-popover button[aria-label="Change this picture"]',
    ) as HTMLButtonElement;
    expect(toolbarButton.textContent).toContain('Change');
    toolbarButton.click();
    expect(onRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        index: 0,
        assetId: 'a-1',
        alt: 'Town hall',
        listen: false,
      }),
    );

    const badge = target.querySelector(
      'button.image-change-badge',
    ) as HTMLButtonElement;
    expect(badge.getAttribute('aria-label')).toBe('Change this picture');
    badge.click();
    expect(onRequest).toHaveBeenCalledTimes(2);
  });

  it('pressing and holding a picture asks with listen: true and selects it', () => {
    vi.useFakeTimers();
    const onRequest = vi.fn();
    const { image } = renderStory(onRequest);
    pointer(image, 'pointerdown');
    vi.advanceTimersByTime(499);
    expect(onRequest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    flushSync();
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'a-1', listen: true }),
    );
    expect(image.getAttribute('data-smrt-selected')).toBe('true');
    pointer(window, 'pointerup');
  });

  it('moving before the delay is a drag and asks nothing', () => {
    vi.useFakeTimers();
    const onRequest = vi.fn();
    const { image } = renderStory(onRequest);
    pointer(image, 'pointerdown', { pointerType: 'mouse' });
    pointer(window, 'pointermove', { pointerType: 'mouse', clientX: 80 });
    vi.advanceTimersByTime(800);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('holds the context menu back only during a press on a picture', () => {
    vi.useFakeTimers();
    const { surface, image } = renderStory(vi.fn());
    const text = surface.querySelector('p') as HTMLElement;
    const onText = new Event('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    text.dispatchEvent(onText);
    expect(onText.defaultPrevented).toBe(false);

    pointer(image, 'pointerdown');
    vi.advanceTimersByTime(500);
    const onPicture = new Event('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    image.dispatchEvent(onPicture);
    expect(onPicture.defaultPrevented).toBe(true);
    pointer(window, 'pointerup');
  });
});
