<script lang="ts">
/**
 * PromptSettingsPanel — the shared prompt-management surface.
 *
 * Purely presentational: it takes rows and callbacks. It does no fetching, and
 * it makes no authorization decision — the host decides who may see the panel
 * and who may write, and enforces that on the server (see
 * `PromptSettingsService` and `PromptOverrideService`). Rendering the app
 * column is a host decision too: apps with no platform-admin tier omit it.
 *
 * Each row renders as its own `<form>`, so a SvelteKit host can point
 * `formAction` at a form action and get a working screen with no client JS:
 * the "override" checkbox and the textarea are independent fields, and
 * whether a scope is overridden is decided by whether its checkbox's name is
 * present in the submitted `FormData` — never by disabling the textarea,
 * which a plain HTML submit could not re-enable. Supplying `onSave` instead
 * intercepts the submit and hands the host the same decision.
 */
import { Badge, Button, Card } from '@happyvertical/smrt-ui/ui';
import type { PromptSettingsChange, PromptSettingsView } from '../types.js';
import {
  appRevertPreview,
  isTemplateEditable,
  supplyingLevelLabel,
  tenantRevertPreview,
} from '../types.js';

export interface Props {
  /** The prompts to manage, in the order they should be rendered. */
  prompts?: PromptSettingsView[];
  /** Column heading for the tenant-scope editor. */
  tenantLabel?: string;
  /**
   * Render the app-scope column. Off by default: an app with no
   * platform-admin tier has nothing to put there.
   */
  showApp?: boolean;
  /**
   * Let the operator change the app column. Ignored unless `showApp`. When
   * false the column is rendered read-only, which is how a tenant admin sees
   * the app-wide default their own override is layered on.
   */
  appEditable?: boolean;
  /** Column heading for the app-scope editor. */
  appLabel?: string;
  /** Disable every control while a save is in flight. */
  busy?: boolean;
  /** Success text to show above the list. */
  message?: string | null;
  /** Error text to show above the list. */
  error?: string | null;
  /** Text for the empty state. */
  emptyMessage?: string;
  /**
   * Identity of what is being edited (typically the tenant id). Unsaved edits
   * are discarded whenever this changes — or, when it is omitted, whenever
   * `prompts` is replaced with a new array, which is what a reloaded server
   * load produces. Without that, a row edited for one tenant would carry its
   * unsaved text into the next tenant's rows under the same key.
   */
  contextKey?: unknown;
  /** Label for each row's submit control. */
  saveLabel?: string;
  /**
   * SvelteKit form action for each row's `<form>` (e.g. `?/savePrompt`). Omit
   * when driving the panel entirely through {@link Props.onSave}.
   */
  formAction?: string;
  /**
   * Called with the requested change instead of submitting the form. The host
   * performs its own permission check and the write.
   */
  onSave?: (change: PromptSettingsChange) => void;
}

const {
  prompts = [],
  tenantLabel = 'Tenant override',
  showApp = false,
  appEditable = false,
  appLabel = 'App override',
  busy = false,
  contextKey,
  message = null,
  error = null,
  emptyMessage = 'No prompts are registered yet. Definitions appear here once they are registered from code.',
  saveLabel = 'Save',
  formAction,
  onSave,
}: Props = $props();

const appIsEditable = $derived(showApp && appEditable);
const canSubmit = $derived(!busy && (onSave != null || formAction != null));

/**
 * Remount the rows when the editing context changes, discarding unsaved
 * edits. Without this an operator's unsaved text would survive a reload or a
 * tenant switch and then be submitted against the new rows.
 */
const resetKey = $derived(contextKey ?? prompts);

function submit(event: SubmitEvent, prompt: PromptSettingsView): void {
  // A non-editable row's controls are disabled, and disabled controls are
  // absent from FormData — a submit would read as "unchecked" and revert an
  // existing override. Such a row is read-only: it never submits.
  if (!isTemplateEditable(prompt)) {
    event.preventDefault();
    return;
  }
  if (!onSave) return;
  event.preventDefault();
  const fields = new FormData(event.currentTarget as HTMLFormElement);
  const change: PromptSettingsChange = {
    key: prompt.key,
    tenantTemplate: fields.has('tenantOverride')
      ? String(fields.get('tenantTemplate') ?? '')
      : null,
  };
  if (appIsEditable) {
    change.appTemplate = fields.has('appOverride')
      ? String(fields.get('appTemplate') ?? '')
      : null;
  }
  onSave(change);
}
</script>

<section class="smrt-prompt-settings-panel__root" data-testid="prompt-settings-panel" data-smrt-component="PromptSettingsPanel">
  {#if message}
    <p class="smrt-prompt-settings-panel__flash" data-smrt-part="message" role="status">{message}</p>
  {/if}
  {#if error}
    <p class="smrt-prompt-settings-panel__flash smrt-prompt-settings-panel__flash-error" data-smrt-part="message" role="alert">{error}</p>
  {/if}

  {#key resetKey}
    {#each prompts as prompt (prompt.key)}
      <Card variant="outlined">
        <div class="smrt-prompt-settings-panel__row" data-smrt-part="row">
          <div class="smrt-prompt-settings-panel__copy" data-smrt-part="body">
            <div class="smrt-prompt-settings-panel__title-row" data-smrt-part="header">
              <h3 class="smrt-prompt-settings-panel__title" data-smrt-part="title">{prompt.description || prompt.key}</h3>
              <Badge variant="default" size="sm">
                {supplyingLevelLabel(prompt.supplyingLevel)}
              </Badge>
            </div>
            <code class="smrt-prompt-settings-panel__key" data-smrt-part="key">{prompt.key}</code>
            <pre class="smrt-prompt-settings-panel__effective" data-smrt-part="body">{prompt.effectiveTemplate}</pre>
          </div>

          <form
            class="smrt-prompt-settings-panel__controls" data-smrt-part="actions"
            method="POST"
            action={formAction}
            onsubmit={(event) => submit(event, prompt)}
          >
            <input type="hidden" name="key" value={prompt.key} />

            {#if showApp}
              {#if appIsEditable}
                <div class="smrt-prompt-settings-panel__field" data-smrt-part="field">
                  <label class="smrt-prompt-settings-panel__toggle">
                    <input
                      type="checkbox"
                      name="appOverride"
                      checked={prompt.appTemplate != null}
                      disabled={busy || !isTemplateEditable(prompt)}
                    />
                    {appLabel}
                  </label>
                  <textarea
                    class="smrt-prompt-settings-panel__textarea"
                    name="appTemplate"
                    aria-label={appLabel}
                    rows="3"
                    disabled={busy || !isTemplateEditable(prompt)}
                    value={prompt.appTemplate ?? appRevertPreview(prompt)}
                  ></textarea>
                  <p class="smrt-prompt-settings-panel__hint" data-smrt-part="hint">
                    Unchecked reverts to: {appRevertPreview(prompt)}
                  </p>
                </div>
              {:else}
                <div class="smrt-prompt-settings-panel__field" data-smrt-part="field">
                  <span class="smrt-prompt-settings-panel__field-label" data-smrt-part="label">{appLabel}</span>
                  <p class="smrt-prompt-settings-panel__readonly" data-smrt-part="value">
                    {prompt.appTemplate ?? appRevertPreview(prompt)}
                  </p>
                </div>
              {/if}
            {/if}

            <div class="smrt-prompt-settings-panel__field" data-smrt-part="field">
              <label class="smrt-prompt-settings-panel__toggle">
                <input
                  type="checkbox"
                  name="tenantOverride"
                  checked={prompt.tenantTemplate != null}
                  disabled={busy || !isTemplateEditable(prompt)}
                />
                {tenantLabel}
              </label>
              <textarea
                class="smrt-prompt-settings-panel__textarea"
                name="tenantTemplate"
                aria-label={tenantLabel}
                rows="4"
                disabled={busy || !isTemplateEditable(prompt)}
                value={prompt.tenantTemplate ?? tenantRevertPreview(prompt)}
              ></textarea>
              <p class="smrt-prompt-settings-panel__hint" data-smrt-part="hint">
                Unchecked reverts to: {tenantRevertPreview(prompt)}
              </p>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!canSubmit || !isTemplateEditable(prompt)}
            >
              {saveLabel}
            </Button>
          </form>
        </div>
      </Card>
    {:else}
      <p class="smrt-prompt-settings-panel__empty" data-smrt-part="empty">{emptyMessage}</p>
    {/each}
  {/key}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-prompt-settings-panel__root {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .smrt-prompt-settings-panel__flash {
    margin: 0;
    padding: 0.625rem 0.75rem;
  }
  .smrt-prompt-settings-panel__empty {
    margin: 0;
  }
  .smrt-prompt-settings-panel__row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(18rem, 26rem);
    gap: 1rem;
    align-items: start;
  }
  .smrt-prompt-settings-panel__copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-prompt-settings-panel__title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .smrt-prompt-settings-panel__title {
    margin: 0;
  }
  .smrt-prompt-settings-panel__key {
    overflow-wrap: anywhere;
  }
  .smrt-prompt-settings-panel__effective {
    margin: 0;
    padding: 0.5rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .smrt-prompt-settings-panel__controls {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-prompt-settings-panel__field {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-prompt-settings-panel__toggle {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .smrt-prompt-settings-panel__textarea {
    width: 100%;
    padding: 0.5rem;
    resize: vertical;
  }
  .smrt-prompt-settings-panel__hint,
  .smrt-prompt-settings-panel__readonly {
    margin: 0;
    overflow-wrap: anywhere;
  }
  @media (max-width: 860px) {
    .smrt-prompt-settings-panel__row {
      grid-template-columns: 1fr;
    }
  }
}

@layer smrt.theme {
  .smrt-prompt-settings-panel__flash {
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-variant);
  }
  .smrt-prompt-settings-panel__flash-error {
    color: var(--smrt-color-error);
    background: var(--smrt-color-error-container);
  }
  .smrt-prompt-settings-panel__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-prompt-settings-panel__title {
    font-size: 1rem;
    line-height: 1.25;
  }
  .smrt-prompt-settings-panel__key {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-prompt-settings-panel__effective {
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-variant);
    font-family: inherit;
    font-size: 0.875rem;
  }
  .smrt-prompt-settings-panel__field-label {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-prompt-settings-panel__toggle {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-prompt-settings-panel__textarea {
    border: var(--smrt-hairline);
    border-radius: 0.375rem;
    background: var(--smrt-color-surface);
    color: inherit;
    font: inherit;
  }
  .smrt-prompt-settings-panel__hint,
  .smrt-prompt-settings-panel__readonly {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.45;
  }
}

</style>
