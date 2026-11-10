<script lang="ts">
import { onDestroy, onMount, tick } from 'svelte';
import ApprovalCard from '$lib/components/ApprovalCard.svelte';
import type { ApprovalView } from '$lib/ui/types';
import {
  AssistantRequestError,
  answerApproval,
  fetchPendingApprovals,
  fetchStatus,
  fetchThread,
  fetchThreads,
  streamTurn,
  UnavailableError,
} from './client';
import {
  type Action,
  announcement,
  type DockState,
  type Item,
  initialState,
  reduce,
  stopNote,
  toolLabel,
} from './reducer';

const OPEN_KEY = 'smrt-app-shell:assistant-open';

let dock = $state<DockState>(initialState);
let open = $state(false);
let draft = $state('');
let views = $state<Record<string, ApprovalView>>({});
let log: HTMLElement | undefined = $state();
let field: HTMLTextAreaElement | undefined = $state();
let toggle: HTMLButtonElement | undefined = $state();
let controller: AbortController | null = null;
let loadedOnce = false;

const send = (action: Action) => {
  dock = reduce(dock, action);
};

const canSend = $derived(
  dock.availability !== 'unavailable' &&
    !dock.running &&
    draft.trim().length > 0,
);
const waiting = $derived(
  dock.items.filter((i) => i.kind === 'approval' && i.state === 'pending')
    .length,
);
const announce = $derived(announcement(dock));

function remember(value: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, value ? '1' : '0');
  } catch {
    // storage is optional
  }
}

async function loadViews() {
  try {
    const pending = await fetchPendingApprovals();
    const next = { ...views };
    for (const a of pending) next[a.id] = a;
    views = next;
    send({ type: 'pending_approvals', approvals: pending });
  } catch {
    // the cards fall back to their summary
  }
}

async function openDock() {
  open = true;
  remember(true);
  if (!loadedOnce) {
    loadedOnce = true;
    try {
      send({ type: 'status', status: await fetchStatus() });
    } catch (error) {
      send({
        type: 'note',
        tone: 'error',
        text:
          error instanceof AssistantRequestError
            ? error.message
            : 'Could not check the assistant.',
      });
    }
    try {
      const [latest] = await fetchThreads();
      if (latest) {
        const t = await fetchThread(latest.id);
        send({ type: 'loaded', threadId: latest.id, messages: t.messages });
      }
    } catch {
      // an empty dock is fine
    }
    await loadViews();
  }
  await tick();
  field?.focus();
  scrollDown();
}

function closeDock() {
  open = false;
  remember(false);
  void tick().then(() => toggle?.focus());
}

function scrollDown() {
  void tick().then(() => {
    if (log) log.scrollTop = log.scrollHeight;
  });
}

async function submit() {
  const text = draft.trim();
  if (!text || dock.running || dock.availability === 'unavailable') return;
  draft = '';
  send({ type: 'send', text });
  controller = new AbortController();
  const mine = controller;
  try {
    await streamTurn(
      { message: text, threadId: dock.threadId, signal: mine.signal },
      (event) => {
        send({ type: 'event', event });
        if (event.type === 'approval_required') void loadViews();
        scrollDown();
      },
    );
  } catch (error) {
    if (error instanceof UnavailableError)
      send({ type: 'unavailable', message: error.message });
    else
      send({
        type: 'note',
        tone: 'error',
        text:
          error instanceof AssistantRequestError
            ? error.message
            : 'Something went wrong.',
      });
  } finally {
    if (mine.signal.aborted)
      send({ type: 'note', tone: 'info', text: 'Stopped.' });
    else {
      const note = stopNote(dock.stop);
      if (note && dock.stop !== 'aborted')
        send({ type: 'note', tone: 'info', text: note });
    }
    send({ type: 'ended' });
    if (controller === mine) controller = null;
    scrollDown();
  }
}

function stop() {
  controller?.abort();
}

function newChat() {
  stop();
  send({ type: 'reset' });
  void loadViews();
  field?.focus();
}

async function decide(
  item: Extract<Item, { kind: 'approval' }>,
  approve: boolean,
) {
  send({ type: 'approval_busy', approvalId: item.approvalId, busy: true });
  try {
    const out = await answerApproval(item.approvalId, approve);
    send({
      type: 'approval_result',
      approvalId: item.approvalId,
      state: out.status,
      message:
        out.status === 'failed'
          ? (out.error ?? 'It could not be applied.')
          : '',
    });
  } catch (error) {
    send({
      type: 'approval_result',
      approvalId: item.approvalId,
      state: null,
      message:
        error instanceof Error ? error.message : 'Could not send your answer.',
    });
  }
}

function view(item: Extract<Item, { kind: 'approval' }>): ApprovalView {
  const known = views[item.approvalId];
  const status = item.state === 'timeout' ? 'pending' : item.state;
  return known
    ? { ...known, status }
    : {
        id: item.approvalId,
        status,
        summary: item.summary,
        preview: item.preview,
        action: null,
        requestedBy: '',
        decidedBy: '',
        decidedAt: '',
        result: null,
        createdAt: '',
      };
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}

function onPanelKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeDock();
  }
}

onMount(() => {
  try {
    if (localStorage.getItem(OPEN_KEY) === '1') void openDock();
  } catch {
    // storage is optional
  }
});
onDestroy(() => controller?.abort());

// While the dock is open the page reserves room for it, so it never covers the
// lists behind it (see the body rules in the style block).
$effect(() => {
  document.body.classList.toggle('assistant-open', open);
  return () => document.body.classList.remove('assistant-open');
});
</script>

<div class="smrt-assistant-dock__root" class:smrt-assistant-dock__open={open} data-smrt-component="AssistantDock">
  {#if !open}
    <button
      bind:this={toggle}
      type="button"
      class="sh-btn sh-btn-primary smrt-assistant-dock__toggle"
      aria-expanded="false"
      aria-controls="assistant-panel"
      onclick={openDock} data-smrt-part="trigger"
    >
      Assistant{#if waiting > 0}
        <span class="sh-badge sh-badge-warn" data-smrt-part="badge">{waiting}<span class="smrt-assistant-dock__sr-only" data-smrt-part="label"> waiting for you</span></span>
      {/if}
    </button>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape closes the panel) -->
    <section
      id="assistant-panel"
      class="smrt-assistant-dock__panel"
      aria-label="Assistant"
      onkeydown={onPanelKey} data-smrt-part="panel"
    >
      <header class="smrt-assistant-dock__bar" data-smrt-part="header">
        <h2>Assistant</h2>
        <div class="smrt-assistant-dock__bar-actions" data-smrt-part="actions">
          <button type="button" class="sh-btn" onclick={newChat} disabled={dock.items.length === 0 && !dock.running} data-smrt-part="trigger">New chat</button>
          <button type="button" class="sh-btn" aria-expanded="true" aria-controls="assistant-panel" onclick={closeDock} data-smrt-part="trigger">Close<span class="smrt-assistant-dock__sr-only" data-smrt-part="label"> assistant</span></button>
        </div>
      </header>

      <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of the conversation) -->
      <div
        class="smrt-assistant-dock__log"
        bind:this={log}
        role="log"
        aria-label="Conversation"
        aria-busy={dock.running}
        tabindex="0" data-smrt-part="list"
      >
        {#if dock.availability === 'unavailable'}
          <div class="sh-alert sh-alert-warn" role="status" data-smrt-part="status">
            <strong>The assistant is off.</strong>
            {dock.unavailableMessage}
          </div>
        {:else if dock.items.length === 0 && dock.availability === 'ready'}
          <p class="sh-muted smrt-assistant-dock__hint" data-smrt-part="hint">
            Tell me what you want to keep track of, or what to change in your app.
          </p>
        {/if}

        {#each dock.items as item (item.id)}
          {#if item.kind === 'user'}
            <p class="smrt-assistant-dock__msg smrt-assistant-dock__user" data-smrt-part="message"><span class="smrt-assistant-dock__sr-only" data-smrt-part="label">You: </span>{item.text}</p>
          {:else if item.kind === 'assistant'}
            <p class="smrt-assistant-dock__msg smrt-assistant-dock__bot" data-smrt-part="message"><span class="smrt-assistant-dock__sr-only" data-smrt-part="label">Assistant: </span>{item.text}</p>
          {:else if item.kind === 'tool'}
            <p
              class="smrt-assistant-dock__chip"
              class:smrt-assistant-dock__err={item.state === 'error'}
              title={item.summary} data-smrt-part="status"
            >
              <span aria-hidden="true">{item.state === 'running' ? '…' : item.state === 'ok' ? '✓' : '!'}</span>
              <span>{toolLabel(item.name)}</span>
              {#if item.summary}<span class="sh-muted smrt-assistant-dock__sum" data-smrt-part="description">{item.summary}</span>{/if}
              <span class="smrt-assistant-dock__sr-only" data-smrt-part="label">{item.state === 'running' ? 'running' : item.state === 'ok' ? 'done' : 'did not work'}</span>
            </p>
          {:else if item.kind === 'approval'}
            <div class="smrt-assistant-dock__card" data-smrt-part="item">
              <ApprovalCard
                approval={view(item)}
                busy={item.busy}
                message={item.message}
                ondecide={item.state === 'pending' || item.state === 'timeout'
                  ? (approve) => decide(item, approve)
                  : undefined}
              />
              {#if item.detached && item.state === 'pending'}
                <p class="sh-muted" data-smrt-part="description">This was asked earlier. Approve it to apply it now.</p>
              {/if}
            </div>
          {:else}
            <p class="sh-alert {item.tone === 'error' ? 'sh-alert-error' : ''}" role={item.tone === 'error' ? 'alert' : 'status'} data-smrt-part="status">{item.text}</p>
          {/if}
        {/each}
      </div>

      <div class="smrt-assistant-dock__sr-only" aria-live="polite" role="status" data-smrt-part="label">{announce}</div>

      <form class="smrt-assistant-dock__compose" onsubmit={(e) => { e.preventDefault(); void submit(); }} data-smrt-part="form">
        <label class="smrt-assistant-dock__sr-only" for="assistant-input" data-smrt-part="label">Message the assistant</label>
        <textarea
          id="assistant-input"
          class="sh-input"
          bind:this={field}
          bind:value={draft}
          rows="2"
          maxlength="8000"
          placeholder={dock.availability === 'unavailable' ? 'The assistant is off' : 'Ask me to build or change something'}
          disabled={dock.availability === 'unavailable'}
          onkeydown={onKey} data-smrt-part="input"
        ></textarea>
        {#if dock.running}
          <button type="button" class="sh-btn" onclick={stop} data-smrt-part="trigger">Stop</button>
        {:else}
          <button type="submit" class="sh-btn sh-btn-primary" disabled={!canSend} data-smrt-part="trigger">Send</button>
        {/if}
      </form>
    </section>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  /* Room for the open dock: beside the page on wide screens, below it on phones. */
  :global(body.assistant-open) {
    box-sizing: border-box;
    padding-inline-end: calc(26rem + 2 * var(--smrt-spacing-lg, 1rem));
  }
  .smrt-assistant-dock__root {
    position: fixed;
    inset-inline-end: var(--smrt-spacing-lg, 1rem);
    inset-block-end: var(--smrt-spacing-lg, 1rem);
    z-index: 40;
    max-inline-size: calc(100vw - 2 * var(--smrt-spacing-lg, 1rem));
  }
  .smrt-assistant-dock__panel {
    display: flex;
    flex-direction: column;
    inline-size: min(26rem, calc(100vw - 2 * var(--smrt-spacing-lg, 1rem)));
    max-block-size: min(40rem, 75dvh);
    overflow: hidden;
  }
  .smrt-assistant-dock__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-sm, 0.5rem);
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
  }
  .smrt-assistant-dock__bar h2 {
    margin: 0;
  }
  .smrt-assistant-dock__bar-actions {
    display: flex;
    gap: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-assistant-dock__log {
    flex: 1;
    min-block-size: 8rem;
    overflow-y: auto;
    padding: var(--smrt-spacing-md, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-sm, 0.5rem);
    overflow-wrap: anywhere;
  }
  .smrt-assistant-dock__msg {
    margin: 0;
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 0.75rem);
    white-space: pre-wrap;
    max-inline-size: 90%;
  }
  .smrt-assistant-dock__user {
    align-self: flex-end;
  }
  .smrt-assistant-dock__bot {
    align-self: flex-start;
  }
  .smrt-assistant-dock__chip {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    margin: 0;
    align-self: flex-start;
    padding: 0.125rem var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-assistant-dock__sum {
    max-inline-size: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-assistant-dock__hint {
    margin: 0;
  }
  .smrt-assistant-dock__card :global([data-smrt-component="ApprovalCard"]) {
    margin: 0;
  }
  .smrt-assistant-dock__compose {
    display: flex;
    gap: var(--smrt-spacing-sm, 0.5rem);
    align-items: flex-end;
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
  }
  .smrt-assistant-dock__compose textarea {
    flex: 1;
    resize: none;
    min-inline-size: 0;
  }
  .smrt-assistant-dock__sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Phones: a bottom sheet above the tab bar. */
  @media (max-width: 40rem) {
    :global(body.assistant-open) {
      padding-inline-end: 0;
      padding-block-end: 75dvh;
    }
    .smrt-assistant-dock__root {
      inset-inline: 0;
      inset-block-end: 4rem;
      max-inline-size: none;
      padding: var(--smrt-spacing-sm, 0.5rem);
    }
    .smrt-assistant-dock__root:not(.smrt-assistant-dock__open) {
      inset-inline: auto;
      inset-inline-end: var(--smrt-spacing-sm, 0.5rem);
    }
    .smrt-assistant-dock__panel {
      inline-size: 100%;
      max-block-size: 70dvh;
    }
  }
}

@layer smrt.theme {
  .smrt-assistant-dock__panel {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 0.75rem);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface, inherit);
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.25);
  }
  .smrt-assistant-dock__bar {
    border-block-end: 1px solid var(--smrt-color-outline-variant);
  }
  .smrt-assistant-dock__bar h2 {
    font-size: 1rem;
  }
  .smrt-assistant-dock__msg {
    border-radius: var(--smrt-radius-md, 0.5rem);
  }
  .smrt-assistant-dock__user {
    background: var(--smrt-color-primary-container, rgb(128 128 128 / 0.2));
    color: var(--smrt-color-on-primary-container, inherit);
  }
  .smrt-assistant-dock__bot {
    background: var(--smrt-color-surface-container, rgb(128 128 128 / 0.1));
  }
  .smrt-assistant-dock__chip {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full);
    font-size: 0.8125rem;
  }
  .smrt-assistant-dock__chip.smrt-assistant-dock__err {
    border-color: var(--smrt-color-error);
  }
  .smrt-assistant-dock__compose {
    border-block-start: 1px solid var(--smrt-color-outline-variant);
  }
  .smrt-assistant-dock__sr-only {
    border: 0;
  }
}
</style>
