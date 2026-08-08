<script lang="ts">
import type { Snippet } from 'svelte';
import type { FieldPolicyEditorState } from '../../types.js';
import {
  editorStateErrorMessage,
  type FieldPolicyEditorAdapter,
  type FieldPolicyOrganizationScope,
  isFieldPolicyEditorState,
} from '../field-policy-editor.js';
import {
  type FieldPolicyGearController,
  setFieldPolicyGearContext,
} from '../gear-context.svelte.js';
import type { FieldInputRegistry } from '../input-registry.js';
import type { ObjectFormFieldDefinition } from '../types.js';
import FieldPolicyEditor from './FieldPolicyEditor.svelte';

interface Props {
  objectRef: string;
  fields: Readonly<Record<string, ObjectFormFieldDefinition>>;
  adapter: FieldPolicyEditorAdapter;
  inputRegistry?: FieldInputRegistry;
  /** Hosts in an app-wide context pass app; tenant hosts retain the default. */
  organizationScope?: FieldPolicyOrganizationScope;
  children?: Snippet;
}

let {
  objectRef,
  fields,
  adapter,
  inputRegistry,
  organizationScope = 'tenant',
  children,
}: Props = $props();

let editorState = $state<FieldPolicyEditorState | null>(null);
let error = $state<string | null>(null);
let open = $state(false);
let loading = $state(false);

const controller: FieldPolicyGearController = {
  get state() {
    return editorState;
  },
  get error() {
    return error;
  },
  get open() {
    return open;
  },
  get canEdit() {
    return (
      !!editorState &&
      (editorState.capabilities.manage || editorState.capabilities.personalize)
    );
  },
  show() {
    if (this.canEdit) open = true;
  },
  hide() {
    open = false;
  },
  reload,
};
setFieldPolicyGearContext(controller);

function isPermissionDenied(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    ((value as { status?: unknown }).status === 403 ||
      (value as { code?: unknown }).code === 'permission_denied' ||
      (value as { response?: { status?: unknown } }).response?.status === 403)
  );
}

async function reload(generation = ++loadGeneration): Promise<void> {
  loading = true;
  error = null;
  try {
    const result = await adapter.load({ objectRef });
    if (generation !== loadGeneration) return;
    if (isFieldPolicyEditorState(result, objectRef)) {
      editorState = result;
    } else {
      editorState = null;
      error = isPermissionDenied(result)
        ? null
        : editorStateErrorMessage(result);
      open = false;
    }
  } catch (cause) {
    if (generation !== loadGeneration) return;
    editorState = null;
    error = isPermissionDenied(cause)
      ? null
      : cause instanceof Error
        ? cause.message
        : 'Unable to load field settings.';
    open = false;
  } finally {
    if (generation === loadGeneration) loading = false;
  }
}

let loadGeneration = 0;
$effect(() => {
  const generation = ++loadGeneration;
  editorState = null;
  error = null;
  open = false;
  void reload(generation);
  return () => {
    // A delayed transport response must never repopulate a prior object.
    if (loadGeneration === generation) loadGeneration++;
  };
});
</script>

{@render children?.()}
{#if error && !open}
  <p class="field-policy-gear__error" role="alert">{error}</p>
{/if}
{#if open && editorState}
  <FieldPolicyEditor state={editorState} {adapter} {fields} {inputRegistry} {organizationScope} onclose={() => controller.hide()} onmutated={reload} />
{/if}
{#if loading}
  <span class="field-policy-gear__loading" aria-live="polite">Loading field settings…</span>
{/if}

<style>
  .field-policy-gear__error { color: var(--smrt-color-error, #b42318); }
  .field-policy-gear__loading { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
