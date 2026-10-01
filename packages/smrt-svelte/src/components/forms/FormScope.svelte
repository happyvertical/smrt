<!--
  FormScope — makes the fields inside it readable and proposable by agents
  without rendering a `<form>`.

  Use the rich `<Form webmcp>` when the page has a form: it now passes every
  native attribute and SvelteKit's `enhance` through. FormScope is for the
  cases a `<form>` element does not fit — a fetch-driven wizard whose buttons
  are `type="button"`, an editor made of several independently saved parts,
  or a page that must keep its own `<form>` markup (scoped `form.x` styles).

    <FormScope formId="new-site" purpose="Start a new town site">
      <FormGroup label="Site name" id="site-name"><Input name="name" bind:value={name} /></FormGroup>
    </FormScope>

  Inside, smrt-ui primitives (FormGroup + Input/Select/Textarea/Combobox/…)
  and composites registered through `useControlRegistration` join the nearest
  `<Provider webmcp>` control registry (or a local one), and — with `webmcp`
  (default on) and at least one proposable control — one
  `<formId>_stage_changes` tool lets an agent PROPOSE values. Proposals show
  in the staged-review panel; a person applies them. Nothing is saved or
  submitted by an agent.
-->
<script lang="ts">
import {
  type ControlInteractionRegistry,
  controlProposalInputSchema,
  controlProposalToolName,
  createControlInteractionRegistry,
  StagedControlReview,
  setControlInteractionContext,
  stageControlProposals,
} from '@happyvertical/smrt-ui/forms';
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import { useWebMcpTool } from '../../web/webmcp.svelte.js';
import { tryGetWebMcpUiContext } from '../../web/webmcp-ui-context.js';

export interface Props {
  /** Stable, page-unique form identity (also names the WebMCP tool). */
  formId: string;
  /** Plain-language name of what the form does, for the tool description. */
  purpose?: string;
  /** Register the `<formId>_stage_changes` proposal tool (default true). */
  webmcp?: boolean | { name?: string; description?: string };
  /** Override the registry (tests, nested hosts). */
  interactionRegistry?: ControlInteractionRegistry;
  /** Show the staged-review summary for agent proposals (default true). */
  stagedReview?: boolean;
  children: Snippet;
}

const {
  formId,
  purpose,
  webmcp = true,
  interactionRegistry,
  stagedReview = true,
  children,
}: Props = $props();

const providerUi = tryGetWebMcpUiContext();
const localRegistry = createControlInteractionRegistry();
const registry = $derived(
  interactionRegistry ??
    (providerUi?.enabled ? providerUi.controlRegistry : undefined) ??
    localRegistry,
);

setControlInteractionContext({
  get formId() {
    return formId;
  },
  get registry() {
    return registry;
  },
});

let scope = $state<HTMLDivElement | null>(null);
let formElement = $state<HTMLFormElement | null>(null);
$effect(() => {
  if (!scope) return;
  const element = scope;
  const find = () => {
    formElement = element.querySelector('form');
  };
  find();
  // A form can appear after mount ({#if} around it); keep the reference current.
  const observer = new MutationObserver(find);
  observer.observe(element, { childList: true, subtree: true });
  return () => observer.disconnect();
});

// Record trusted human edits so a staged proposal goes stale when the person
// types over it (the same contract as the base and rich Form).
function recordDirectUserEdit(event: Event) {
  if (!event.isTrusted) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>('[data-smrt-control]');
  const controlId = control?.dataset.smrtControl;
  if (!control || !controlId) return;
  registry.recordUserEdit?.({
    formId,
    controlId,
    subject:
      control.dataset.smrtSubjectType && control.dataset.smrtSubjectId
        ? {
            type: control.dataset.smrtSubjectType,
            id: control.dataset.smrtSubjectId,
          }
        : undefined,
  });
}

$effect(() => {
  const element = scope;
  if (!element) return;
  element.addEventListener('input', recordDirectUserEdit);
  element.addEventListener('change', recordDirectUserEdit);
  return () => {
    element.removeEventListener('input', recordDirectUserEdit);
    element.removeEventListener('change', recordDirectUserEdit);
  };
});

// The registry is not reactive; bump a counter on registration changes so
// the tool's schema follows controls as they mount, unmount, or disable.
let registryRevision = $state(0);
$effect(() => {
  const currentFormId = formId;
  return registry.subscribe((event) => {
    if (event.identity.formId !== currentFormId) return;
    if (
      event.type === 'registered' ||
      event.type === 'unregistered' ||
      event.type === 'refreshed'
    ) {
      registryRevision = untrack(() => registryRevision) + 1;
    }
  });
});

useWebMcpTool(
  () => {
    if (!webmcp) return null;
    void registryRevision;
    const options = typeof webmcp === 'object' ? webmcp : {};
    const currentRegistry = registry;
    const currentFormId = formId;
    const inputSchema = controlProposalInputSchema(
      currentRegistry,
      currentFormId,
    );
    // Nothing an agent could fill (yet): no tool, rather than an empty one.
    if (Object.keys(inputSchema.properties as object).length === 0) return null;
    return {
      name: options.name ?? controlProposalToolName(currentFormId),
      description:
        options.description ??
        `Propose values for the "${purpose ?? currentFormId}" form. The person reviews and applies them; nothing is saved or submitted.`,
      inputSchema,
      // Stages proposals only: write-class, never destructive.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const result = await stageControlProposals(
          currentRegistry,
          currentFormId,
          (args ?? {}) as Record<string, unknown>,
          { source: 'agent', actorId: 'assistant' },
        );
        return JSON.stringify({
          ...result,
          message:
            result.staged > 0
              ? 'Proposed changes are waiting for the person to review and apply them. Nothing was saved or submitted.'
              : 'No reviewable changes provided',
        });
      },
    };
  },
  // Same fallback as `<Form webmcp>`: used only when no Provider declares an
  // explicit `webmcp.effects` policy.
  { effects: ['read', 'write'] },
);
</script>

<div class="smrt-form-scope" data-smrt-form-scope={formId} bind:this={scope}>
  {@render children()}
  <StagedControlReview {registry} {formId} {formElement} summary={stagedReview} />
</div>

<style>
  /* Layout-neutral: the wrapped content lays out exactly as before. */
  .smrt-form-scope {
    display: contents;
  }
</style>
