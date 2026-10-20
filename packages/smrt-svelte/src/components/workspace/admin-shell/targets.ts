import { getContext, setContext } from 'svelte';

const TARGETS = Symbol('smrt-shell-targets');
/** Scoped semantic shell anchors. No selectors, navigation, or tour state. */
export interface ShellTargets {
  get(id: string): HTMLElement | undefined;
  register(id: string, node: HTMLElement): () => void;
}
export function createShellTargets(): ShellTargets {
  const targets = new Map<string, HTMLElement[]>();
  const registry: ShellTargets = {
    get(id) {
      return targets
        .get(id)
        ?.find(
          (node) =>
            node.isConnected &&
            !node.closest('[hidden],[inert],[aria-hidden="true"]') &&
            (typeof node.checkVisibility !== 'function' ||
              node.checkVisibility()),
        );
    },
    register(id, node) {
      node.dataset.smrtTarget = id;
      targets.set(id, [...(targets.get(id) ?? []), node]);
      return () => {
        const remaining =
          targets.get(id)?.filter((value) => value !== node) ?? [];
        if (remaining.length) targets.set(id, remaining);
        else targets.delete(id);
        delete node.dataset.smrtTarget;
      };
    },
  };
  return registry;
}
export function provideShellTargets(): ShellTargets {
  const registry = createShellTargets();
  setContext(TARGETS, registry);
  return registry;
}
export function tryUseShellTargets(): ShellTargets | undefined {
  return getContext<ShellTargets>(TARGETS);
}
/** Svelte action factory keeps registration lifetime aligned with the real node. */
export function shellTargetAction(registry: ShellTargets | undefined) {
  return (node: HTMLElement, id: string) => {
    let unregister = registry?.register(id, node);
    return {
      update(next: string) {
        unregister?.();
        unregister = registry?.register(next, node);
      },
      destroy() {
        unregister?.();
      },
    };
  };
}
