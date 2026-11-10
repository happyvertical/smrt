<script lang="ts">
import { Button, Card, Chip, Disclosure } from '@happyvertical/smrt-ui';
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { Textarea } from '@happyvertical/smrt-ui/forms';
import { onMount, tick } from 'svelte';
import type { BrowserAssistantTransport } from '../assistant/transport.ts';
import { describeCookbook, summarizeCookbook } from '../cookbook/describe.ts';
import {
  downloadCookbookFile,
  exportFileName,
  exportFileSize,
  formatSize,
  serializeCookbook,
} from '../cookbook/file.ts';
import {
  applyCommand,
  appNameFor,
  buildAgentPrompt,
} from '../cookbook/prompt.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import type { Cookbook } from '../cookbook/types.ts';
import { parseCookbookText } from '../cookbook/validate.ts';
import { kitchenState } from '../kitchen/state.svelte.ts';
import { getLibraryCookbook } from '../library/index.ts';
import { libraryState } from '../library/state.svelte.ts';
import type {
  ExportData,
  PlannerController,
} from '../planner/commands/index.ts';
import { capturePlannerExport } from '../planner/export-context.ts';
import { plannerController } from '../planner/instance.ts';
import type { PlannerExportAction } from '../planner/types.ts';
import CopyButton from './CopyButton.svelte';
import ProjectControls from './ProjectControls.svelte';

/**
 * The Export tab, top to bottom: the host's build action when there is one,
 * what the cookbook holds, a card with the prompt that hands it to a coding
 * agent, a card with the file download and the command the file needs (and
 * Send to kitchen when a kitchen is listening), and, apart from those, Import
 * and Reset.
 */
interface Props {
  /** Replaces `navigator.clipboard.writeText` (tests). */
  write?: (text: string) => Promise<void>;
  exportAction?: PlannerExportAction;
  controller?: PlannerController;
  nativeAssistant?: BrowserAssistantTransport;
  onreset?: () => void;
  resetDisabledReason?: string;
}

let {
  write,
  exportAction,
  controller = plannerController,
  nativeAssistant,
  onreset,
  resetDisabledReason,
}: Props = $props();
let actionPending = $state(false);
let assistantBusy = $state(false);
let actionError = $state('');
onMount(() =>
  nativeAssistant?.subscribeConversation(() => {
    assistantBusy = nativeAssistant?.busy ?? false;
  }),
);
function downloadCurrent() {
  const result = controller.run({ name: 'export_cookbook', input: {} });
  if (result.ok) downloadCookbookFile(result.data as ExportData);
  else actionError = result.error.message;
}
async function runExportAction() {
  if (!exportAction || actionPending) return;
  actionError = '';
  actionPending = true;
  try {
    await exportAction.run(capturePlannerExport(controller, nativeAssistant));
  } catch (cause) {
    actionError =
      cause instanceof Error
        ? cause.message
        : 'The export action could not finish. Try again.';
  } finally {
    actionPending = false;
  }
}

let fileInput: HTMLInputElement | undefined = $state();
let promptBox: ReturnType<typeof Textarea> | undefined = $state();
let commandLine: HTMLElement | undefined = $state();
/** A validated import waiting for the visitor's confirmation. */
let pending = $state<Cookbook | null>(null);
/** What reading the pending import dropped (invalid page customisations). */
let pendingDropped = $state<string[]>([]);
let error = $state('');
let notice = $state('');
let promptNotice = $state('');
let commandNotice = $state('');

// A file is named for the cookbook's own name, else the library cookbook last
// applied, else a generic name.
const libraryName = $derived(
  getLibraryCookbook(libraryState.active ?? '')?.name,
);

const current = $derived(cookbookStore.snapshot());
const summary = $derived(describeCookbook(current));
const fileName = $derived(exportFileName(current.name ?? libraryName));
const fileSize = $derived(formatSize(exportFileSize(current)));
const appName = $derived(appNameFor(current, libraryName));
const prompt = $derived(
  buildAgentPrompt(current, { fallbackName: libraryName }),
);
const command = $derived(applyCommand(fileName, appName));

const COPY_BY_HAND =
  'Copying is not available here. The text is selected: press Ctrl+C (Cmd+C on a Mac) to copy it.';

async function promptCopyFailed() {
  await tick();
  const element = promptBox?.getElement();
  element?.focus();
  element?.select();
  promptNotice = COPY_BY_HAND;
}

function commandCopyFailed() {
  if (commandLine) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.selectAllChildren(commandLine);
  }
  commandNotice = COPY_BY_HAND;
}

async function choose(event: Event & { currentTarget: HTMLInputElement }) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  error = '';
  notice = '';
  if (!file) return;
  try {
    const result = parseCookbookText(await file.text());
    if (result.ok) {
      pending = result.cookbook;
      pendingDropped = result.dropped ?? [];
    } else error = result.error;
  } catch {
    error = 'The file could not be read.';
  }
  // Allow choosing the same file again.
  input.value = '';
}

function confirmImport() {
  if (pending) {
    cookbookStore.replace(pending);
    notice = `Imported ${summarizeCookbook(pending)}.${pendingDropped.length ? ` Not imported: ${pendingDropped.join(' ')}` : ''}`;
  }
  pending = null;
  pendingDropped = [];
}
</script>

<div class="smrt-export-panel__root" data-smrt-component="ExportPanel">
  <div class="smrt-export-panel__intro" data-smrt-part="header">
    <h2>Export</h2>
    <p class="smrt-export-panel__meta" data-smrt-part="meta">Your recipes, theme, layout and customised pages travel together as a cookbook. Sample records stay in this preview.</p>
  </div>

  {#if exportAction}
    <div class="smrt-export-panel__build-step" data-export-actions="primary" data-smrt-part="panel">
      <h3>Build your app</h3>
      <p class="smrt-export-panel__meta" data-smrt-part="meta">Continue with your current plan.</p>
      <div class="smrt-export-panel__actions" data-smrt-part="actions">
        <Button disabled={actionPending || assistantBusy} onclick={runExportAction}>{exportAction.label}</Button>
      </div>
    </div>
  {/if}
  {#if actionError}<Alert variant="error" title="Export action failed">{actionError}</Alert>{/if}
  {#if exportAction && assistantBusy}<p class="smrt-export-panel__meta" data-smrt-part="meta" role="status">Wait for the assistant to finish, or stop it, before continuing.</p>{/if}

  <section class="smrt-export-panel__block" aria-labelledby="summary-heading" data-export-section="summary" data-smrt-part="panel">
    <h3 id="summary-heading">In this cookbook</h3>
    {#if summary.length}
      <dl class="smrt-export-panel__summary" data-smrt-part="summary">
        {#each summary as line (line.id)}
          <dt>{line.label}</dt>
          <dd>
            {#if line.chips}
              <ul class="smrt-export-panel__chips" data-smrt-part="list">
                {#each line.chips as chip, i (`${chip}:${i}`)}
                  <li><Chip label={chip} size="sm" /></li>
                {/each}
              </ul>
            {:else}
              {line.text}
            {/if}
          </dd>
        {/each}
      </dl>
    {:else}
      <p class="smrt-export-panel__quiet" data-smrt-part="empty">Nothing customised yet. Add recipes or apply a cookbook first.</p>
    {/if}
  </section>

  <Card padding="sm" role="group" aria-labelledby="prompt-heading" data-export-section="prompt">
    <div class="smrt-export-panel__card-body" data-smrt-part="body">
      <h3 id="prompt-heading">Copy prompt</h3>
      <p class="smrt-export-panel__meta" data-smrt-part="meta" id="prompt-note">
        Paste it into Claude Code, Codex or another coding agent. The prompt
        carries the cookbook, creates the app <code>{appName}</code> with the smrt CLI {prompt.version} and
        starts it. About {formatSize(prompt.bytes)}.
      </p>
      <div class="smrt-export-panel__actions" data-smrt-part="actions">
        <CopyButton
          text={() => prompt.text}
          label="Copy prompt"
          variant={exportAction ? 'secondary' : 'primary'}
          {write}
          oncopied={() => (promptNotice = 'Prompt copied.')}
          onfail={promptCopyFailed}
        />
      </div>
      <Textarea
        bind:this={promptBox}
        class="smrt-export-panel__prompt"
        value={prompt.text}
        readonly
        rows={7}
        spellcheck={false}
        wrap="soft"
        aria-label="Prompt for your coding agent"
        aria-describedby="prompt-note"
        interaction={false}
      />
      <p class="smrt-export-panel__notice" data-smrt-part="status" role="status" aria-live="polite">{promptNotice}</p>
    </div>
  </Card>

  <Card padding="sm" role="group" aria-labelledby="file-heading" data-export-section="file">
    <div class="smrt-export-panel__card-body" data-smrt-part="body">
      <h3 id="file-heading">Download cookbook</h3>
      <p class="smrt-export-panel__meta" data-smrt-part="meta">
        Download writes <code>{fileName}</code> ({fileSize}). To make the app from
        it yourself, run this where the file is:
      </p>
      <div class="smrt-export-panel__command" data-smrt-part="actions">
        <code bind:this={commandLine} data-export-command>{command}</code>
        <CopyButton
          text={() => command}
          label="Copy command"
          variant="secondary"
          {write}
          oncopied={() => (commandNotice = 'Command copied.')}
          onfail={commandCopyFailed}
        />
      </div>
      <p class="smrt-export-panel__notice" data-smrt-part="status" role="status" aria-live="polite">{commandNotice}</p>
      <div class="smrt-export-panel__actions" data-export-actions="download" data-smrt-part="actions">
        <Button variant={exportAction ? 'secondary' : 'primary'} onclick={downloadCurrent}>Download cookbook</Button>
        {#if kitchenState.config}
          <Button
            variant="secondary"
            disabled={kitchenState.status === 'sending'}
            onclick={() => kitchenState.send(cookbookStore.snapshot())}
          >{kitchenState.status === 'sending' ? 'Sending to kitchen…' : 'Send to kitchen'}</Button>
        {/if}
      </div>
      <Disclosure title="Preview JSON">
        <pre class="smrt-export-panel__json" data-smrt-part="panel">{serializeCookbook(current)}</pre>
      </Disclosure>
    </div>
  </Card>

  {#if kitchenState.needsLink}
    <Alert variant="info" title="Send to kitchen needs its link">
      The kitchen is running, but this page was opened without its one-time
      token. Open the address <code>smrt kitchen</code> printed (it ends in
      <code>#kitchen=…</code>), or download the cookbook and run
      <code>smrt cookbook apply</code> on the file.
    </Alert>
  {/if}
  {#if kitchenState.tokenInConfig}
    <Alert variant="warning" title="Send to kitchen is off">
      This version of <code>smrt kitchen</code> puts its one-time token in a
      file other programs on this computer can read, so the planner does not
      use it. Update the <code>smrt</code> CLI, or download the cookbook and run
      <code>smrt cookbook apply</code> on the file.
    </Alert>
  {/if}
  {#if kitchenState.outcome}
    <div class="smrt-export-panel__kitchen" role="status" aria-live="polite" data-smrt-part="status">
      {#if kitchenState.outcome.ok}
        <Alert variant="success" title="Sent to the kitchen">
          {kitchenState.outcome.result.mode === 'update' ? 'Updated' : 'Created'} the project{kitchenState.outcome.result.dir ? ` in ${kitchenState.outcome.result.dir}` : ''}.
          {#if kitchenState.outcome.result.nextSteps.length}
            Next, in your terminal:
            <ul>
              {#each kitchenState.outcome.result.nextSteps as step (step)}
                <li><code>{step}</code></li>
              {/each}
            </ul>
          {/if}
        </Alert>
      {:else}
        <Alert variant="error" title="The kitchen could not use this cookbook">
          <ul>
            {#each kitchenState.outcome.errors as message (message)}
              <li>{message}</li>
            {/each}
          </ul>
        </Alert>
      {/if}
    </div>
  {/if}

  <section class="smrt-export-panel__block smrt-export-panel__replace" aria-label="Import or reset project" data-export-section="replace" data-smrt-part="panel">
    <Disclosure title="Import or reset project">
      <p class="smrt-export-panel__meta" data-smrt-part="meta">
        Both replace everything listed above; download a copy first to keep it.
      </p>
      <div class="smrt-export-panel__actions" data-export-actions="replace" data-smrt-part="actions">
        <Button variant="secondary" onclick={() => fileInput?.click()}>Import cookbook…</Button>

      </div>
      <p class="smrt-export-panel__meta" data-smrt-part="meta">
        Import swaps this cookbook for one from a file. Reset project also clears
        your conversation, sample records and current Build it draft.
      </p>
      <ProjectControls resetOnly {controller} {nativeAssistant} {onreset} {resetDisabledReason} />
      <input
        bind:this={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        aria-label="Cookbook file"
        onchange={choose}
      />
      {#if error}
        <Alert variant="error" title="Import failed">{error}</Alert>
      {/if}
      <p class="smrt-export-panel__notice" data-smrt-part="status" role="status" aria-live="polite">{notice}</p>
    </Disclosure>
  </section>
</div>

<ConfirmDialog
  open={pending !== null}
  title="Replace the current cookbook?"
  message={pending
    ? `Importing replaces ${summarizeCookbook(current)} with ${summarizeCookbook(pending)}.`
    : ''}
  confirmLabel="Replace"
  destructive
  onconfirm={confirmImport}
  oncancel={() => (pending = null)}
/>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-export-panel__root {
    display: grid;
    gap: var(--smrt-spacing-5);
    min-inline-size: 0;
  }
  h2,
  h3,
  p,
  dl,
  dd,
  pre {
    margin: 0;
  }
  .smrt-export-panel__intro, .smrt-export-panel__build-step, .smrt-export-panel__card-body {
    display: grid;
    gap: var(--smrt-spacing-3);
    min-inline-size: 0;
  }
  .smrt-export-panel__build-step {
    padding: var(--smrt-spacing-4);
  }
  .smrt-export-panel__root :global([data-smrt-component='Card']) {
    min-inline-size: 0;
  }
  .smrt-export-panel__block {
    display: grid;
    gap: var(--smrt-spacing-3);
    min-inline-size: 0;
  }
  .smrt-export-panel__notice:empty {
    display: none;
  }
  .smrt-export-panel__summary {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--smrt-spacing-2) var(--smrt-spacing-4);
    align-items: baseline;
  }
  dt {
    white-space: nowrap;
  }
  .smrt-export-panel__chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .smrt-export-panel__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }
  /* The prompt: monospace, wrapped so it fits any width, scrolls vertically. */
  .smrt-export-panel__root :global(.smrt-export-panel__prompt) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: auto;
    max-block-size: 20rem;
    resize: none;
  }
  code {
    overflow-wrap: anywhere;
  }
  .smrt-export-panel__command {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
  .smrt-export-panel__command code {
    flex: 1 1 16rem;
    min-inline-size: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
  .smrt-export-panel__json {
    max-block-size: 20rem;
    overflow: auto;
    padding: var(--smrt-spacing-3);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Import and Reset: set apart from the actions above. */
  .smrt-export-panel__replace {
    padding-block-start: var(--smrt-spacing-4);
  }
  /* Phones: one control per row, the summary in one column. */
  @media (max-width: 30rem) {
    .smrt-export-panel__summary {
      grid-template-columns: minmax(0, 1fr);
    }
    .smrt-export-panel__actions,
    .smrt-export-panel__command {
      flex-direction: column;
      align-items: stretch;
    }
    /* In a column the 16rem flex-basis would set the height, not the width. */
    .smrt-export-panel__command code {
      flex: 0 0 auto;
    }
    .smrt-export-panel__actions > :global([data-smrt-component='Button']),
    .smrt-export-panel__command > :global([data-smrt-component='Button']) {
      inline-size: 100%;
    }
  }
}

@layer smrt.theme {
  h2 {
    font: var(--smrt-typography-title-medium-font);
  }
  h3 {
    font: var(--smrt-typography-title-small-font);
  }
  .smrt-export-panel__build-step {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-control-radius);
    background: var(--smrt-surface-sunken);
  }
  .smrt-export-panel__meta,
  .smrt-export-panel__notice,
  .smrt-export-panel__quiet {
    color: var(--smrt-color-on-surface-variant);
  }
  dt {
    font-weight: var(--smrt-typography-weight-semibold);
  }
  /* The prompt: monospace, wrapped so it fits any width, scrolls vertically. */
  .smrt-export-panel__root :global(.smrt-export-panel__prompt) {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  .smrt-export-panel__command code {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-control-radius);
    background: var(--smrt-surface-sunken);
  }
  .smrt-export-panel__json {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-control-radius);
    background: var(--smrt-surface-sunken);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size);
  }
  /* Import and Reset: set apart from the actions above. */
  .smrt-export-panel__replace {
    border-block-start: var(--smrt-hairline);
  }
  /* Forced colours: the command and preview boxes keep a visible edge. */
  @media (forced-colors: active) {
    .smrt-export-panel__build-step,
    .smrt-export-panel__root :global([data-smrt-component='Card']),
    .smrt-export-panel__command code,
    .smrt-export-panel__json {
      border-color: CanvasText;
    }
  }
}

</style>
