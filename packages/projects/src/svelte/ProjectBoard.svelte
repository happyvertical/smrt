<script lang="ts">
import {
  Board,
  type BoardCard,
  type BoardColumn,
  type BoardMoveIntent,
} from '@happyvertical/smrt-svelte/board';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { ProjectItem, ProjectStatus } from '../types.js';
import { M } from './i18n.js';
import type { ProjectBoardMoveIntent } from './project-board-types.js';

interface ProjectBoardColumn extends BoardColumn {
  status?: string;
}

interface ProjectBoardCard extends BoardCard {
  item: ProjectItem;
  columnId: string;
}

interface ProjectBoardBaseProps {
  /** Provider project identity, forwarded only to the injected move action. */
  projectId: string;
  /** Canonical, ordered provider statuses. Their supplied order is preserved. */
  statuses: readonly ProjectStatus[];
  /** Authoritative provider items; this adapter never reorders them locally. */
  items: readonly ProjectItem[];
  onselect?: (item: ProjectItem) => void;
  label?: string;
}

interface ReadOnlyProjectBoardProps {
  /** Omit both callbacks to expose a read-only controlled board. */
  onmove?: never;
  onrefresh?: never;
}

interface MovableProjectBoardProps {
  /**
   * Browser-safe mutation boundary. Its consumer attaches authorization in a
   * server action before it calls ProjectBoardService.
   */
  onmove: (intent: ProjectBoardMoveIntent) => void | Promise<void>;
  /** Required reconciliation of controlled cards after every move attempt. */
  onrefresh: () => void | Promise<void>;
}

/** A controlled project board is movable only with an authoritative refresh. */
export type Props = ProjectBoardBaseProps &
  (ReadOnlyProjectBoardProps | MovableProjectBoardProps);

let { projectId, statuses, items, onmove, onrefresh, onselect, label }: Props =
  $props();

const { t } = useI18n();
const unmatchedColumnId = '__smrt_projects_unmatched__';
const statusByName = $derived(
  new Map(statuses.map((status) => [status.name, status])),
);
const hasUnmatchedItems = $derived(
  items.some((item) => !statusByName.has(item.status ?? '')),
);
const movementEnabled = $derived(
  onmove !== undefined && onrefresh !== undefined,
);
const columns = $derived<ProjectBoardColumn[]>([
  ...statuses.map((status) => ({
    id: status.id,
    label: status.name,
    status: status.name,
  })),
  ...(hasUnmatchedItems
    ? [
        {
          id: unmatchedColumnId,
          label: t(M['projects.project_board.unassigned']),
          disabled: true,
        },
      ]
    : []),
]);
const cards = $derived<ProjectBoardCard[]>(
  items.map((item) => ({
    id: item.id,
    item,
    columnId: statusByName.has(item.status ?? '')
      ? statusByName.get(item.status ?? '')?.id
      : unmatchedColumnId,
  })),
);

async function refresh(): Promise<void> {
  if (!onrefresh) throw new Error('Project board refresh is required.');
  await onrefresh();
}

async function move(
  intent: BoardMoveIntent<ProjectBoardCard, ProjectBoardColumn>,
): Promise<void> {
  const target = columns.find((column) => column.id === intent.target.columnId);
  if (!target?.status || target.disabled || !onmove || !onrefresh) {
    throw new Error('Project board move failed.');
  }

  try {
    await onmove({
      projectId,
      itemId: intent.card.item.id,
      status: target.status,
    });
    await refresh();
  } catch {
    // Controlled cards never become local truth. Re-fetch even when the
    // mutation fails so a provider-side partial success is corrected.
    try {
      await refresh();
    } catch {
      // The original operation's failure is intentionally not exposed to the
      // browser; it may contain provider details.
    }
    // Board owns the single live-region announcement and focus restoration.
    throw new Error('Project board move failed.');
  }
}

function cardLabel(card: ProjectBoardCard): string {
  return card.item.title ?? card.item.id;
}
</script>

<Board
  {columns}
  {cards}
  label={label ?? t(M['projects.project_board.aria'])}
  getCardColumnId={(card) => card.columnId}
  setCardColumnId={(card, columnId) => ({ ...card, columnId })}
  getCardLabel={cardLabel}
  onmove={movementEnabled ? move : undefined}
  onselect={(card) => onselect?.(card.item)}
>
  {#snippet card({ card })}
    <!-- raw-primitive-allow: each board card is a semantic project selection control -->
    <strong>{card.item.title ?? card.item.id}</strong>
    <small>{card.item.type}</small>
    {#if card.item.assignees?.length}
      <small>{card.item.assignees.join(', ')}</small>
    {/if}
  {/snippet}
</Board>

<style>
  small {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
