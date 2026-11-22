<script lang="ts">
import { renderAssistantMarkdown } from '@happyvertical/smrt-chat/svelte';
import { ReportResult } from '@happyvertical/smrt-reports/svelte';
import { onDestroy, onMount, tick, untrack } from 'svelte';
import ApprovalCard from '$lib/components/ApprovalCard.svelte';
import { planReplyBlock, plural } from '$lib/ui/changes';
import type { OwnerProfile } from '$lib/ui/format';
import { ASSISTANT_STATUS_EVENT } from '$lib/ui/layout';
import { keyColumns, reportCell, reportCellHref } from '$lib/ui/reports';
import type { ApprovalView, ChangesState } from '$lib/ui/types';
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
  foldsReply,
  groupTurns,
  type Item,
  initialState,
  newestReplyId,
  reduce,
  stopNote,
  workingStep,
} from './reducer';

// The assistant's chat column, docked at the right of the page by the layout
// (smrt-svelte's AppShell `panel`, `panelSide="end"`). `open` is the layout's state: the
// panel stays mounted while closed, so a running turn and the thread survive
// a toggle.
let {
  open = true,
  owner = null,
  changes = null,
  onapply,
}: {
  open?: boolean;
  owner?: OwnerProfile | null;
  /** The ONE changes state (the layout's): the reply block reads its numbers here. */
  changes?: ChangesState | null;
  /** The owner's Apply click from the block; `applyNow` is which button it was. Throws a plain message to show. */
  onapply?: (applyNow: boolean) => Promise<void>;
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
const turns = $derived(groupTurns(dock));
// A turn's steps line: open by the owner's choice; a failed one opens itself.
let stepsOpen = $state<Record<string, boolean>>({});
const lastSteps = $derived(turns.findLast((t) => t.kind === 'steps')?.id);
const block = $derived(planReplyBlock(changes));
// Only the newest block is live; earlier ones in the thread would only repeat it.
const lastBlock = $derived(
  dock.items.findLast((i) => i.kind === 'changes')?.id,
);
// An older long reply folds to a few lines; the newest never does.
const newestReply = $derived(newestReplyId(dock.items));
let unfolded = $state<Record<string, boolean>>({});
let asking = $state(false);
let applying = $state(false);
let applyError = $state('');

async function applyFromBlock() {
  if (!onapply || !block || applying) return;
  applying = true;
  applyError = '';
  try {
    await onapply(block.applyNow);
  } catch (error) {
    applyError =
      error instanceof Error ? error.message : 'Could not apply. Try again.';
  } finally {
    applying = false;
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

async function submit(again?: string) {
  const text = again ?? draft.trim();
  if (!text || dock.running || dock.availability === 'unavailable') return;
  if (again === undefined) draft = '';
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
  stepsOpen = {};
  unfolded = {};
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
    <h2>Assistant</h2>
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

    {#each turns as item (item.id)}
      {#if item.kind === 'user'}
        <p class="smrt-assistant-panel__msg smrt-assistant-panel__user"><span class="smrt-assistant-panel__sr-only">You: </span>{item.text}</p>
      {:else if item.kind === 'assistant'}
        {@const folds = item.id !== newestReply && foldsReply(item.text)}
        {@const folded = folds && !unfolded[item.id]}
        <div id={`reply-${item.id}`} class="smrt-assistant-panel__reply smrt-assistant-panel__markdown" class:smrt-assistant-panel__folded={folded} inert={folded}><span class="smrt-assistant-panel__sr-only">Assistant: </span>{@html renderAssistantMarkdown(item.text)}</div>
        {#if folds}
          <button type="button" class="smrt-assistant-panel__more" aria-expanded={!folded} aria-controls={`reply-${item.id}`} onclick={() => (unfolded = { ...unfolded, [item.id]: folded })}>{folded ? 'Show more' : 'Show less'}</button>
        {/if}
      {:else if item.kind === 'steps'}
        {@const open = stepsOpen[item.id] ?? item.failed}
        <button
          type="button"
          class="smrt-assistant-panel__steps"
          class:smrt-assistant-panel__err={item.failed}
          aria-expanded={open}
          aria-controls={`steps-${item.id}`}
          data-testid={item.live ? 'assistant-working' : undefined}
          onclick={() => (stepsOpen = { ...stepsOpen, [item.id]: !open })}
        >
          {#if item.live}<span class="smrt-assistant-panel__dots" aria-hidden="true"><i></i><i></i><i></i></span>{:else}<span aria-hidden="true">{item.failed ? '!' : '✓'}</span>{/if}
          <span>{item.line}</span>
          <span class="smrt-assistant-panel__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {#if open}
          <ul id={`steps-${item.id}`} class="smrt-assistant-panel__steplist">
            {#each item.rows as row (row.id)}
              <li class:smrt-assistant-panel__err={row.state === 'error'} title={row.state === 'error' ? row.label : undefined}>
                <span aria-hidden="true">{row.state === 'running' ? '…' : row.state === 'ok' ? '✓' : '!'}</span>
                <span>{row.label}{#if row.failures > 1} Tried {row.failures} times.{/if}</span>
                <span class="smrt-assistant-panel__sr-only">{row.state === 'running' ? 'running' : row.state === 'ok' ? 'done' : 'did not work'}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if item.failed && item.retry && item.id === lastSteps}
          <div class="smrt-assistant-panel__oops" role="alert">
            <span>{item.rows.at(-1)?.label ?? "Something didn't work."}</span>
            <button type="button" class="smrt-app-shell__btn" disabled={dock.running} onclick={() => void submit(item.retry)}>Try again</button>
          </div>
        {/if}
      {:else if item.kind === 'report'}
        {#if item.report}
          {@const shown = keyColumns(item.report.result)}
          <div class="smrt-assistant-panel__result" role="group" aria-label={`Report: ${shown.result.title}`}>
            <p class="smrt-assistant-panel__result-h">{shown.result.title}</p>
            <ReportResult result={shown.result} fit formatCell={reportCell} cellHref={reportCellHref} />
            {#if shown.hidden > 0 || item.report.href}
              <p class="smrt-assistant-panel__result-f">
                {#if shown.hidden > 0}<span class="smrt-app-shell__muted">{plural(shown.hidden, 'more column')}</span>{/if}
                {#if item.report.href}<a href={item.report.href}>Open report</a>{/if}
              </p>
            {/if}
          </div>
        {:else if item.href}<a href={item.href}>Open report</a>{/if}
      {:else if item.kind === 'changes'}
        {#if item.id === lastBlock && block}
          <div class="smrt-assistant-panel__block" role="group" aria-label={block.label} data-testid="changes-block">
            <p class="smrt-assistant-panel__block-h">
              <span class="smrt-assistant-panel__count" aria-hidden="true">{block.count}</span>
              <span>{block.count === 1 ? 'change' : 'changes'} waiting</span>
              {#if block.questions > 0}<button type="button" class="smrt-assistant-panel__q" aria-expanded={asking} aria-controls="assistant-block-questions" onclick={() => (asking = !asking)}>{plural(block.questions, 'question')}<span aria-hidden="true">{asking ? '▴' : '▾'}</span></button>{/if}
            </p>
            <ul class="smrt-assistant-panel__block-list">
              {#each block.lines as line, i (i)}<li>{line}</li>{/each}
              {#if block.more > 0}<li class="smrt-app-shell__muted">and {block.more} more</li>{/if}
            </ul>
            {#if block.questions > 0 && asking}
              <div id="assistant-block-questions" class="smrt-assistant-panel__ask">
                {#each block.questionTexts as text, i (i)}<p>{text}</p>{/each}
                <a href="/changes">Answer in Review</a>
              </div>
            {/if}
            <div class="smrt-assistant-panel__block-a">
              {#if block.applyNow}
                <button type="button" class="smrt-app-shell__btn smrt-app-shell__btn-primary" disabled={applying || !block.canApply} onclick={applyFromBlock}>Apply now</button>
                <a class="smrt-app-shell__btn" href="/changes">Review</a>
              {:else if block.lead === 'review'}
                <a class="smrt-app-shell__btn smrt-app-shell__btn-primary" href="/changes">Review</a>
                <button type="button" class="smrt-app-shell__btn" disabled={applying || !block.canApply} onclick={applyFromBlock}>Apply</button>
              {:else}
                <button type="button" class="smrt-app-shell__btn smrt-app-shell__btn-primary" disabled={applying} onclick={applyFromBlock}>Apply</button>
                <a class="smrt-app-shell__btn" href="/changes">Review</a>
              {/if}
            </div>
            {#if applyError}<p class="smrt-app-shell__alert smrt-app-shell__alert-error" role="alert">{applyError}</p>{/if}
          </div>
        {/if}
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
    {#if dock.running && !turns.some((t) => t.kind === 'steps' && t.live)}
      <p class="smrt-assistant-panel__working" data-testid="assistant-working"><span class="smrt-assistant-panel__dots" aria-hidden="true"><i></i><i></i><i></i></span><span>{workingStep(dock)}…</span></p>
    {/if}
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
  .smrt-assistant-panel__working {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
  }
  .smrt-assistant-panel__dots {
    display: inline-flex;
    gap: 0.2rem;
  }
  .smrt-assistant-panel__dots i {
    width: 0.35rem;
    height: 0.35rem;
  }
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
  /* The log is the only scroller: nothing in it shrinks into a box of its own. */
  .smrt-assistant-panel__log > * {
    flex: none;
  }
  .smrt-assistant-panel__msg {
    margin: 0;
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 0.75rem);
    white-space: pre-wrap;
    max-inline-size: 90%;
  }
  /* A reply is plain text as tall as its words: no bubble, no scroll box. */
  .smrt-assistant-panel__reply {
    min-inline-size: 0;
    white-space: normal;
  }
  .smrt-assistant-panel__markdown :global(table) {
    inline-size: 100%;
    table-layout: auto;
  }
  .smrt-assistant-panel__folded {
    max-block-size: 10.5rem;
    overflow: hidden;
  }
  .smrt-assistant-panel__more {
    align-self: flex-start;
    margin: 0;
    padding: 0.1rem 0;
    border: 0;
    background: none;
    font: inherit;
    cursor: pointer;
  }
  .smrt-assistant-panel__markdown :global(:is(p, ul, ol, pre, table)) {
    margin: 0 0 var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-assistant-panel__markdown :global(:is(p, ul, ol, pre, table):last-child) {
    margin-bottom: 0;
  }
  .smrt-assistant-panel__markdown :global(:is(th, td)) {
    padding: 0.2rem 0.5rem;
  }
  .smrt-assistant-panel__user {
    align-self: flex-end;
  }
  .smrt-assistant-panel__steps {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    align-self: flex-start;
    max-inline-size: 100%;
    margin: 0;
    padding: 0.15rem 0.35rem;
    border: 0;
    background: none;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .smrt-assistant-panel__steplist {
    display: grid;
    gap: 0.3rem;
    margin: 0 0 0 0.3rem;
    padding: 0.1rem 0 0.1rem 0.8rem;
    list-style: none;
  }
  .smrt-assistant-panel__steplist li {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
  }
  .smrt-assistant-panel__oops {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-assistant-panel__hint {
    margin: 0;
  }
  .smrt-assistant-panel__result {
    min-inline-size: 0;
  }
  .smrt-assistant-panel__result-h {
    margin: 0;
    padding: 0.55rem 0.75rem;
  }
  .smrt-assistant-panel__result-f {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 0;
    padding: 0.45rem 0.75rem;
  }
  .smrt-assistant-panel__block {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    align-self: stretch;
  }
  .smrt-assistant-panel__block-h {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
  }
  .smrt-assistant-panel__count,
  .smrt-assistant-panel__q {
    padding: 0 0.5rem;
  }
  .smrt-assistant-panel__q {
    margin-inline-start: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border: 0;
    font: inherit;
    cursor: pointer;
  }
  .smrt-assistant-panel__ask {
    display: grid;
    gap: 0.25rem;
  }
  .smrt-assistant-panel__ask p {
    margin: 0;
  }
  .smrt-assistant-panel__block-list {
    margin: 0;
    padding-inline-start: 1.1rem;
  }
  .smrt-assistant-panel__block-a {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
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
  .smrt-assistant-panel__dots i {
    border-radius: 50%;
    background: currentColor;
    animation: smrt-assistant-pulse 1s infinite ease-in-out;
  }
  .smrt-assistant-panel__dots i:nth-child(2) { animation-delay: 0.15s; }
  .smrt-assistant-panel__dots i:nth-child(3) { animation-delay: 0.3s; }
  @keyframes smrt-assistant-pulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .smrt-assistant-panel__dots i { animation: none; } }
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
  .smrt-assistant-panel__msg {
    border-radius: var(--smrt-radius-md, 0.5rem);
  }
  .smrt-assistant-panel__user {
    background: var(--smrt-color-primary-container, rgb(128 128 128 / 0.2));
    color: var(--smrt-color-on-primary-container, inherit);
  }
  .smrt-assistant-panel__folded {
    mask-image: linear-gradient(#000 60%, transparent);
  }
  .smrt-assistant-panel__more {
    color: var(--smrt-color-primary);
    font-size: 0.875rem;
    font-weight: 600;
  }
  .smrt-assistant-panel__result {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-surface-raised, transparent);
  }
  .smrt-assistant-panel__result-h {
    font-size: 0.875rem;
    font-weight: 600;
  }
  .smrt-assistant-panel__result-f {
    border-block-start: var(--smrt-hairline);
    font-size: 0.8125rem;
  }
  .smrt-assistant-panel__block {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface-container, rgb(128 128 128 / 0.1));
  }
  .smrt-assistant-panel__count,
  .smrt-assistant-panel__q {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container, rgb(128 128 128 / 0.2));
    color: var(--smrt-color-on-primary-container, inherit);
  }
  .smrt-assistant-panel__steps,
  .smrt-assistant-panel__steplist {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.8125rem;
  }
  .smrt-assistant-panel__steps:hover {
    background: var(--smrt-color-surface-container, rgb(128 128 128 / 0.1));
    border-radius: var(--smrt-radius-md, 0.5rem);
  }
  .smrt-assistant-panel__steplist {
    border-inline-start: 2px solid var(--smrt-color-outline-variant, currentColor);
  }
  .smrt-assistant-panel__err {
    color: var(--smrt-color-error);
  }
  .smrt-assistant-panel__compose {
    border-block-start: var(--smrt-hairline);
  }
  .smrt-assistant-panel__sr-only {
    border: 0;
  }
  .smrt-assistant-panel__markdown :global(table) {
    border-collapse: collapse;
    font-size: 0.9em;
  }
  .smrt-assistant-panel__markdown :global(:is(th, td)) {
    border: 1px solid var(--smrt-color-outline-variant, currentColor);
    text-align: start;
  }
  .smrt-assistant-panel__markdown :global(th) {
    font-weight: 600;
  }
  .smrt-assistant-panel__block-h {
    font-weight: 600;
  }
  .smrt-assistant-panel__count,
  .smrt-assistant-panel__q {
    font-size: 0.8125rem;
  }
}
</style>
