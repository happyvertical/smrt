<script lang="ts">
import { useAuth, useSocket } from '@happyvertical/smrt-svelte';

const auth = useAuth();
const socket = useSocket();

let messages: string[] = $state([]);

function sendPing() {
  socket.send({ type: 'ping', timestamp: Date.now() });
  messages = [...messages, `→ Sent ping at ${new Date().toLocaleTimeString()}`];
}

function clearMessages() {
  messages = [];
}
</script>

<h1>Auth & Socket Demo</h1>

<div class="demo-section">
  <h2>Authentication State</h2>
  <div class="info-grid">
    <div class="info-item">
      <span class="label">Authenticated:</span>
      <span class="value" class:positive={auth.isAuthenticated} class:negative={!auth.isAuthenticated}>
        {auth.isAuthenticated ? 'Yes' : 'No'}
      </span>
    </div>
    <div class="info-item">
      <span class="label">User:</span>
      <span class="value">
        {#if auth.user}
          {auth.user.email}
        {:else}
          <em>Not logged in</em>
        {/if}
      </span>
    </div>
    <div class="info-item">
      <span class="label">Permissions:</span>
      <span class="value">
        {#if auth.permissions.length > 0}
          {auth.permissions.join(', ')}
        {:else}
          <em>None</em>
        {/if}
      </span>
    </div>
  </div>

  <h3>Permission Checks</h3>
  <div class="permission-checks">
    <div class="check">
      <code>articles.create</code>:
      <span class:positive={auth.hasPermission('articles.create')} class:negative={!auth.hasPermission('articles.create')}>
        {auth.hasPermission('articles.create') ? '✓' : '✗'}
      </span>
    </div>
    <div class="check">
      <code>articles.delete</code>:
      <span class:positive={auth.hasPermission('articles.delete')} class:negative={!auth.hasPermission('articles.delete')}>
        {auth.hasPermission('articles.delete') ? '✓' : '✗'}
      </span>
    </div>
    <div class="check">
      <code>users.manage</code>:
      <span class:positive={auth.hasPermission('users.manage')} class:negative={!auth.hasPermission('users.manage')}>
        {auth.hasPermission('users.manage') ? '✓' : '✗'}
      </span>
    </div>
  </div>
</div>

<div class="demo-section">
  <h2>WebSocket State</h2>
  <div class="info-grid">
    <div class="info-item">
      <span class="label">Status:</span>
      <span class="value status-{socket.status}">
        {socket.status}
      </span>
    </div>
    <div class="info-item">
      <span class="label">Connected:</span>
      <span class="value" class:positive={socket.isConnected} class:negative={!socket.isConnected}>
        {socket.isConnected ? 'Yes' : 'No'}
      </span>
    </div>
    <div class="info-item">
      <span class="label">Reconnect Attempts:</span>
      <span class="value">{socket.reconnectAttempts}</span>
    </div>
  </div>

  <div class="socket-actions">
    <button onclick={sendPing} disabled={!socket.isConnected}>
      Send Ping
    </button>
    <button onclick={() => socket.reconnect()}>
      Reconnect
    </button>
    <button onclick={() => socket.disconnect()}>
      Disconnect
    </button>
    <button onclick={clearMessages}>
      Clear Messages
    </button>
  </div>

  <div class="message-log">
    <h3>Messages</h3>
    {#if messages.length === 0}
      <p class="empty">No messages yet</p>
    {:else}
      {#each messages as message}
        <div class="message">{message}</div>
      {/each}
    {/if}
  </div>
</div>

<div class="demo-section">
  <h2>Usage</h2>
  <p>
    To test auth and socket features, update the <code>+layout.svelte</code> to pass:
  </p>
  <pre><code>{`<smrt
  user={data.user}
  permissions={data.permissions}
  socket={{
    url: 'wss://your-server.com/ws',
    onMessage: (msg) => console.log('Received:', msg)
  }}
>
  ...
</smrt>`}</code></pre>
</div>

<style>
  h1 {
    margin-bottom: 24px;
  }

  h2 {
    font-size: 1.25rem;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding-bottom: 8px;
  }

  h3 {
    font-size: 1rem;
    margin: 16px 0 12px;
    color: var(--smrt-color-on-surface-variant);
  }

  .demo-section {
    background: var(--smrt-color-surface-container);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 24px;
  }

  .info-grid {
    display: grid;
    gap: 12px;
  }

  .info-item {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .label {
    font-weight: 500;
    color: var(--smrt-color-on-surface);
    min-width: 140px;
  }

  .value {
    color: var(--smrt-color-on-surface-variant);
  }

  .positive {
    color: var(--smrt-color-success);
    font-weight: 500;
  }

  .negative {
    color: var(--smrt-color-error);
    font-weight: 500;
  }

  .status-connected {
    color: var(--smrt-color-success);
    font-weight: 500;
  }

  .status-connecting, .status-reconnecting {
    color: var(--smrt-color-warning);
    font-weight: 500;
  }

  .status-disconnected {
    color: var(--smrt-color-on-surface-variant);
    font-weight: 500;
  }

  .permission-checks {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }

  .check {
    background: var(--smrt-color-surface);
    padding: 8px 16px;
    border-radius: 4px;
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .check code {
    font-family: monospace;
    font-size: 0.875rem;
  }

  .socket-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }

  button {
    padding: 8px 16px;
    border-radius: 6px;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.15s;
  }

  button:hover:not(:disabled) {
    background: var(--smrt-color-surface-container);
    border-color: var(--smrt-color-on-surface-variant);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .message-log {
    margin-top: 20px;
    background: var(--smrt-color-surface-container);
    border-radius: 6px;
    padding: 16px;
    color: var(--smrt-color-on-surface-variant);
    font-family: monospace;
    font-size: 0.875rem;
    max-height: 200px;
    overflow-y: auto;
  }

  .message-log h3 {
    color: var(--smrt-color-on-surface-variant);
    margin: 0 0 12px;
  }

  .message {
    padding: 4px 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .message:last-child {
    border-bottom: none;
  }

  .empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }

  pre {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 0.875rem;
  }

  code {
    font-family: monospace;
  }

  p code {
    background: var(--smrt-color-surface-container-high);
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--smrt-color-on-surface);
  }
</style>
