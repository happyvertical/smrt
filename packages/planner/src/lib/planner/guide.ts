import type { ShellTargets } from '@happyvertical/smrt-svelte/workspace';
import { highlightControl } from '@happyvertical/smrt-ui/forms';
import { tick } from 'svelte';
import type { BatchResult, PlanSnapshot } from './commands/index.ts';

export type PlannerGuideControl =
  | 'build'
  | 'export'
  | 'chef'
  | 'edit'
  | 'specs'
  | 'styles';
export const PLANNER_GUIDE_CONTROLS = {
  build: {
    targetId: 'item:planner-host-action',
    label: 'Build it',
    description:
      'Build it prepares your current plan and conversation for the next build step.',
  },
  export: {
    targetId: 'item:planner-export',
    label: 'Export',
    description:
      'Export opens the cookbook download and prompt options for your current plan.',
  },
  chef: {
    targetId: 'item:planner-customize',
    label: 'Plan the app',
    description:
      'The chef hat opens Cookbooks, Recipes, Theme and Settings to plan your app.',
  },
  specs: {
    targetId: 'item:planner-specs',
    label: 'Specs',
    description:
      'Specs holds anything your app must also do beyond its features.',
  },
  styles: {
    targetId: 'item:planner-styles',
    label: 'Styles',
    description: 'Styles changes how your app looks: theme and settings.',
  },
  edit: {
    targetId: 'item:layout-edit',
    label: 'Edit',
    description:
      'Edit lets you rearrange the menu and page layout in the planner.',
  },
} satisfies Record<
  PlannerGuideControl,
  { targetId: string; label: string; description: string }
>;

export interface PlannerGuideResult {
  ok: boolean;
  targetId?: string;
  label?: string;
  description?: string;
  reason?: string;
}
export interface PlannerGuideHandle {
  highlight(
    input:
      | { kind: 'arrival'; holdMs?: number }
      | { kind: 'control'; control: PlannerGuideControl; holdMs?: number }
      | {
          kind: 'addition';
          before: PlanSnapshot;
          result: BatchResult;
          holdMs?: number;
        },
  ): Promise<PlannerGuideResult>;
  dismiss(): void;
}
/** Semantic target choice is based on actual before/after execution, never catalog order. */
export function additionGuideTarget(before: PlanSnapshot, result: BatchResult) {
  if (!result.ok || !result.receipt.changed || result.replayed) return;
  const previous = new Set(
    before.sections.flatMap((section) => section.items.map((item) => item.id)),
  );
  for (const section of result.snapshot.sections) {
    if (section.hidden) continue;
    const item = section.items.find(
      (value) => !value.hidden && !previous.has(value.id),
    );
    if (item) return { section, item };
  }
}
/** Default spotlight lifetime, and the bounds a host may hold one for. */
export const GUIDE_HOLD_MS = { default: 6000, min: 1000, max: 30000 } as const;
export function guideHold(holdMs: unknown): number {
  return typeof holdMs === 'number' && Number.isFinite(holdMs)
    ? Math.min(GUIDE_HOLD_MS.max, Math.max(GUIDE_HOLD_MS.min, holdMs))
    : GUIDE_HOLD_MS.default;
}
export function createPlannerGuide(options: {
  targets?: ShellTargets;
  isMounted: () => boolean;
  revealMenu?: () => void;
}): PlannerGuideHandle {
  let active: HTMLElement | undefined;
  let clearHighlight: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticket = 0;
  let arrivalShown = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    clearHighlight?.();
    clearHighlight = undefined;
    if (active) {
      delete active.dataset.smrtHighlighted;
      active.removeEventListener('click', dismiss);
    }
    active = undefined;
    if (typeof document !== 'undefined')
      document.removeEventListener('keydown', onKey);
  };
  const dismiss = () => {
    ticket++;
    clear();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismiss();
  };
  return {
    dismiss,
    async highlight(input) {
      // A host narrating the guide may hold it for as long as it speaks.
      const hold = guideHold(input.holdMs);
      if (input.kind === 'arrival' && arrivalShown)
        return { ok: false, reason: 'Arrival guidance was already shown.' };
      const request = ++ticket;
      const added =
        input.kind === 'addition'
          ? additionGuideTarget(input.before, input.result)
          : undefined;
      if (input.kind === 'addition' && !added)
        return { ok: false, reason: 'No new visible menu item was added.' };
      if (added) options.revealMenu?.();
      await tick();
      if (!options.isMounted() || request !== ticket)
        return { ok: false, reason: 'Guidance is no longer active.' };
      const control =
        PLANNER_GUIDE_CONTROLS[
          input.kind === 'control' ? input.control : 'edit'
        ];
      const targetId = added?.section.id ?? control.targetId;
      const node =
        options.targets?.get(targetId) ??
        (added ? options.targets?.get(added.item.id) : undefined);
      if (!node)
        return {
          ok: false,
          reason: 'The actual guide target is not available.',
        };
      clear();
      active = node;
      clearHighlight = highlightControl(node, hold, {
        presentation: 'spotlight',
        dismissLabel: 'Dismiss guidance',
        onDismiss: dismiss,
      });
      if (request !== ticket)
        return { ok: false, reason: 'The actual guide target is not visible.' };
      if (input.kind === 'arrival') arrivalShown = true;
      node.addEventListener('click', dismiss, { once: true });
      document.addEventListener('keydown', onKey);
      timer = setTimeout(clear, hold);
      return {
        ok: true,
        targetId: node.dataset.smrtTarget ?? targetId,
        label: added?.section.label ?? control.label,
        description: added
          ? `Find ${added.item.label} under ${added.section.label} in the planner’s main menu.`
          : control.description,
      };
    },
  };
}
