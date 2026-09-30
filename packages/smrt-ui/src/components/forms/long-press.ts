/**
 * Long-press detection for pointer (mouse, pen) and touch input.
 *
 * A press counts as a long press when the primary pointer stays down, and
 * within `moveTolerance` pixels of where it went down, for `delay`
 * milliseconds (default 500ms, 10px). Moving further first is a drag or a
 * scroll, never a long press, so a host's own drag gestures keep working.
 * A native `dragstart` cancels a pending press for the same reason.
 *
 * - Only the primary button (left mouse, a finger, a pen tip) starts one; a
 *   right click is left alone, and so is the context menu it opens.
 * - The `click` that follows a fired long press is swallowed so the release
 *   does not also "tap" the target.
 * - `preventContextMenu` suppresses the context menu a touch long press
 *   opens (Android, desktop touch screens) — but only during a press this
 *   detector is tracking. Opt in only where the long press replaces that
 *   menu (for example on a picture), never on a text field.
 *
 * Framework-free: `createLongPress` returns handlers a host wires itself, and
 * `longPress` is the Svelte action (`use:longPress={options}`) that wires
 * them to an element.
 */

/** What a long press was made on. */
export interface LongPressDetail {
  /** The element the press is about (from `filter`, else the event target). */
  target: Element;
  /** `mouse`, `pen` or `touch`. */
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface LongPressOptions {
  /** How long the pointer must stay down, in ms. Default 500. */
  delay?: number;
  /** How far (px) the pointer may move before it is a drag instead. Default 10. */
  moveTolerance?: number;
  /**
   * Which presses count. Return the element the press is about, or `null` /
   * `false` to ignore the press (for example: only pictures inside an
   * editor). Default: every press, about its event target.
   */
  filter?: (event: PointerEvent) => Element | null | boolean;
  /** The pointer stayed down long enough. */
  onLongPress: (detail: LongPressDetail) => void;
  /** The pointer came up after a long press fired (a user gesture). */
  onRelease?: (detail: LongPressDetail) => void;
  /** The pointer went down on a counted target (before the delay). */
  onPressStart?: (detail: LongPressDetail) => void;
  /** A pending press ended without firing (a tap, a drag, a scroll). */
  onCancel?: () => void;
  /** Suppress the context menu during a tracked press. Default false. */
  preventContextMenu?: boolean;
  /** Ignore every press. */
  disabled?: boolean;
}

export const LONG_PRESS_DEFAULT_DELAY_MS = 500;
export const LONG_PRESS_DEFAULT_MOVE_TOLERANCE_PX = 10;

export interface LongPressController {
  handlePointerDown(event: PointerEvent): void;
  handlePointerMove(event: PointerEvent): void;
  handlePointerUp(event: PointerEvent): void;
  handlePointerCancel(event: PointerEvent): void;
  handleDragStart(): void;
  handleContextMenu(event: Event): void;
  /** Wire in the capture phase so the swallowed click never reaches the target. */
  handleClick(event: Event): void;
  /** Forget any press in progress (no callbacks). */
  cancel(): void;
  update(options: LongPressOptions): void;
  /** A press is down and waiting for the delay. */
  readonly pending: boolean;
  /** The current press already fired (until the pointer comes up). */
  readonly fired: boolean;
}

/** Long-press state and handlers (see the module comment). */
export function createLongPress(
  initial: LongPressOptions,
): LongPressController {
  let options = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let detail: LongPressDetail | null = null;
  let fired = false;
  let swallowClick = false;
  let swallowTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function reset() {
    clearTimer();
    pointerId = null;
    detail = null;
    fired = false;
  }

  function cancelPending() {
    if (!timer) return;
    reset();
    options.onCancel?.();
  }

  function resolveTarget(event: PointerEvent): Element | null {
    const picked = options.filter ? options.filter(event) : true;
    if (!picked) return null;
    if (picked === true) {
      return event.target instanceof Element ? event.target : null;
    }
    return picked;
  }

  function armClickSwallow() {
    swallowClick = true;
    if (swallowTimer) clearTimeout(swallowTimer);
    // A click that never comes (the pointer moved off) must not eat a later one.
    swallowTimer = setTimeout(() => {
      swallowClick = false;
      swallowTimer = null;
    }, 400);
  }

  return {
    handlePointerDown(event) {
      if (options.disabled) return;
      if (!event.isPrimary) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const target = resolveTarget(event);
      if (!target) return;
      reset();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      detail = {
        target,
        pointerType: event.pointerType || 'mouse',
        clientX: event.clientX,
        clientY: event.clientY,
      };
      options.onPressStart?.(detail);
      const pressed = detail;
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        options.onLongPress(pressed);
      }, options.delay ?? LONG_PRESS_DEFAULT_DELAY_MS);
    },
    handlePointerMove(event) {
      if (!timer || event.pointerId !== pointerId) return;
      const tolerance =
        options.moveTolerance ?? LONG_PRESS_DEFAULT_MOVE_TOLERANCE_PX;
      if (
        Math.hypot(event.clientX - startX, event.clientY - startY) > tolerance
      ) {
        cancelPending();
      }
    },
    handlePointerUp(event) {
      if (event.pointerId !== pointerId) return;
      if (timer) {
        cancelPending();
        return;
      }
      if (fired && detail) {
        const released = detail;
        armClickSwallow();
        reset();
        options.onRelease?.(released);
        return;
      }
      reset();
    },
    handlePointerCancel(event) {
      if (event.pointerId !== pointerId) return;
      if (timer) {
        cancelPending();
        return;
      }
      if (fired && detail) {
        const released = detail;
        reset();
        options.onRelease?.(released);
        return;
      }
      reset();
    },
    handleDragStart() {
      cancelPending();
    },
    handleContextMenu(event) {
      if (!options.preventContextMenu) return;
      if (timer || fired) event.preventDefault();
    },
    handleClick(event) {
      if (!swallowClick) return;
      swallowClick = false;
      if (swallowTimer) clearTimeout(swallowTimer);
      swallowTimer = null;
      event.preventDefault();
      event.stopPropagation();
    },
    cancel() {
      reset();
    },
    update(next) {
      options = next;
      if (next.disabled) reset();
    },
    get pending() {
      return timer !== null;
    },
    get fired() {
      return fired;
    },
  };
}

/**
 * Svelte action: `use:longPress={{ onLongPress: () => … }}`.
 *
 * Listens on the element (presses bubble up from its children, so wrapping a
 * field or an editor works). Pointer moves and releases are also tracked on
 * the window so a release outside the element still ends the press.
 */
export function longPress(node: HTMLElement, options: LongPressOptions) {
  const controller = createLongPress(options);
  const down = (event: PointerEvent) => controller.handlePointerDown(event);
  const move = (event: PointerEvent) => controller.handlePointerMove(event);
  const up = (event: PointerEvent) => controller.handlePointerUp(event);
  const cancel = (event: PointerEvent) => controller.handlePointerCancel(event);
  const drag = () => controller.handleDragStart();
  const menu = (event: Event) => controller.handleContextMenu(event);
  const click = (event: Event) => controller.handleClick(event);

  node.addEventListener('pointerdown', down);
  node.addEventListener('dragstart', drag);
  node.addEventListener('contextmenu', menu);
  node.addEventListener('click', click, true);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);

  return {
    update(next: LongPressOptions) {
      controller.update(next);
    },
    destroy() {
      controller.cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('dragstart', drag);
      node.removeEventListener('contextmenu', menu);
      node.removeEventListener('click', click, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    },
  };
}
