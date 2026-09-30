/**
 * Long press vs tap vs drag: only a still, primary press held for the delay
 * fires; moving past the tolerance (a drag or scroll) or a native dragstart
 * cancels it; the click after a fired press is swallowed; the context menu is
 * suppressed only when opted in and only during a tracked press.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLongPress, longPress } from '../long-press.js';

function pointer(
  type: string,
  init: Partial<PointerEvent> & { target?: EventTarget | null } = {},
): PointerEvent {
  return {
    type,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    clientX: 100,
    clientY: 100,
    target: document.body,
    ...init,
  } as unknown as PointerEvent;
}

describe('createLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires after the delay when the pointer stays still', () => {
    const onLongPress = vi.fn();
    const press = createLongPress({ onLongPress });
    press.handlePointerDown(pointer('pointerdown'));
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();
    // Small wobble inside the tolerance still counts as still.
    press.handlePointerMove(
      pointer('pointermove', { clientX: 106, clientY: 104 }),
    );
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0][0]).toMatchObject({
      pointerType: 'touch',
    });
    expect(press.fired).toBe(true);
  });

  it('a quick tap never fires and reports a cancel', () => {
    const onLongPress = vi.fn();
    const onCancel = vi.fn();
    const press = createLongPress({ onLongPress, onCancel });
    press.handlePointerDown(pointer('pointerdown'));
    vi.advanceTimersByTime(200);
    press.handlePointerUp(pointer('pointerup'));
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('moving past the tolerance is a drag, not a long press', () => {
    const onLongPress = vi.fn();
    const press = createLongPress({ onLongPress, moveTolerance: 10 });
    press.handlePointerDown(pointer('pointerdown'));
    vi.advanceTimersByTime(300);
    press.handlePointerMove(pointer('pointermove', { clientX: 115 }));
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('a native dragstart cancels a pending press', () => {
    const onLongPress = vi.fn();
    const press = createLongPress({ onLongPress });
    press.handlePointerDown(pointer('pointerdown', { pointerType: 'mouse' }));
    press.handleDragStart();
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('ignores right clicks and secondary pointers', () => {
    const onLongPress = vi.fn();
    const press = createLongPress({ onLongPress });
    press.handlePointerDown(
      pointer('pointerdown', { pointerType: 'mouse', button: 2 }),
    );
    press.handlePointerDown(pointer('pointerdown', { isPrimary: false }));
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('only counts presses the filter accepts, about the element it returns', () => {
    const picture = document.createElement('img');
    const onLongPress = vi.fn();
    const press = createLongPress({
      onLongPress,
      filter: (event) => (event.target === picture ? picture : null),
    });
    press.handlePointerDown(pointer('pointerdown', { target: document.body }));
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
    press.handlePointerDown(pointer('pointerdown', { target: picture }));
    vi.advanceTimersByTime(600);
    expect(onLongPress.mock.calls[0][0].target).toBe(picture);
  });

  it('reports the release after a fired press and swallows the next click', () => {
    const onRelease = vi.fn();
    const press = createLongPress({ onLongPress: () => {}, onRelease });
    press.handlePointerDown(pointer('pointerdown'));
    vi.advanceTimersByTime(500);
    press.handlePointerUp(pointer('pointerup'));
    expect(onRelease).toHaveBeenCalledTimes(1);
    const click = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event;
    press.handleClick(click);
    expect(click.preventDefault).toHaveBeenCalled();
    // Only the one click right after the release.
    const later = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event;
    press.handleClick(later);
    expect(later.preventDefault).not.toHaveBeenCalled();
  });

  it('suppresses the context menu only when opted in and during a press', () => {
    const plain = createLongPress({ onLongPress: () => {} });
    const guarded = createLongPress({
      onLongPress: () => {},
      preventContextMenu: true,
    });
    const idleMenu = { preventDefault: vi.fn() } as unknown as Event;
    guarded.handleContextMenu(idleMenu);
    expect(idleMenu.preventDefault).not.toHaveBeenCalled();

    plain.handlePointerDown(pointer('pointerdown'));
    guarded.handlePointerDown(pointer('pointerdown'));
    vi.advanceTimersByTime(500);
    const plainMenu = { preventDefault: vi.fn() } as unknown as Event;
    const guardedMenu = { preventDefault: vi.fn() } as unknown as Event;
    plain.handleContextMenu(plainMenu);
    guarded.handleContextMenu(guardedMenu);
    expect(plainMenu.preventDefault).not.toHaveBeenCalled();
    expect(guardedMenu.preventDefault).toHaveBeenCalled();
  });
});

describe('longPress action', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function dispatch(
    target: EventTarget,
    type: string,
    init: Record<string, unknown> = {},
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      isPrimary: true,
      pointerId: 7,
      pointerType: 'mouse',
      button: 0,
      clientX: 10,
      clientY: 10,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  }

  it('wires pointer events on the node and the window, and cleans up', () => {
    const node = document.createElement('div');
    document.body.append(node);
    const onLongPress = vi.fn();
    const action = longPress(node, { onLongPress });
    dispatch(node, 'pointerdown');
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    dispatch(window, 'pointerup');

    action.destroy();
    dispatch(node, 'pointerdown');
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    node.remove();
  });

  it('a drag on the node (move past tolerance) never fires', () => {
    const node = document.createElement('div');
    document.body.append(node);
    const onLongPress = vi.fn();
    const action = longPress(node, { onLongPress });
    dispatch(node, 'pointerdown');
    dispatch(window, 'pointermove', { clientX: 40 });
    vi.advanceTimersByTime(800);
    expect(onLongPress).not.toHaveBeenCalled();
    action.destroy();
    node.remove();
  });
});
