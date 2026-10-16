<script lang="ts">
import { Button, Chip, Disclosure } from '@happyvertical/smrt-ui';
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { Textarea } from '@happyvertical/smrt-ui/forms';
import { describeCookbook, summarizeCookbook } from '../cookbook/describe.ts';
import {
  downloadCookbook,
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
import { useDataSource } from '../data/context.ts';
import { kitchenState } from '../kitchen/state.svelte.ts';
import { getLibraryCookbook } from '../library/index.ts';
import { libraryState } from '../library/state.svelte.ts';
import CopyButton from './CopyButton.svelte';

/**
 * The Export tab: what the cookbook holds, a prompt that hands it to a coding
 * agent, the file download (and the command the file needs), Send to kitchen
 * when a kitchen is listening, and, apart from those, Import and Reset.
 */
interface Props {
  /** Replaces `navigator.clipboard.writeText` (tests). */
  write?: (text: string) => Promise<void>;
}

let { write }: Props = $props();

let fileInput: HTMLInputElement | undefined = $state();
let promptBox: ReturnType<typeof Textarea> | undefined = $state();
let commandLine: HTMLElement | undefined = $state();
/** A validated import waiting for the visitor's confirmation. */
let pending = $state<Cookbook | null>(null);
/** What reading the pending import dropped (invalid page customisations). */
let pendingDropped = $state<string[]>([]);
let error = $state('');
let notice = $state('');
let copyNotice = $state('');
let confirmingReset = $state(false);

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

function promptCopyFailed() {
  const element = promptBox?.getElement();
  element?.focus();
  element?.select();
  copyNotice = COPY_BY_HAND;
}

function commandCopyFailed() {
  if (commandLine) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.selectAllChildren(commandLine);
  }
  copyNotice = COPY_BY_HAND;
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

const dataSource = useDataSource();

function confirmReset() {
  cookbookStore.reset();
  // Rows the visitor added, edited or deleted go with the cookbook.
  dataSource.reset?.();
  confirmingReset = false;
  // The shell holds its settings in memory too; reload so it starts from its
  // defaults (the cookbook is already saved empty).
  cookbookStore.flush();
  location.reload();
}
</script>

<div class="export">
  <p class="meta">
    Your recipes, their options, the theme, the layout and customised pages,
    kept together in this browser as one cookbook. Sample records are not part
    of it.
  </p>

  <section class="block" aria-labelledby="summary-heading" data-export-section="summary">
    <h2 id="summary-heading">In this cookbook</h2>
    {#if summary.length}
      <dl class="summary">
        {#each summary as line (line.id)}
          <dt>{line.label}</dt>
          <dd>
            {#if line.chips}
              <ul class="chips">
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
      <p class="quiet">Nothing customised yet. Add recipes or apply a cookbook first.</p>
    {/if}
  </section>

  <section class="block" aria-labelledby="prompt-heading" data-export-section="prompt">
    <h2 id="prompt-heading">Copy prompt for your coding agent</h2>
    <p class="meta" id="prompt-note">
      Paste it into Claude Code, Codex or another coding agent. The prompt
      carries the cookbook, creates the app <code>{appName}</code> with the smrt CLI {prompt.version} and
      starts it. About {formatSize(prompt.bytes)}.
    </p>
    <Textarea
      bind:this={promptBox}
      class="prompt"
      value={prompt.text}
      readonly
      rows={10}
      spellcheck={false}
      wrap="soft"
      aria-label="Prompt for your coding agent"
      aria-describedby="prompt-note"
      interaction={false}
    />
    <div class="actions" data-export-actions="primary">
      <CopyButton
        text={() => prompt.text}
        label="Copy prompt"
        {write}
        oncopied={() => (copyNotice = 'Prompt copied.')}
        onfail={promptCopyFailed}
      />
      {#if kitchenState.config}
        <Button
          variant="secondary"
          disabled={kitchenState.status === 'sending'}
          onclick={() => kitchenState.send(cookbookStore.snapshot())}
        >{kitchenState.status === 'sending' ? 'Sending to kitchen…' : 'Send to kitchen'}</Button>
      {/if}
      <Button variant="secondary" onclick={() => downloadCookbook(current, current.name ?? libraryName)}>Download cookbook</Button>
    </div>
    <p class="notice" role="status" aria-live="polite">{copyNotice}</p>
  </section>

  <section class="block" aria-labelledby="file-heading" data-export-section="file">
    <h2 id="file-heading">The downloaded file</h2>
    <p class="meta">
      Download writes <code>{fileName}</code> ({fileSize}). To make the app from
      it yourself, run this where the file is:
    </p>
    <div class="command">
      <code bind:this={commandLine} data-export-command>{command}</code>
      <CopyButton
        text={() => command}
        label="Copy command"
        variant="secondary"
        {write}
        oncopied={() => (copyNotice = 'Command copied.')}
        onfail={commandCopyFailed}
      />
    </div>
    <Disclosure title="Preview JSON">
      <pre class="json">{serializeCookbook(current)}</pre>
    </Disclosure>
  </section>

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
    <div class="kitchen" role="status" aria-live="polite">
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

  <section class="block replace" aria-labelledby="replace-heading" data-export-section="replace">
    <h2 id="replace-heading">Replace or start over</h2>
    <p class="meta">
      Both replace everything listed above; download a copy first to keep it.
    </p>
    <div class="actions" data-export-actions="replace">
      <Button variant="secondary" onclick={() => fileInput?.click()}>Import cookbook…</Button>
      <Button variant="ghost" onclick={() => (confirmingReset = true)}>Reset</Button>
    </div>
    <p class="meta">
      Import swaps this cookbook for one from a file. Reset empties it and
      removes the sample records you added or changed.
    </p>
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
    <p class="notice" role="status" aria-live="polite">{notice}</p>
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

<ConfirmDialog
  open={confirmingReset}
  title="Reset the cookbook?"
  message="This removes every recipe, saved option, theme and layout change, and the sample records you added or changed. Download a copy first to keep it."
  confirmLabel="Reset"
  destructive
  onconfirm={confirmReset}
  oncancel={() => (confirmingReset = false)}
/>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .export {
    display: grid;
    gap: var(--smrt-spacing-5);
    min-inline-size: 0;
  }

  h2,
  p,
  dl,
  dd,
  pre {
    margin: 0;
  }

  h2 {
    font: var(--smrt-typography-title-medium-font);
  }

  .block {
    display: grid;
    gap: var(--smrt-spacing-3);
    min-inline-size: 0;
  }

  .meta,
  .notice,
  .quiet {
    color: var(--smrt-color-on-surface-variant);
  }

  .notice:empty {
    display: none;
  }

  .summary {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--smrt-spacing-2) var(--smrt-spacing-4);
    align-items: baseline;
  }

  dt {
    font-weight: var(--smrt-typography-weight-semibold);
    white-space: nowrap;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }

  /* The prompt: monospace, wrapped so it fits any width, scrolls vertically. */
  .export :global(.prompt) {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: auto;
    max-block-size: 20rem;
    resize: none;
  }

  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    overflow-wrap: anywhere;
  }

  .command {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }

  .command code {
    flex: 1 1 16rem;
    min-inline-size: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-control-radius);
    background: var(--smrt-surface-sunken);
  }

  .json {
    max-block-size: 20rem;
    overflow: auto;
    padding: var(--smrt-spacing-3);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-control-radius);
    background: var(--smrt-surface-sunken);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* Import and Reset: set apart from the actions above. */
  .replace {
    padding-block-start: var(--smrt-spacing-4);
    border-block-start: var(--smrt-hairline);
  }

  /* Phones: one control per row, the summary in one column. */
  @media (max-width: 30rem) {
    .summary {
      grid-template-columns: minmax(0, 1fr);
    }

    .actions,
    .command {
      flex-direction: column;
      align-items: stretch;
    }

    .actions > :global([data-smrt-component='Button']),
    .command > :global([data-smrt-component='Button']) {
      inline-size: 100%;
    }
  }

  /* Forced colours: the command and preview boxes keep a visible edge. */
  @media (forced-colors: active) {
    .command code,
    .json {
      border-color: CanvasText;
    }
  }
}
</style>
