/**
 * Headless drag-and-drop engine shared by `Board` and `Sortable`: keyboard
 * pick-up and move, pointer (mouse, touch, pen) and native HTML drag, a
 * single in-flight move at a time, focus return, and screen-reader
 * announcements. It knows nothing about cards, columns, or navigation: a host
 * describes ordered containers of item ids and receives one typed move.
 *
 * Create it during component initialization (it registers an effect that
 * returns focus to the moved item).
 */
import { BROWSER } from 'esm-env';
import { tick } from 'svelte';

/** Where an item sits: a container and a zero-based index within it. */
export interface SortablePosition {
  containerId: string;
  index: number;
}

/**
 * A drop, as ids. `target.index` is counted after removing the item from
 * `source`, so it is directly usable with an immutable list update.
 */
export interface SortableMove {
  itemId: string;
  source: SortablePosition;
  target: SortablePosition;
}

/** The minimum a container exposes to the engine. */
export interface SortableContainerInfo {
  id: string;
  label: string;
  /** Items cannot be dropped into a disabled container. */
  disabled?: boolean;
}

/** What the engine wants announced; the host turns it into localized text. */
export type SortableAnnouncement =
  | { type: 'pickup'; item: string; destinations: string[] }
  | {
      type: 'position';
      item: string;
      container: string;
      position: number;
      count: number;
    }
  | { type: 'unavailable'; container: string }
  | { type: 'failed'; item: string }
  | {
      type: 'drop';
      item: string;
      container: string;
      position: number;
      count: number;
    }
  | { type: 'cancel'; item: string };

/** How the host marks its DOM so pointer hit-testing can find ids. */
export interface SortableSelectors {
  /** CSS selector of a container's list element. */
  container: string;
  /** `dataset` key holding the container id. */
  containerKey: string;
  /** CSS selector of an item element. */
  item: string;
  /** `dataset` key holding the item id. */
  itemKey: string;
}

export interface SortableControllerOptions {
  /** The element hit-testing is confined to (never escapes it). */
  root: () => HTMLElement | undefined;
  selectors: SortableSelectors;
  containers: () => readonly SortableContainerInfo[];
  /** Ids in a container, in display order. */
  itemIds: (containerId: string) => readonly string[];
  /** Accessible label of an item, or `undefined` when it no longer exists. */
  itemLabel: (itemId: string) => string | undefined;
  /** Whether items may be reordered within their current container. */
  allowSameContainerReorder: () => boolean;
  /** Whether moving is allowed at all (e.g. a read-only list is not). */
  enabled: () => boolean;
  /**
   * `horizontal` (default): Left/Right choose the container, Up/Down the
   * position. `vertical`: Up/Down walk the whole list, crossing into the
   * adjacent container at either end.
   */
  orientation?: () => 'horizontal' | 'vertical';
  /**
   * `true` for a single list laid out as a wrapping flow (a CSS grid of
   * tiles): every arrow key steps one position along the reading order
   * (Left/Right mirrored in right-to-left), and a pointer drop over an item
   * that shares its row with others decides before/after by the horizontal
   * midpoint; an item that fills the row (stacked layouts) still uses the
   * vertical midpoint.
   */
  flow?: () => boolean;
  /**
   * Persist a move. May be async; a rejection restores the presentation and
   * is announced. The engine allows the next move only after it settles.
   */
  commit: (move: SortableMove) => void | Promise<void>;
  announce: (announcement: SortableAnnouncement) => string;
  /** Element to focus for an item (default: the item element itself). */
  focusTarget?: (itemElement: HTMLElement) => HTMLElement | null;
}

interface DragState {
  itemId: string;
  source: SortablePosition;
  target: SortablePosition;
  mode: 'keyboard' | 'pointer';
}

interface PointerSession {
  itemId: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
}

function clamp(index: number, max: number): number {
  return Math.max(0, Math.min(index, max));
}

export class SortableController {
  drag = $state<DragState | undefined>();
  announcement = $state('');
  private focusItemId = $state<string | undefined>();
  private suppressedSelectionId = $state<string | undefined>();
  private pending = $state(false);
  private pointerSession = $state<PointerSession | undefined>();

  constructor(private readonly options: SortableControllerOptions) {
    $effect(() => {
      if (!BROWSER) return;
      if (!this.focusItemId) return;
      const itemId = this.focusItemId;
      this.focusItemId = undefined;
      tick().then(() => {
        const root = this.options.root();
        const element = root
          ? Array.from(
              root.querySelectorAll<HTMLElement>(this.options.selectors.item),
            ).find(
              (candidate) =>
                candidate.dataset[this.options.selectors.itemKey] === itemId,
            )
          : undefined;
        const target = element
          ? this.options.focusTarget
            ? this.options.focusTarget(element)
            : element
          : undefined;
        target?.focus();
      });
    });
  }

  /** Whether a new move may start now. */
  get movable(): boolean {
    return this.options.enabled() && !this.pending;
  }

  /** Whether native HTML drag should be offered (not while a pointer session runs). */
  get nativeDraggable(): boolean {
    return this.movable && this.pointerSession === undefined;
  }

  private get containers(): readonly SortableContainerInfo[] {
    return this.options.containers();
  }

  private itemsIn(containerId: string, withoutId?: string): readonly string[] {
    const ids = this.options.itemIds(containerId);
    return withoutId ? ids.filter((id) => id !== withoutId) : ids;
  }

  private findContainer(id: string): SortableContainerInfo | undefined {
    return this.containers.find((container) => container.id === id);
  }

  private positionFor(itemId: string): SortablePosition | undefined {
    if (this.options.itemLabel(itemId) === undefined) return undefined;
    for (const container of this.containers) {
      const index = this.itemsIn(container.id).indexOf(itemId);
      if (index >= 0) return { containerId: container.id, index };
    }
    return undefined;
  }

  private label(itemId: string): string {
    return this.options.itemLabel(itemId) ?? '';
  }

  private say(announcement: SortableAnnouncement): void {
    this.announcement = this.options.announce(announcement);
  }

  pickup(itemId: string, mode: DragState['mode']): void {
    if (!this.movable) return;
    const source = this.positionFor(itemId);
    if (!source) return;
    this.drag = { itemId, source, target: { ...source }, mode };
    this.say({
      type: 'pickup',
      item: this.label(itemId),
      destinations: this.containers
        .filter((container) => !container.disabled)
        .map((container) => container.label),
    });
  }

  private announcePosition(state: DragState): void {
    const container = this.findContainer(state.target.containerId);
    if (!container || this.options.itemLabel(state.itemId) === undefined) {
      return;
    }
    this.say({
      type: 'position',
      item: this.label(state.itemId),
      container: container.label,
      position: state.target.index + 1,
      count: this.itemsIn(container.id, state.itemId).length + 1,
    });
  }

  private moveKeyboardTarget(
    direction: 'horizontal' | 'vertical',
    delta: number,
  ): void {
    const drag = this.drag;
    if (drag?.mode !== 'keyboard') return;
    const vertical = this.options.orientation?.() === 'vertical';
    const target = { ...drag.target };
    if (this.options.flow?.()) {
      const mirrored = direction === 'horizontal' && this.isRtl();
      const max = this.itemsIn(target.containerId, drag.itemId).length;
      target.index = clamp(target.index + (mirrored ? -delta : delta), max);
      this.drag = { ...drag, target };
      this.announcePosition(this.drag);
      return;
    }
    // With same-container reordering off, the source container pins the
    // position (as it does for pointer moves): a vertical step leaves it.
    const pinned =
      !this.options.allowSameContainerReorder() &&
      target.containerId === drag.source.containerId;
    if (direction === 'vertical') {
      if (pinned && !vertical) return;
      const max = this.itemsIn(target.containerId, drag.itemId).length;
      const next = pinned ? (delta < 0 ? -1 : max + 1) : target.index + delta;
      if (vertical && (next < 0 || next > max)) {
        const currentIndex = this.containers.findIndex(
          (container) => container.id === target.containerId,
        );
        const candidate = this.containers[currentIndex + delta];
        if (!candidate) return;
        if (candidate.disabled) {
          this.say({ type: 'unavailable', container: candidate.label });
          return;
        }
        target.containerId = candidate.id;
        target.index =
          delta < 0 ? this.itemsIn(candidate.id, drag.itemId).length : 0;
      } else {
        target.index = clamp(next, max);
      }
    } else {
      if (vertical) return;
      const currentIndex = this.containers.findIndex(
        (container) => container.id === target.containerId,
      );
      const candidate = this.containers[currentIndex + delta];
      if (!candidate) return;
      if (candidate.disabled) {
        this.say({ type: 'unavailable', container: candidate.label });
        return;
      }
      target.containerId = candidate.id;
      target.index = clamp(
        target.index,
        this.itemsIn(candidate.id, drag.itemId).length,
      );
    }
    // Coming back into a pinned source container lands on its own slot.
    if (
      !this.options.allowSameContainerReorder() &&
      target.containerId === drag.source.containerId
    ) {
      target.index = drag.source.index;
    }
    this.drag = { ...drag, target };
    this.announcePosition(this.drag);
  }

  private isRtl(): boolean {
    const root = this.options.root();
    return (
      root !== undefined &&
      typeof getComputedStyle === 'function' &&
      getComputedStyle(root).direction === 'rtl'
    );
  }

  async drop(): Promise<void> {
    const state = this.drag;
    if (!state) return;
    const itemLabel = this.options.itemLabel(state.itemId);
    const target = this.findContainer(state.target.containerId);
    const valid =
      itemLabel !== undefined &&
      this.findContainer(state.source.containerId) !== undefined &&
      target !== undefined &&
      !target.disabled;
    this.drag = undefined;
    this.suppressSelection(state.itemId);
    if (!valid || itemLabel === undefined || !target) return;
    const changed =
      state.source.containerId !== state.target.containerId ||
      state.source.index !== state.target.index;
    if (!changed) {
      this.focusItemId = state.itemId;
      return;
    }
    this.pending = true;
    try {
      await this.options.commit({
        itemId: state.itemId,
        source: state.source,
        target: state.target,
      });
    } catch {
      this.say({ type: 'failed', item: itemLabel });
      this.focusItemId = state.itemId;
      return;
    } finally {
      this.pending = false;
    }
    this.say({
      type: 'drop',
      item: itemLabel,
      container: target.label,
      position: state.target.index + 1,
      count: this.itemsIn(target.id, state.itemId).length + 1,
    });
    this.focusItemId = state.itemId;
  }

  /** Cancel the move in flight. Focus returns to the item when `restoreFocus`. */
  cancel(announce = true, restoreFocus = true): void {
    const drag = this.drag;
    if (!drag) return;
    const label = this.options.itemLabel(drag.itemId);
    if (label !== undefined && announce) {
      this.say({ type: 'cancel', item: label });
    }
    if (label !== undefined && restoreFocus) this.focusItemId = drag.itemId;
    this.suppressSelection(drag.itemId);
    this.drag = undefined;
  }

  private suppressSelection(itemId: string): void {
    this.suppressedSelectionId = itemId;
    window.setTimeout(() => {
      if (this.suppressedSelectionId === itemId) {
        this.suppressedSelectionId = undefined;
      }
    }, 0);
  }

  /**
   * Keyboard pick-up and native drag gestures can both dispatch a click after
   * their key/pointer sequence. Returns `true` when this click must be
   * consumed so a move never doubles as an application-level activation.
   */
  consumeClick(itemId: string): boolean {
    if (this.suppressedSelectionId === itemId) {
      this.suppressedSelectionId = undefined;
      return true;
    }
    return false;
  }

  keydown(event: KeyboardEvent, itemId: string): void {
    const drag = this.drag;
    if (!drag) {
      if (event.key === ' ' || event.key === 'Enter') {
        if (!this.movable) return;
        event.preventDefault();
        this.pickup(itemId, 'keyboard');
      }
      return;
    }
    if (drag.itemId !== itemId || drag.mode !== 'keyboard') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      void this.drop();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.moveKeyboardTarget('horizontal', -1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.moveKeyboardTarget('horizontal', 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveKeyboardTarget('vertical', -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveKeyboardTarget('vertical', 1);
    }
  }

  /**
   * Focus left the item while a keyboard move was in flight: abandon it so
   * the item is not left "picked up" with no way to steer it.
   */
  blur(event: FocusEvent, itemId: string): void {
    const drag = this.drag;
    if (drag?.mode !== 'keyboard' || drag.itemId !== itemId) return;
    const next = event.relatedTarget;
    const current = event.currentTarget;
    if (
      next instanceof Node &&
      current instanceof Node &&
      current.contains(next)
    ) {
      return;
    }
    this.cancel(true, false);
  }

  dragStart(event: DragEvent, itemId: string): void {
    if (!this.movable) {
      event.preventDefault();
      return;
    }
    this.pickup(itemId, 'pointer');
    event.dataTransfer?.setData('text/plain', itemId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  dragEnd(): void {
    if (this.drag?.mode === 'pointer') this.cancel();
  }

  pointerDown(event: PointerEvent, itemId: string): void {
    if (!this.movable || event.button !== 0) return;
    this.pointerSession = {
      itemId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
  }

  private elementAtPointer(event: PointerEvent): Element | null {
    return (
      document.elementFromPoint?.(event.clientX, event.clientY) ??
      (event.target as Element | null)
    );
  }

  private setPointerTargetFromElement(
    element: Element | null,
    clientY: number,
    clientX?: number,
  ): SortableContainerInfo | undefined {
    // Container ids belong to the host's domain and may repeat in another
    // instance. Pointer hit-testing must never escape this one's root.
    const root = this.options.root();
    if (!element || !root?.contains(element)) return undefined;
    const { selectors } = this.options;
    const lane = element.closest<HTMLElement>(selectors.container);
    const containerId = lane?.dataset[selectors.containerKey];
    if (!containerId) return undefined;
    const container = this.findContainer(containerId);
    if (!container || container.disabled) return container;
    const itemElement = element.closest<HTMLElement>(selectors.item);
    if (!itemElement) {
      this.pointerTarget(
        containerId,
        this.itemsIn(containerId, this.drag?.itemId).length,
      );
      return container;
    }
    const rawIndex = this.itemsIn(containerId).indexOf(
      itemElement.dataset[selectors.itemKey] ?? '',
    );
    if (rawIndex < 0) return container;
    this.pointerTarget(
      containerId,
      this.insertionIndex(containerId, rawIndex, itemElement, clientY, clientX),
    );
    return container;
  }

  /** Index to insert at when hovering item `rawIndex`, after removing the dragged item. */
  private insertionIndex(
    containerId: string,
    rawIndex: number,
    itemElement: Element,
    clientY: number,
    clientX?: number,
  ): number {
    const rect = itemElement.getBoundingClientRect();
    let before = clientY < rect.top + rect.height / 2;
    if (this.options.flow?.() && clientX !== undefined) {
      const rootWidth = this.options.root()?.getBoundingClientRect().width ?? 0;
      // A tile narrower than the list shares its row: order is horizontal.
      if (rect.width < rootWidth * 0.95) {
        const mid = rect.left + rect.width / 2;
        before = this.isRtl() ? clientX > mid : clientX < mid;
      }
    }
    let targetIndex = rawIndex + (before ? 0 : 1);
    const drag = this.drag;
    if (
      drag?.source.containerId === containerId &&
      targetIndex > drag.source.index
    ) {
      targetIndex -= 1;
    }
    return targetIndex;
  }

  private finishPointerSession(event: PointerEvent, cancelled = false): void {
    const session = this.pointerSession;
    this.pointerSession = undefined;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture?.(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    if (!session?.active || this.drag?.itemId !== session.itemId) return;
    if (cancelled) {
      this.cancel();
      return;
    }
    const container = this.setPointerTargetFromElement(
      this.elementAtPointer(event),
      event.clientY,
      event.clientX,
    );
    if (container?.disabled) {
      this.say({ type: 'unavailable', container: container.label });
      this.cancel(false);
      return;
    }
    if (!container) {
      this.cancel();
      return;
    }
    void this.drop();
  }

  pointerUp(event: PointerEvent): void {
    this.finishPointerSession(event);
  }

  pointerCancel(event: PointerEvent): void {
    this.finishPointerSession(event, true);
  }

  pointerMove(event: PointerEvent): void {
    const session = this.pointerSession;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.active) {
      const distance = Math.hypot(
        event.clientX - session.startX,
        event.clientY - session.startY,
      );
      if (distance < 6) return;
      this.pickup(session.itemId, 'pointer');
      this.pointerSession = { ...session, active: true };
    }
    event.preventDefault();
    this.setPointerTargetFromElement(
      this.elementAtPointer(event),
      event.clientY,
      event.clientX,
    );
  }

  private pointerTarget(containerId: string, index: number): void {
    const drag = this.drag;
    if (drag?.mode !== 'pointer') return;
    if (
      !this.options.allowSameContainerReorder() &&
      containerId === drag.source.containerId
    ) {
      this.drag = { ...drag, target: { ...drag.source } };
      return;
    }
    const max = this.itemsIn(containerId, drag.itemId).length;
    this.drag = { ...drag, target: { containerId, index: clamp(index, max) } };
  }

  /** Native drop on an item (`rawIndex` is its index in its container). */
  dropOnItem(event: DragEvent, containerId: string, rawIndex: number): void {
    event.preventDefault();
    const drag = this.drag;
    if (drag?.mode !== 'pointer') return;
    const container = this.findContainer(containerId);
    if (container?.disabled) {
      this.say({ type: 'unavailable', container: container.label });
      this.cancel(false);
      return;
    }
    this.pointerTarget(
      containerId,
      this.insertionIndex(
        containerId,
        rawIndex,
        event.currentTarget as HTMLElement,
        event.clientY,
        event.clientX,
      ),
    );
    void this.drop();
  }

  /** Native drop on a container's empty space: append. */
  dropOnContainer(event: DragEvent, containerId: string): void {
    event.preventDefault();
    const container = this.findContainer(containerId);
    if (container?.disabled) {
      this.say({ type: 'unavailable', container: container.label });
      this.cancel(false);
      return;
    }
    this.pointerTarget(
      containerId,
      this.itemsIn(containerId, this.drag?.itemId).length,
    );
    void this.drop();
  }
}

/** Create a controller; call during component initialization. */
export function createSortable(
  options: SortableControllerOptions,
): SortableController {
  return new SortableController(options);
}
