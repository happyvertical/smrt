import { describe, expect, it, vi } from 'vitest';
import { swipeDismiss, swipeDismisses } from '../swipe-dismiss.js';

describe('swipeDismisses', () => {
  it('dismisses a drawer on a clear swipe left only', () => {
    expect(swipeDismisses(-80, 10, 'left')).toBe(true);
    expect(swipeDismisses(-40, 0, 'left')).toBe(false);
    expect(swipeDismisses(-80, 70, 'left')).toBe(false);
    expect(swipeDismisses(80, 0, 'left')).toBe(false);
  });

  it('dismisses a right-hand drawer on a clear swipe right only', () => {
    expect(swipeDismisses(80, 5, 'right')).toBe(true);
    expect(swipeDismisses(-80, 5, 'right')).toBe(false);
  });

  it('dismisses a sheet on a clear swipe down only', () => {
    expect(swipeDismisses(5, 90, 'down')).toBe(true);
    expect(swipeDismisses(0, -90, 'down')).toBe(false);
    expect(swipeDismisses(80, 90, 'down')).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(swipeDismisses(0, 40, 'down', 32)).toBe(true);
    expect(swipeDismisses(0, 40, 'down')).toBe(false);
  });
});

function touch(type: string, x: number, y: number): TouchEvent {
  const point = { clientX: x, clientY: y } as Touch;
  const event = new Event(type) as TouchEvent;
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [point],
  });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  return event;
}

describe('swipeDismiss action', () => {
  it('calls onDismiss after a swipe in its direction', () => {
    const node = document.createElement('div');
    const onDismiss = vi.fn();
    const action = swipeDismiss(node, { direction: 'down', onDismiss });
    node.dispatchEvent(touch('touchstart', 10, 10));
    node.dispatchEvent(touch('touchend', 12, 100));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    action.destroy();
  });

  it('ignores swipes while disabled and after update re-enables them', () => {
    const node = document.createElement('div');
    const onDismiss = vi.fn();
    const action = swipeDismiss(node, {
      direction: 'left',
      onDismiss,
      enabled: false,
    });
    node.dispatchEvent(touch('touchstart', 100, 10));
    node.dispatchEvent(touch('touchend', 10, 10));
    expect(onDismiss).not.toHaveBeenCalled();
    action.update({ direction: 'left', onDismiss, enabled: true });
    node.dispatchEvent(touch('touchstart', 100, 10));
    node.dispatchEvent(touch('touchend', 10, 10));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    action.destroy();
  });

  it('forgets a cancelled touch', () => {
    const node = document.createElement('div');
    const onDismiss = vi.fn();
    swipeDismiss(node, { direction: 'down', onDismiss });
    node.dispatchEvent(touch('touchstart', 10, 10));
    node.dispatchEvent(new Event('touchcancel'));
    node.dispatchEvent(touch('touchend', 10, 200));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
