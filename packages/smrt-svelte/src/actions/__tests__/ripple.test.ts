/**
 * Unit test for the ripple action (coverage uplift, S6 gate).
 */
import { describe, expect, it } from 'vitest';
import { ripple } from '../ripple';

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
});
