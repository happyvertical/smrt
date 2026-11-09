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
const announce = $derived.by(() => {
  const last = dock.items.at(-1);
  if (dock.running) return 'The assistant is working.';
  if (last?.kind === 'assistant') return last.text;
  return '';
});

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

<div class="dock" class:open>
  {#if !open}
    <button
      bind:this={toggle}
      type="button"
      class="sh-btn sh-btn-primary toggle"
      aria-expanded="false"
      aria-controls="assistant-panel"
      onclick={openDock}
    >
      Assistant{#if waiting > 0}
        <span class="sh-badge sh-badge-warn">{waiting}<span class="sr-only"> waiting for you</span></span>
      {/if}
    </button>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape closes the panel) -->
    <section
      id="assistant-panel"
      class="panel"
      aria-label="Assistant"
      onkeydown={onPanelKey}
    >
      <header class="bar">
        <h2>Assistant</h2>
        <div class="bar-actions">
          <button type="button" class="sh-btn" onclick={newChat} disabled={dock.items.length === 0 && !dock.running}>New chat</button>
          <button type="button" class="sh-btn" aria-expanded="true" aria-controls="assistant-panel" onclick={closeDock}>Close<span class="sr-only"> assistant</span></button>
        </div>
      </header>

      <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of the conversation) -->
      <div
        class="log"
        bind:this={log}
        role="log"
        aria-label="Conversation"
        aria-busy={dock.running}
        tabindex="0"
      >
        {#if dock.availability === 'unavailable'}
          <div class="sh-alert sh-alert-warn" role="status">
            <strong>The assistant is off.</strong>
            {dock.unavailableMessage}
          </div>
        {:else if dock.items.length === 0 && dock.availability === 'ready'}
          <p class="sh-muted hint">
            Tell me what you want to keep track of, or what to change in your app.
          </p>
        {/if}

        {#each dock.items as item (item.id)}
          {#if item.kind === 'user'}
            <p class="msg user"><span class="sr-only">You: </span>{item.text}</p>
          {:else if item.kind === 'assistant'}
            <p class="msg bot"><span class="sr-only">Assistant: </span>{item.text}</p>
          {:else if item.kind === 'tool'}
            <p
              class="chip"
              class:err={item.state === 'error'}
              title={item.summary}
            >
              <span aria-hidden="true">{item.state === 'running' ? '…' : item.state === 'ok' ? '✓' : '!'}</span>
              <span>{toolLabel(item.name)}</span>
              {#if item.summary}<span class="sh-muted sum">{item.summary}</span>{/if}
              <span class="sr-only">{item.state === 'running' ? 'running' : item.state === 'ok' ? 'done' : 'did not work'}</span>
            </p>
          {:else if item.kind === 'approval'}
            <div class="card">
              <ApprovalCard
                approval={view(item)}
                busy={item.busy}
                message={item.message}
                ondecide={item.state === 'pending' || item.state === 'timeout'
                  ? (approve) => decide(item, approve)
                  : undefined}
              />
              {#if item.detached && item.state === 'pending'}
                <p class="sh-muted">This was asked earlier. Approve it to apply it now.</p>
              {/if}
            </div>
          {:else}
            <p class="sh-alert {item.tone === 'error' ? 'sh-alert-error' : ''}" role={item.tone === 'error' ? 'alert' : 'status'}>{item.text}</p>
          {/if}
        {/each}
      </div>

      <div class="sr-only" aria-live="polite" role="status">{announce}</div>

      <form class="compose" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label class="sr-only" for="assistant-input">Message the assistant</label>
        <textarea
          id="assistant-input"
          class="sh-input"
          bind:this={field}
          bind:value={draft}
          rows="2"
          maxlength="8000"
          placeholder={dock.availability === 'unavailable' ? 'The assistant is off' : 'Ask me to build or change something'}
          disabled={dock.availability === 'unavailable'}
          onkeydown={onKey}
        ></textarea>
        {#if dock.running}
          <button type="button" class="sh-btn" onclick={stop}>Stop</button>
        {:else}
          <button type="submit" class="sh-btn sh-btn-primary" disabled={!canSend}>Send</button>
        {/if}
      </form>
    </section>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  /* Room for the open dock: beside the page on wide screens, below it on phones. */
  :global(body.assistant-open) {
    box-sizing: border-box;
    padding-inline-end: calc(26rem + 2 * var(--smrt-spacing-lg, 1rem));
  }
  .dock {
    position: fixed;
    inset-inline-end: var(--smrt-spacing-lg, 1rem);
    inset-block-end: var(--smrt-spacing-lg, 1rem);
    z-index: 40;
    max-inline-size: calc(100vw - 2 * var(--smrt-spacing-lg, 1rem));
  }
  .panel {
    display: flex;
    flex-direction: column;
    inline-size: min(26rem, calc(100vw - 2 * var(--smrt-spacing-lg, 1rem)));
    max-block-size: min(40rem, 75dvh);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 0.75rem);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface, inherit);
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.25);
    overflow: hidden;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-sm, 0.5rem);
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    border-block-end: 1px solid var(--smrt-color-outline-variant);
  }
  .bar h2 {
    margin: 0;
    font-size: 1rem;
  }
  .bar-actions {
    display: flex;
    gap: var(--smrt-spacing-xs, 0.25rem);
  }
  .log {
    flex: 1;
    min-block-size: 8rem;
    overflow-y: auto;
    padding: var(--smrt-spacing-md, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-sm, 0.5rem);
    overflow-wrap: anywhere;
  }
  .msg {
    margin: 0;
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 0.75rem);
    border-radius: var(--smrt-radius-md, 0.5rem);
    white-space: pre-wrap;
    max-inline-size: 90%;
  }
  .user {
    align-self: flex-end;
    background: var(--smrt-color-primary-container, rgb(128 128 128 / 0.2));
    color: var(--smrt-color-on-primary-container, inherit);
  }
  .bot {
    align-self: flex-start;
    background: var(--smrt-color-surface-container, rgb(128 128 128 / 0.1));
  }
  .chip {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    margin: 0;
    align-self: flex-start;
    padding: 0.125rem var(--smrt-spacing-sm, 0.5rem);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full);
    font-size: 0.8125rem;
  }
  .chip.err {
    border-color: var(--smrt-color-error);
  }
  .sum {
    max-inline-size: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    margin: 0;
  }
  .card :global(.sh-card) {
    margin: 0;
  }
  .compose {
    display: flex;
    gap: var(--smrt-spacing-sm, 0.5rem);
    align-items: flex-end;
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
  }
  .compose textarea {
    flex: 1;
    resize: none;
    min-inline-size: 0;
  }
  .sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  /* Phones: a bottom sheet above the tab bar. */
  @media (max-width: 40rem) {
    :global(body.assistant-open) {
      padding-inline-end: 0;
      padding-block-end: 75dvh;
    }
    .dock {
      inset-inline: 0;
      inset-block-end: 4rem;
      max-inline-size: none;
      padding: var(--smrt-spacing-sm, 0.5rem);
    }
    .dock:not(.open) {
      inset-inline: auto;
      inset-inline-end: var(--smrt-spacing-sm, 0.5rem);
    }
    .panel {
      inline-size: 100%;
      max-block-size: 70dvh;
    }
  }
}
</style>
