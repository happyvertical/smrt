import type { ThemeSetting } from '../theme/theme.ts';
import type { ThemeStore } from './change.ts';

export type UndoStatus = 'available' | 'undone';

export interface ThemeUndo {
  id: string;
  /** The theme before the assistant changed it (undefined was the default). */
  previous: ThemeSetting | undefined;
  status: UndoStatus;
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

  constructor(private readonly store: ThemeStore) {}

  record(previous: ThemeSetting | undefined): ThemeUndoRef {
    const id = `theme-undo-${++this.counter}`;
    this.undos[id] = {
      id,
      previous: previous
        ? structuredClone($state.snapshot(previous))
        : undefined,
      status: 'available',
    };
    return { kind: 'theme-undo', undoId: id };
  }

  undo(id: string): void {
    const entry = this.undos[id];
    if (entry?.status !== 'available') return;
    this.store.write(entry.previous);
    entry.status = 'undone';
  }
}
