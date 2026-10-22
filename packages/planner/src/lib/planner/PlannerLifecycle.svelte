<script lang="ts">
import {
  tryUseAdminShell,
  tryUseShellTargets,
} from '@happyvertical/smrt-svelte/workspace';
import { onMount, tick } from 'svelte';
import { aiState } from '../ai/instance.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { provideDataSource, tryUseDataSource } from '../data/context.ts';
import { createPlannerDataSource } from '../data/planner-source.ts';
import { configFromProp } from '../inference/config.ts';
import { libraryState } from '../library/state.svelte.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { type LinkMode, setBasePath } from './app.svelte.ts';
import { createPlannerAssistant } from './assistant.ts';
import { createPlannerGuide } from './guide.ts';
import { plannerController, plannerRuntime } from './instance.ts';
import type { PlannerProps } from './types.ts';
import { resetWorkspace } from './workspace.svelte.ts';
import { workspaceStorage } from './workspace-storage.ts';

let {
  controller = plannerController,
  basePath,
  inference,
  persistence = 'self',
  onready,
  initialConversation,
  cookbookOffers = true,
  conversationalAction,
  nativeAssistant = false,
  links = 'path',
  onreset,
}: Pick<
  PlannerProps,
  | 'controller'
  | 'basePath'
  | 'inference'
  | 'persistence'
  | 'onready'
  | 'initialConversation'
  | 'cookbookOffers'
  | 'conversationalAction'
  | 'onreset'
> & {
  nativeAssistant?: boolean;
  /** `'hash'` in the complete `Planner`, whose pages are fragment routes. */
  links?: LinkMode;
} = $props();

const shell = tryUseAdminShell();
const targets = tryUseShellTargets();
const dataSource =
  tryUseDataSource() ?? provideDataSource(createPlannerDataSource());

$effect.pre(() => {
  if (basePath !== undefined || links !== 'path') {
    setBasePath(basePath ?? '', links);
  }
});

onMount(() => {
  let mounted = true;
  const guide = nativeAssistant
    ? createPlannerGuide({
        targets,
        isMounted: () => mounted,
        revealMenu: () => shell?.expandPanel('left'),
      })
    : undefined;
  const previous = plannerRuntime.onReplaced;
  plannerRuntime.onReplaced = () => dataSource.reset?.();
  if (persistence === 'self' && !cookbookStore.loaded) {
    libraryState.load();
    cookbookStore.hydrate('', workspaceStorage());
  }
  const assistant = inference
    ? createPlannerAssistant(controller, inference)
    : undefined;
  // The complete Planner's own dock and AI models page read `aiState`, the
  // store the static app configures from `planner.config.json`; a mount
  // configures it from the prop instead (the prop wins, as documented).
  if (inference) {
    if ('chat' in inference) aiState.useChat(inference.chat, 'Host model');
    else aiState.configure(configFromProp(inference));
    aiState.hydrate(
      recipeState.ids.length > 0 || recipeState.features.length > 0,
    );
  }
  // Guide lifetime observes the private epoch even without an inference UI.
  // Only an enabled assistant grants public conversation/export capabilities.
  const privateNative = nativeAssistant ? aiState.session.transport : undefined;
  const native = inference ? privateNative : undefined;
  let nativeEpoch = privateNative?.resetRevision;
  const stopGuideReset = privateNative?.subscribeConversation(() => {
    if (privateNative.resetRevision !== nativeEpoch) {
      nativeEpoch = privateNative.resetRevision;
      guide?.dismiss();
    }
  });
  const previousOffers = aiState.session.cookbookOffers;
  const previousHostTurn = aiState.session.hostTurn;
  if (native) {
    aiState.session.cookbookOffers = cookbookOffers;
    aiState.session.hostTurn = conversationalAction;
    if (initialConversation) native.seed(initialConversation);
  }
  onready?.({
    controller,
    ...(guide ? { guide } : {}),
    workspaceStorage: workspaceStorage(),
    reset: (options = {}) =>
      resetWorkspace({
        controller,
        dataSource,
        nativeAssistant: privateNative,
        ...(options.silent ? {} : { onreset }),
      }),
    ...(assistant ? { assistant } : {}),
    ...(native
      ? {
          nativeAssistant: native,
          openAssistant: async () => {
            await tick();
            return (
              mounted &&
              aiState.assistantReady &&
              (shell?.openDockTool('assistant') ?? false)
            );
          },
        }
      : {}),
  });
  return () => {
    mounted = false;
    guide?.dismiss();
    stopGuideReset?.();
    plannerRuntime.onReplaced = previous;
    if (native) {
      aiState.session.cookbookOffers = previousOffers;
      aiState.session.hostTurn = previousHostTurn;
    }
  };
});

$effect(() => {
  if (persistence !== 'self') return;
  void JSON.stringify(cookbookStore.snapshot());
  cookbookStore.scheduleSave();
});
</script>

<svelte:window onpagehide={() => persistence === 'self' && cookbookStore.flush()} />
