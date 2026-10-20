import { afterEach, expect, it, vi } from 'vitest';
import { highlightControl } from '../control-dom.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('keeps outline compatibility and idempotent cleanup', () => {
  const node = document.createElement('button');
  document.body.append(node);
  vi.useFakeTimers();
  highlightControl(node, 6000);
  expect(node.dataset.smrtHighlighted).toBe('true');
  vi.advanceTimersByTime(6000);
  expect(node.dataset.smrtHighlighted).toBeUndefined();
});
it('paints an actual clipped cutout and tracks layout without intercepting controls', () => {
  vi.useFakeTimers();
  const node = document.createElement('button');
  node.style.setProperty('--smrt-color-scrim', 'rgba(0, 0, 0, 0.4)');
  document.body.append(node);
  let rect = {
    left: -5,
    top: 20,
    right: 40,
    bottom: 60,
    width: 45,
    height: 40,
  };
  vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
    () => rect as DOMRect,
  );
  const dismissed = vi.fn();
  const cleanup = highlightControl(node, 6000, {
    presentation: 'spotlight',
    dismissLabel: 'Dismiss guidance',
    onDismiss: dismissed,
  });
  const root = document.querySelector<HTMLElement>(
    '[data-smrt-component="ControlSpotlight"]',
  );
  const veil = root?.querySelector<HTMLElement>('[data-smrt-spotlight-veil]');
  expect(root).not.toBeNull();
  expect(root?.style.pointerEvents).toBe('none');
  expect(root?.style.zIndex).toBe('1200');
  expect(root?.style.clipPath).toBe('');
  expect(veil?.style.transition).toBe('');
  expect(veil?.style.background).toBe('rgba(3, 5, 9, 0.72)');
  expect(veil?.style.clipPath).toContain('0px 12px');
  expect(document.activeElement).not.toBe(node);
  const activated = vi.fn();
  node.addEventListener('click', activated);
  node.click();
  expect(activated).toHaveBeenCalledTimes(1);
  rect = { left: 80, top: 100, right: 120, bottom: 140, width: 40, height: 40 };
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('resize'));
  vi.advanceTimersByTime(40);
  expect(veil?.style.clipPath).toContain('72px 92px');
  rect = { ...rect, left: 180, right: 220 };
  vi.advanceTimersByTime(40);
  expect(veil?.style.clipPath).toContain('172px 92px');
  const button = root?.querySelector('button');
  expect(button?.getAttribute('aria-label')).toBe('Dismiss guidance');
  expect(button?.style.pointerEvents).toBe('auto');
  button?.click();
  expect(dismissed).toHaveBeenCalledTimes(1);
  cleanup();
  cleanup();
  expect(root?.isConnected).toBe(false);
  vi.advanceTimersByTime(6000);
  expect(dismissed).toHaveBeenCalledTimes(1);
});
it('refuses a detached target and removes a target that disappears or leaves the viewport', () => {
  vi.useFakeTimers();
  const node = document.createElement('button');
  const options = {
    presentation: 'spotlight' as const,
    dismissLabel: 'Dismiss guidance',
  };
  highlightControl(node, 6000, options);
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
  document.body.append(node);
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 10,
    right: 30,
    bottom: 30,
    width: 20,
    height: 20,
  } as DOMRect);
  highlightControl(node, 6000, options);
  node.remove();
  vi.advanceTimersByTime(40);
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
});

it('clips the far viewport edges and dismisses zero/offscreen geometry', () => {
  vi.useFakeTimers();
  const node = document.createElement('button');
  document.body.append(node);
  let rect = {
    left: window.innerWidth - 20,
    top: window.innerHeight - 20,
    right: window.innerWidth + 50,
    bottom: window.innerHeight + 50,
    width: 70,
    height: 70,
  };
  vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
    () => rect as DOMRect,
  );
  const dismiss = vi.fn();
  highlightControl(node, 6000, {
    presentation: 'spotlight',
    dismissLabel: 'Dismiss guidance',
    onDismiss: dismiss,
  });
  const veil = document.querySelector<HTMLElement>(
    '[data-smrt-spotlight-veil]',
  );
  expect(veil?.style.clipPath).toContain(
    `${window.innerWidth}px ${window.innerHeight}px`,
  );
  rect = { ...rect, left: window.innerWidth + 1 };
  vi.advanceTimersByTime(40);
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
  expect(dismiss).toHaveBeenCalledTimes(1);
  rect = { ...rect, left: 10, top: 10, width: 0, height: 0 };
  highlightControl(node, 6000, {
    presentation: 'spotlight',
    dismissLabel: 'Dismiss guidance',
  });
  expect(
    document.querySelector('[data-smrt-component="ControlSpotlight"]'),
  ).toBeNull();
});

it('keeps Dismiss above the live shell phone footer track across resize', () => {
  vi.useFakeTimers();
  const node = document.createElement('button');
  node.style.setProperty('--smrt-admin-shell-phone-bar-track', '4rem');
  document.body.append(node);
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 10,
    right: 30,
    bottom: 30,
    width: 20,
    height: 20,
  } as DOMRect);
  const cleanup = highlightControl(node, 6000, {
    presentation: 'spotlight',
    dismissLabel: 'Dismiss guidance',
  });
  const dismiss = document.querySelector<HTMLElement>(
    '[data-smrt-component="ControlSpotlight"] button',
  );
  expect(dismiss?.style.insetBlockEnd).toBe('calc(5rem)');
  node.style.setProperty('--smrt-admin-shell-phone-bar-track', '0rem');
  window.dispatchEvent(new Event('resize'));
  vi.advanceTimersByTime(40);
  expect(dismiss?.style.insetBlockEnd).toBe('calc(1rem)');
  node.style.removeProperty('--smrt-admin-shell-phone-bar-track');
  vi.advanceTimersByTime(40);
  expect(dismiss?.style.insetBlockEnd).toContain('safe-area-inset-bottom');
  cleanup();
});
