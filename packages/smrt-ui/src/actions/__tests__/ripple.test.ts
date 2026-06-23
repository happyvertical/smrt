/**
 * Unit test for the ripple action (coverage uplift, S6 gate).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ripple } from '../ripple';

afterEach(() => {
  vi.restoreAllMocks();
  // Drop any matchMedia stub a test installed.
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('ripple action', () => {
  it('appends a ripple element on pointer down', () => {
    const node = document.createElement('button');
    document.body.appendChild(node);

    const action = ripple(node);
    const before = node.querySelectorAll('span').length;
    node.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 5, clientY: 5, bubbles: true }),
    );
    expect(node.querySelectorAll('span').length).toBeGreaterThan(before);

    // destroy detaches listeners without throwing
    action?.destroy?.();
    node.remove();
  });

  it('supports touch start', () => {
    const node = document.createElement('button');
    document.body.appendChild(node);
    const action = ripple(node);

    const touch = { clientX: 3, clientY: 3 } as Touch;
    node.dispatchEvent(
      new TouchEvent('touchstart', { touches: [touch], bubbles: true }),
    );
    expect(node.querySelectorAll('span').length).toBeGreaterThan(0);

    action?.destroy?.();
    node.remove();
  });

  it('fills the ripple with the canonical --smrt-color-primary token (#1586)', () => {
    // Regression: the canonical theme system only emits `--smrt-color-*`; the
    // old `--md-sys-color-primary` namespace always fell back to currentColor.
    const node = document.createElement('button');
    document.body.appendChild(node);
    const action = ripple(node);

    node.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 5, clientY: 5, bubbles: true }),
    );
    const span = node.querySelector('span') as HTMLElement;
    expect(span.style.backgroundColor).toContain('--smrt-color-primary');
    expect(span.style.backgroundColor).not.toContain('--md-sys');

    action?.destroy?.();
    node.remove();
  });

  it('destroy() removes pending ripple spans and clears window listeners (#1586)', () => {
    const node = document.createElement('button');
    document.body.appendChild(node);
    const action = ripple(node);

    // Press without releasing: the ripple span stays appended, and a one-shot
    // window mouseup listener is still registered.
    node.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 5, clientY: 5, bubbles: true }),
    );
    expect(node.querySelectorAll('span.smrt-ripple').length).toBe(1);

    const removeSpy = vi.spyOn(window, 'removeEventListener');
    action?.destroy?.();

    // The leaked span is gone immediately (no waiting for a later global mouseup).
    expect(node.querySelectorAll('span.smrt-ripple').length).toBe(0);
    // And the pending window pointer-up listeners were detached.
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('touchend', expect.any(Function));

    node.remove();
  });

  it('skips the ripple when prefers-reduced-motion is set (#1586)', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    const node = document.createElement('button');
    document.body.appendChild(node);
    const action = ripple(node);

    node.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 5, clientY: 5, bubbles: true }),
    );
    expect(node.querySelectorAll('span.smrt-ripple').length).toBe(0);

    action?.destroy?.();
    node.remove();
  });
});
