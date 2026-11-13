<script lang="ts">
import { Badge } from '@happyvertical/smrt-ui';
import { onDestroy, onMount, tick, untrack } from 'svelte';
import ApprovalCard from '$lib/components/ApprovalCard.svelte';
import type { OwnerProfile } from '$lib/ui/format';
import { ASSISTANT_STATUS_EVENT } from '$lib/ui/layout';
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

// The assistant's chat column, docked between the sidebar and the content by
// the layout (smrt-svelte's AppShell `panel`). `open` is the layout's state: the
// panel stays mounted while closed, so a running turn and the thread survive
// a toggle.
let {
  open = true,
  buildingInDraft = false,
  owner = null,
}: {
  open?: boolean;
  buildingInDraft?: boolean;
  owner?: OwnerProfile | null;
} = $props();

let dock = $state<DockState>(initialState);
let draft = $state('');
let views = $state<Record<string, ApprovalView>>({});
let log: HTMLElement | undefined = $state();
let field: HTMLTextAreaElement | undefined = $state();
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
const announce = $derived(announcement(dock));

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

// Ignore stale responses when connection changes overlap an initial status check.
let statusRequest = 0;
async function refreshStatus() {
  const request = ++statusRequest;
  try {
    const status = await fetchStatus();
    if (request === statusRequest) send({ type: 'status', status });
  } catch {
    // Keep the last known status; connection controls report their own failures.
  }
}
onMount(() => {
  const changed = () => void refreshStatus();
  window.addEventListener(ASSISTANT_STATUS_EVENT, changed);
  return () => window.removeEventListener(ASSISTANT_STATUS_EVENT, changed);
});

async function activate(focus: boolean) {
  await refreshStatus();
  if (!loadedOnce) {
    loadedOnce = true;
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
  if (focus) field?.focus();
  scrollDown();
}

let shownBefore = false;
$effect(() => {
  if (!open) return;
  // Only a toggle after the first paint takes focus; opening because the
  // choice was remembered must not steal it from the page.
  const focus = shownBefore;
  shownBefore = true;
  untrack(() => void activate(focus));
});

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
      send({
        type: 'unavailable',
        message: error.message,
        ...(error.action ? { action: error.action } : {}),
      });
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

onDestroy(() => controller?.abort());
</script>

<div id="assistant-panel" class="smrt-assistant-panel__panel">
  <header class="smrt-assistant-panel__bar">
    <div class="smrt-assistant-panel__title">
      <h2>Assistant</h2>
      {#if buildingInDraft}<Badge variant="warning">Building in draft</Badge>{/if}
      {#if dock.engineLabel}<p class="smrt-app-shell__muted smrt-assistant-panel__engine">Using {dock.engineLabel}</p>{/if}
    </div>
    <div class="smrt-assistant-panel__bar-actions">
      <button type="button" class="smrt-app-shell__btn" onclick={newChat} disabled={dock.items.length === 0 && !dock.running}>New chat</button>
    </div>
  </header>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of the conversation) -->
  <div
    class="smrt-assistant-panel__log"
    bind:this={log}
    role="log"
    aria-label="Conversation"
    aria-busy={dock.running}
    tabindex="0"
  >
    {#if dock.availability === 'unavailable'}
      <div class="smrt-app-shell__alert smrt-app-shell__alert-warn" role="status">
        <strong>The assistant is off.</strong>
        {dock.unavailableMessage}
        <a href={dock.unavailableAction?.href ?? '/settings/inference'}>{dock.unavailableAction?.label ?? 'Open Inference settings'}</a>
      </div>
    {:else if dock.items.length === 0 && dock.availability === 'ready'}
      <p class="smrt-app-shell__muted smrt-assistant-panel__hint">
        Tell me what you want to keep track of, or what to change in your app.
      </p>
    {/if}

    {#each dock.items as item (item.id)}
      {#if item.kind === 'user'}
        <p class="smrt-assistant-panel__msg smrt-assistant-panel__user"><span class="smrt-assistant-panel__sr-only">You: </span>{item.text}</p>
      {:else if item.kind === 'assistant'}
        <p class="smrt-assistant-panel__msg smrt-assistant-panel__bot"><span class="smrt-assistant-panel__sr-only">Assistant: </span>{item.text}</p>
      {:else if item.kind === 'tool'}
        <p
          class="smrt-assistant-panel__chip"
          class:smrt-assistant-panel__err={item.state === 'error'}
          title={item.summary}
        >
          <span aria-hidden="true">{item.state === 'running' ? '…' : item.state === 'ok' ? '✓' : '!'}</span>
          <span>{toolLabel(item.name)}</span>
          {#if item.summary}<span class="smrt-app-shell__muted smrt-assistant-panel__sum">{item.summary}</span>{/if}
          {#if item.copy}<span class="smrt-app-shell__muted">{item.copy === 'draft' ? 'Draft copy. Your live app is unchanged.' : 'Live copy.'}</span>{/if}
          <span class="smrt-assistant-panel__sr-only">{item.state === 'running' ? 'running' : item.state === 'ok' ? 'done' : 'did not work'}</span>
        </p>
      {:else if item.kind === 'approval'}
        <div class="smrt-assistant-panel__card">
          <ApprovalCard
            approval={view(item)}
            {owner}
            busy={item.busy}
            message={item.message}
            ondecide={item.state === 'pending' || item.state === 'timeout'
              ? (approve) => decide(item, approve)
              : undefined}
          />
          {#if item.detached && item.state === 'pending'}
            <p class="smrt-app-shell__muted">This was asked earlier. Approve it to apply it now.</p>
          {/if}
        </div>
      {:else}
        <p class="smrt-app-shell__alert {item.tone === 'error' ? 'smrt-app-shell__alert-error' : ''}" role={item.tone === 'error' ? 'alert' : 'status'}>{item.text}{#if item.action} <a class="smrt-app-shell__link" href={item.action.href}>{item.action.label}</a>{/if}</p>
      {/if}
    {/each}
  </div>

  <div class="smrt-assistant-panel__sr-only" aria-live="polite" role="status">{announce}</div>

  <form class="smrt-assistant-panel__compose" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <label class="smrt-assistant-panel__sr-only" for="assistant-input">Message the assistant</label>
    <textarea
      id="assistant-input"
      class="smrt-app-shell__input"
      bind:this={field}
      bind:value={draft}
      rows="2"
      maxlength="8000"
      placeholder={dock.availability === 'unavailable' ? 'The assistant is off' : 'Ask me to build or change something'}
      disabled={dock.availability === 'unavailable'}
      onkeydown={onKey}
    ></textarea>
    {#if dock.running}
      <button type="button" class="smrt-app-shell__btn" onclick={stop}>Stop</button>
    {:else}
      <button type="submit" class="smrt-app-shell__btn smrt-app-shell__btn-primary" disabled={!canSend}>Send</button>
    {/if}
  </form>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  /* Fills the docked column the layout gives it; the column owns the edge,
  width and resizing. */
  .smrt-assistant-panel__panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-block-size: 0;
    block-size: 100%;
    overflow: hidden;
  }
  .smrt-assistant-panel__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-sm, 0.5rem);
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
  }
  .smrt-assistant-panel__bar h2 {
    margin: 0;
  }
  .smrt-assistant-panel__title {
    min-inline-size: 0;
  }
  .smrt-assistant-panel__engine {
    margin: 0;
  }
  .smrt-assistant-panel__bar-actions {
    display: flex;
    gap: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-assistant-panel__log {
    flex: 1;
    min-block-size: 0;
    overflow-y: auto;
    padding: var(--smrt-spacing-md, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-sm, 0.5rem);
    overflow-wrap: anywhere;
  }
  .smrt-assistant-panel__msg {
    margin: 0;
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 0.75rem);
    white-space: pre-wrap;
    max-inline-size: 90%;
  }
  .smrt-assistant-panel__user {
    align-self: flex-end;
  }
  .smrt-assistant-panel__bot {
    align-self: flex-start;
  }
  .smrt-assistant-panel__chip {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    margin: 0;
    align-self: flex-start;
    padding: 0.125rem var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-assistant-panel__sum {
    max-inline-size: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-assistant-panel__hint {
    margin: 0;
  }
  .smrt-assistant-panel__card :global(.smrt-app-shell__card) {
    margin: 0;
  }
  .smrt-assistant-panel__compose {
    display: flex;
    gap: var(--smrt-spacing-sm, 0.5rem);
    align-items: flex-end;
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
  }
  .smrt-assistant-panel__compose textarea {
    flex: 1;
    resize: none;
    min-inline-size: 0;
  }
  .smrt-assistant-panel__sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  /* Fills the docked column the layout gives it; the column owns the edge,
  width and resizing. */
  .smrt-assistant-panel__panel {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface, inherit);
  }
  .smrt-assistant-panel__bar {
    border-block-end: var(--smrt-hairline);
  }
  .smrt-assistant-panel__bar h2 {
    font-size: 1rem;
  }
  .smrt-assistant-panel__engine {
    font-size: 0.8125rem;
  }
  .smrt-assistant-panel__msg {
    border-radius: var(--smrt-radius-md, 0.5rem);
  }
  .smrt-assistant-panel__user {
    background: var(--smrt-color-primary-container, rgb(128 128 128 / 0.2));
    color: var(--smrt-color-on-primary-container, inherit);
  }
  .smrt-assistant-panel__bot {
    background: var(--smrt-color-surface-container, rgb(128 128 128 / 0.1));
  }
  .smrt-assistant-panel__chip {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full);
    font-size: 0.8125rem;
  }
  .smrt-assistant-panel__chip.smrt-assistant-panel__err {
    border-color: var(--smrt-color-error);
  }
  .smrt-assistant-panel__compose {
    border-block-start: var(--smrt-hairline);
  }
  .smrt-assistant-panel__sr-only {
    border: 0;
  }
}
</style>
