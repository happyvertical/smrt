import type { ShellTargets } from '@happyvertical/smrt-svelte/workspace';
import { highlightControl } from '@happyvertical/smrt-ui/forms';
import { tick } from 'svelte';
import type { BatchResult, PlanSnapshot } from './commands/index.ts';

export type PlannerGuideControl = 'build' | 'export' | 'chef' | 'edit';
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
      | { kind: 'arrival' }
      | { kind: 'control'; control: PlannerGuideControl }
      | { kind: 'addition'; before: PlanSnapshot; result: BatchResult },
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
      clearHighlight = highlightControl(node, 6000, {
        presentation: 'spotlight',
        dismissLabel: 'Dismiss guidance',
        onDismiss: dismiss,
      });
      if (request !== ticket)
        return { ok: false, reason: 'The actual guide target is not visible.' };
      if (input.kind === 'arrival') arrivalShown = true;
      node.addEventListener('click', dismiss, { once: true });
      document.addEventListener('keydown', onKey);
      timer = setTimeout(clear, 6000);
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
