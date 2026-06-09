<script lang="ts">
/**
 * ContentAgentChat
 * Renders an AI chat interface alongside a specific piece of content,
 * supporting multiple topics (threads).
 */

import { AgentChat } from '@happyvertical/smrt-chat/svelte';
import type {
  ContentEditorAssistantContext,
  ContentEditorAssistantFieldUpdateAllowList,
} from '../../content-editor-assistant';
import {
  contentEditorAssistantContextToChatProps,
  sanitizeContentEditorAssistantFieldUpdates,
} from '../../content-editor-assistant';
import { joinApiUrl } from '../api';

const AI_MODELS = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
];
const DEFAULT_MODEL_ID = AI_MODELS[0].id;

export interface Props {
  apiBaseUrl?: string;
  assistantContext?: ContentEditorAssistantContext | null;
  contentId?: string;
  currentEditorState?: string;
  currentReferenceIds?: string[];
  formFields?: Record<string, string>;
  currentProfileId?: string;
  assistantFieldAllowList?: ContentEditorAssistantFieldUpdateAllowList;
  onapplyfields?: (fields: Record<string, string>) => void;
  onclose?: () => void;
}

let {
  apiBaseUrl = '/api/v1',
  assistantContext = null,
  contentId = '',
  currentEditorState = '',
  currentReferenceIds = [],
  formFields = {},
  currentProfileId = '',
  assistantFieldAllowList = {},
  onapplyfields = undefined,
  onclose = undefined,
}: Props = $props();

let session = $state<any>(null);
let threads = $state<any[]>([]);
let activeThreadId = $state<string | null>(null);
let messages = $state<any[]>([]);

let loadingSession = $state(true);
let loadingMessages = $state(false);
let sendingMessage = $state(false);
let error = $state<string | null>(null);

// New Topic State
let isCreatingTopic = $state(false);
let newTopicTitle = $state('');
let showNewTopicInput = $state(false);

// Active model selected
let selectedModelId = $state(DEFAULT_MODEL_ID);
let allowedModelIds = $state<string[]>([]);
let loadedContentId = $state<string | null>(null);
let loadedApiBaseUrl = $state<string | null>(null);
let sessionProfileId = $state('');
const assistantChatProps = $derived(
  assistantContext
    ? contentEditorAssistantContextToChatProps(assistantContext)
    : null,
);
const resolvedContentId = $derived(assistantChatProps?.contentId ?? contentId);
const resolvedCurrentEditorState = $derived(
  assistantChatProps?.currentEditorState ?? currentEditorState,
);
const resolvedCurrentReferenceIds = $derived(
  assistantChatProps?.currentReferenceIds ?? currentReferenceIds,
);
const resolvedFormFields = $derived(
  assistantChatProps?.formFields ?? formFields,
);
const resolvedCurrentProfileId = $derived(currentProfileId || sessionProfileId);
const availableAIModels = $derived(
  allowedModelIds.length > 0
    ? [
        ...AI_MODELS.filter((model) => allowedModelIds.includes(model.id)),
        ...allowedModelIds
          .filter((id) => !AI_MODELS.some((model) => model.id === id))
          .map((id) => ({ id, label: id })),
      ]
    : AI_MODELS,
);
const canRetrySessionLoad = $derived(
  Boolean(resolvedContentId && resolvedContentId !== 'new'),
);

$effect(() => {
  if (!resolvedContentId) {
    return;
  }

  if (resolvedContentId === 'new') {
    loadedContentId = resolvedContentId;
    loadedApiBaseUrl = apiBaseUrl;
    session = null;
    threads = [];
    activeThreadId = null;
    messages = [];
    loadingSession = false;
    allowedModelIds = [];
    error = 'Save this draft first to start editorial chat.';
    return;
  }

  if (
    resolvedContentId === loadedContentId &&
    apiBaseUrl === loadedApiBaseUrl
  ) {
    return;
  }

  loadedContentId = resolvedContentId;
  loadedApiBaseUrl = apiBaseUrl;
  selectedModelId = DEFAULT_MODEL_ID;
  session = null;
  threads = [];
  activeThreadId = null;
  messages = [];
  sessionProfileId = '';
  allowedModelIds = [];
  error = null;
  void loadSession();
});

/** Ensure every message has the UI fields that AgentChat.svelte requires */
function normalizeMessage(msg: any): any {
  return {
    ...msg,
    senderName:
      msg.senderName || (msg.role === 'user' ? 'You' : 'AI Assistant'),
    senderAvatarUrl: msg.senderAvatarUrl || '',
    reactions: msg.reactions || [],
    attachments: msg.attachments
      ? typeof msg.attachments === 'string'
        ? []
        : msg.attachments
      : [],
    createdAt: msg.createdAt || msg.created_at || new Date().toISOString(),
  };
}

function parseSessionContext(sessionValue: any): Record<string, unknown> {
  const rawContext = sessionValue?.sessionContext;
  if (!rawContext) {
    return {};
  }

  if (typeof rawContext === 'object' && !Array.isArray(rawContext)) {
    return rawContext as Record<string, unknown>;
  }

  if (typeof rawContext !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(rawContext);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizeAllowedModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const id = item.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push(id);
  }
  return models;
}

function applySessionModelPreference(sessionValue: any): void {
  const ctx = parseSessionContext(sessionValue);
  const sessionAllowedModels = normalizeAllowedModels(ctx.allowedModels);
  allowedModelIds = sessionAllowedModels;

  const sessionModel =
    typeof ctx.model === 'string' && ctx.model.trim() ? ctx.model.trim() : '';
  if (
    sessionModel &&
    (sessionAllowedModels.length === 0 ||
      sessionAllowedModels.includes(sessionModel))
  ) {
    selectedModelId = sessionModel;
    return;
  }

  if (
    sessionAllowedModels.length > 0 &&
    !sessionAllowedModels.includes(selectedModelId)
  ) {
    selectedModelId = sessionAllowedModels[0];
  }
}

async function loadSession() {
  loadingSession = true;
  error = null;
  try {
    const res = await fetch(
      joinApiUrl(apiBaseUrl, `/contents/${resolvedContentId}/chat`),
    );
    if (!res.ok) throw new Error('Failed to load chat session.');
    const data = await res.json();

    if (!data.session) {
      // Chat tables not yet provisioned — show a friendly message
      error = data.notice || 'Chat is not yet available for this content.';
      return;
    }

    if (typeof data.session.allowedTools === 'string') {
      try {
        data.session.allowedTools = JSON.parse(data.session.allowedTools);
      } catch (e) {
        data.session.allowedTools = [];
      }
    }
    data.session.allowedTools = data.session.allowedTools || [];
    data.session.agentName = data.session.agentName || 'AI Assistant';

    session = data.session;
    sessionProfileId = data.session?.participantProfileId || '';
    applySessionModelPreference(session);
    threads = data.threads || [];

    // Select latest thread if exists
    if (threads.length > 0) {
      await loadThread(threads[0].id);
    } else {
      newTopicTitle = 'General';
      await createNewTopic();
    }
  } catch (err: any) {
    error = err.message;
  } finally {
    loadingSession = false;
  }
}

async function loadThread(threadId: string) {
  if (!threadId) {
    console.warn('[loadThread] Aborted: threadId is empty');
    return;
  }

  loadingMessages = true;
  activeThreadId = threadId;
  isCreatingTopic = false;
  messages = [];
  error = null;

  try {
    const res = await fetch(
      joinApiUrl(
        apiBaseUrl,
        `/contents/${resolvedContentId}/chat/threads/${threadId}`,
      ),
    );

    if (!res.ok)
      throw new Error(`Failed to load thread messages. Status: ${res.status}`);

    const data = await res.json();

    messages = (data.messages || []).map(normalizeMessage);

    // Check if there is a saved model preference on the session context
    applySessionModelPreference(session);
  } catch (err: any) {
    console.error(`[loadThread] Failed for thread ${threadId}:`, err);
    error = err.message;
  } finally {
    loadingMessages = false;
  }
}

async function createNewTopic() {
  if (!session) return;
  const title = newTopicTitle.trim() || `Topic ${threads.length + 1}`;

  isCreatingTopic = true;
  try {
    const res = await fetch(
      joinApiUrl(apiBaseUrl, `/contents/${resolvedContentId}/chat`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          sessionId: session.id,
          model: selectedModelId,
          referenceIds: resolvedCurrentReferenceIds,
        }),
      },
    );

    if (!res.ok) throw new Error('Failed to create topic.');
    const data = await res.json();

    threads = [data.thread, ...threads];
    newTopicTitle = '';
    await loadThread(data.thread.id);
  } catch (err: any) {
    error = err.message;
  } finally {
    isCreatingTopic = false;
  }
}

async function handleSendMessage(content: string) {
  if (!session || !activeThreadId) return;

  const tempId = `temp-${Date.now()}`;
  messages = [
    ...messages,
    {
      id: tempId,
      content,
      role: 'user',
      messageType: 'text',
      createdAt: new Date(),
    },
  ];

  sendingMessage = true;
  try {
    const res = await fetch(
      joinApiUrl(
        apiBaseUrl,
        `/contents/${resolvedContentId}/chat/threads/${activeThreadId}`,
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          sessionId: session.id,
          model: selectedModelId,
          currentEditorState: resolvedCurrentEditorState,
          referenceIds: resolvedCurrentReferenceIds,
          formFields: resolvedFormFields,
        }),
      },
    );

    if (!res.ok) throw new Error('Failed to send message.');
    const data = await res.json();

    messages = messages.filter((m) => m.id !== tempId);
    messages = [
      ...messages,
      normalizeMessage(data.userMessage),
      normalizeMessage(data.agentMessage),
    ];

    // Auto-apply: extract JSON field update blocks from the AI response
    if (onapplyfields && data.agentMessage?.content) {
      const jsonBlockRegex = /```\s*json\s*\r?\n([\s\S]*?)```/gi;
      let match: RegExpExecArray | null = jsonBlockRegex.exec(
        data.agentMessage.content,
      );
      while (match !== null) {
        try {
          const parsed = JSON.parse(match[1].trim());
          const fields = sanitizeContentEditorAssistantFieldUpdates(
            parsed.fields,
            assistantFieldAllowList,
          );
          if (Object.keys(fields).length > 0) {
            onapplyfields(fields);
          }
        } catch (e) {
          console.warn('Failed to parse AI field update JSON:', e);
        }
        match = jsonBlockRegex.exec(data.agentMessage.content);
      }
    }
  } catch (err: any) {
    console.error(err);
    messages = messages.filter((m) => m.id !== tempId);
    error = 'Failed to send message.';
  } finally {
    sendingMessage = false;
  }
}
</script>

<div class="content-agent-chat-container">
  {#if loadingSession && !threads.length}
    <div class="loading-state">Loading AI Assistant...</div>
  {:else if error && !session}
    <div class="error-state">
      <p>{error}</p>
      {#if canRetrySessionLoad}
        <button onclick={loadSession}>Retry</button>
      {/if}
    </div>
  {:else if session}
    <div class="model-bar">
      <select class="smrt-select model-select" bind:value={selectedModelId}>
        {#each availableAIModels as model}
          <option value={model.id}>{model.label}</option>
        {/each}
      </select>
    </div>
    
    <div class="chat-main">
      <div class="agent-chat-host">
        {#if loadingMessages || isCreatingTopic}
           <div class="loading-state">
             <span class="spinner"></span> Loading topic...
           </div>
        {:else}
          {#if !resolvedCurrentProfileId}
            <div class="loading-state">Loading participant...</div>
          {:else}
          <AgentChat 
            session={session} 
            messages={messages} 
            currentProfileId={resolvedCurrentProfileId}
            loading={sendingMessage}
            onsend={handleSendMessage}
            onclose={onclose}
          />
          {/if}
        {/if}
      </div>
    </div>

    <div class="topic-footer">
      {#if showNewTopicInput}
        <div class="new-topic-row">
          <input 
            class="new-topic-input" 
            type="text" 
            placeholder="Topic name..." 
            bind:value={newTopicTitle}
            onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { createNewTopic(); showNewTopicInput = false; } }}
          />
          <button class="topic-action-btn" onclick={() => { createNewTopic(); showNewTopicInput = false; }} disabled={isCreatingTopic}>
            {isCreatingTopic ? '...' : 'Create'}
          </button>
          <button class="topic-action-btn topic-cancel-btn" onclick={() => { showNewTopicInput = false; }}>✕</button>
        </div>
      {:else}
        <select 
          class="smrt-select topic-select" 
          bind:value={activeThreadId} 
          onchange={(e: Event) => loadThread((e.currentTarget as HTMLSelectElement).value)}
          disabled={!threads.length}
        >
          {#if !threads.length}
            <option value="" disabled>No topics...</option>
          {/if}
          {#each threads as thread}
            <option value={thread.id}>{thread.title || 'Untitled Topic'}</option>
          {/each}
        </select>
        <button class="topic-action-btn" onclick={() => { showNewTopicInput = true; newTopicTitle = ''; }} title="New Topic">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          New
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .content-agent-chat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--smrt-color-surface, #fefbff);
    overflow: hidden;
  }

  .loading-state, .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 2rem;
    text-align: center;
    color: var(--smrt-color-outline, #74777f);
  }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-top-color: var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-full, 9999px);
    animation: spin 1s linear infinite;
    margin-right: var(--smrt-spacing-2, 8px);
    vertical-align: middle;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error-state button {
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    border: none;
    border-radius: var(--smrt-radius-sm, 4px);
    cursor: pointer;
  }

  .model-bar {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    background: var(--smrt-color-surface-container-lowest, #ffffff);
  }

  .smrt-select {
    width: 100%;
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-md, 8px);
    border: none;
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font-size: 0.8125rem;
    outline: none;
    cursor: pointer;
  }
  
  .smrt-select:disabled {
    background: var(--smrt-color-surface-container, #f3f4f9);
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: not-allowed;
    opacity: 0.7;
  }

  .smrt-select:focus {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .chat-main {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .agent-chat-host {
    flex: 1;
    overflow: hidden;
    position: relative;
  }
  
  .agent-chat-host > :global(*) {
    height: 100%;
  }

  .topic-footer {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    background: var(--smrt-color-surface-container-lowest, #ffffff);
  }

  .topic-footer .smrt-select {
    flex: 1;
  }

  .topic-action-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-sm, 4px);
    background: none;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 0.75rem;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  }

  .topic-action-btn:hover:not(:disabled) {
    background: var(--smrt-color-surface-variant, #e1e2e8);
    color: var(--smrt-color-primary, #005ac1);
  }

  .topic-cancel-btn {
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border: none;
    color: var(--smrt-color-outline, #74777f);
  }

  .new-topic-row {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    width: 100%;
  }

  .new-topic-input {
    flex: 1;
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 0.8125rem;
    outline: none;
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .new-topic-input:focus {
    border-color: var(--smrt-color-primary, #005ac1);
  }
</style>
