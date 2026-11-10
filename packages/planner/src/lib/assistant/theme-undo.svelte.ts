import type { PlannerController } from '../planner/commands/index.ts';
import type { ThemeSetting } from '../theme/theme.ts';
import type { ThemeStore } from './change.ts';

export type UndoStatus = 'available' | 'undone';

export interface ThemeUndo {
  id: string;
  /** The theme before the assistant changed it (undefined was the default). */
  previous: ThemeSetting | undefined;
  status: UndoStatus;
  /** The controller's undo id for the same change, when it made one. */
  commandUndoId?: string;
}

/** What a chat message carries (`toolCallData`) to render its Undo. */
export interface ThemeUndoRef {
  kind: 'theme-undo';
  undoId: string;
}

export const isThemeUndoRef = (value: unknown): value is ThemeUndoRef =>
  !!value &&
  typeof value === 'object' &&
  (value as ThemeUndoRef).kind === 'theme-undo' &&
  typeof (value as ThemeUndoRef).undoId === 'string';

/**
 * Theme changes the assistant made. They apply at once (they are cheap to
 * reverse), and each keeps the theme it replaced so the chat can offer Undo.
 */
export class ThemeUndos {
  undos = $state<Record<string, ThemeUndo>>({});
  private counter = 0;

  /**
   * With a controller, Undo first goes through its undo command (the path
   * every other client uses). That undoes the whole document, so it is only
   * tried while nothing else changed since (no `force`); otherwise, or when
   * the controller no longer holds the entry, the theme the change replaced is
   * put back on its own, leaving later edits alone.
   */
  constructor(
    private readonly store: ThemeStore,
    private readonly controller?: PlannerController,
  ) {}

  record(
    previous: ThemeSetting | undefined,
    commandUndoId?: string,
  ): ThemeUndoRef {
    const id = `theme-undo-${++this.counter}`;
    this.undos[id] = {
      id,
      previous: previous
        ? structuredClone($state.snapshot(previous))
        : undefined,
      status: 'available',
      ...(commandUndoId ? { commandUndoId } : {}),
    };
    return { kind: 'theme-undo', undoId: id };
  }

  undo(id: string): void {
    const entry = this.undos[id];
    if (entry?.status !== 'available') return;
    const undone =
      entry.commandUndoId &&
      this.controller?.run({
        name: 'undo',
        input: { undoId: entry.commandUndoId },
      }).ok;
    if (!undone) this.store.write(entry.previous);
    entry.status = 'undone';
  }
}
