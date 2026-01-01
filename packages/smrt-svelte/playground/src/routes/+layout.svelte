<script lang="ts">
import type { AppMode } from '@happyvertical/smrt-svelte';
import { SmrtProvider } from '@happyvertical/smrt-svelte';
import type { Snippet } from 'svelte';

interface Props {
  children: Snippet;
}

const { children }: Props = $props();
let mode: AppMode = $state('dumb');
</script>

<SmrtProvider {mode} onModeChange={(m) => mode = m}>
  <div class="layout">
    <nav class="sidebar">
      <h1>SMRT Svelte</h1>

      <div class="mode-toggle">
        <button
          class="mode-btn"
          class:active={mode === 'dumb'}
          onclick={() => mode = 'dumb'}
        >Dumb</button>
        <button
          class="mode-btn"
          class:active={mode === 'smrt'}
          onclick={() => mode = 'smrt'}
        >Smrt</button>
      </div>

      <ul>
        <li><a href="/">Overview</a></li>

        <li class="section">AI Features</li>
        <li><a href="/ai">AI Overview</a></li>
        <li><a href="/ai/stt">Speech-to-Text</a></li>
        <li><a href="/ai/tts">Text-to-Speech</a></li>
        <li><a href="/ai/llm">LLM Chat</a></li>
        <li><a href="/ai/pipeline">Voice → LLM</a></li>

        <li class="section">Forms</li>
        <li><a href="/forms">SMRT Forms</a></li>

        <li class="section">Users</li>
        <li><a href="/users/avatar">UserAvatar</a></li>
        <li><a href="/users/card">UserCard</a></li>
        <li><a href="/users/list">UserList</a></li>
        <li><a href="/users/form">UserForm</a></li>
        <li><a href="/users/invite">InviteUserModal</a></li>
        <li class="section">Roles</li>
        <li><a href="/roles/badge">RoleBadge</a></li>
        <li><a href="/roles/selector">RoleSelector</a></li>
        <li class="section">Tenants</li>
        <li><a href="/tenants/card">TenantCard</a></li>
        <li><a href="/tenants/switcher">TenantSwitcher</a></li>
        <li class="section">Auth</li>
        <li><a href="/auth/user-menu">UserMenu</a></li>
        <li class="section">Memberships</li>
        <li><a href="/memberships/card">MembershipCard</a></li>
        <li><a href="/memberships/list">MembershipList</a></li>
        <li class="section">Permissions</li>
        <li><a href="/permissions/check">PermissionCheck</a></li>
      </ul>
    </nav>
    <main class="content">
      {@render children()}
    </main>
  </div>
</SmrtProvider>

<style>
  .layout {
    display: flex;
    min-height: 100vh;
  }

  .sidebar {
    width: 220px;
    background: #1a1a2e;
    color: #fff;
    padding: 20px;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    overflow-y: auto;
  }

  .sidebar h1 {
    font-size: 1.25rem;
    margin-bottom: 24px;
    color: #60a5fa;
  }

  .sidebar ul {
    list-style: none;
  }

  .sidebar li {
    margin: 4px 0;
  }

  .sidebar li.section {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #888;
    margin-top: 16px;
    margin-bottom: 8px;
    letter-spacing: 0.05em;
  }

  .sidebar a {
    color: #ccc;
    text-decoration: none;
    display: block;
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .sidebar a:hover {
    background: #2a2a4e;
    color: #fff;
  }

  .content {
    flex: 1;
    margin-left: 220px;
    padding: 32px;
  }

  .mode-toggle {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    background: #0f0f1a;
    padding: 4px;
    border-radius: 8px;
  }

  .mode-btn {
    flex: 1;
    padding: 8px 12px;
    border: none;
    background: transparent;
    color: #888;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .mode-btn:hover {
    color: #fff;
  }

  .mode-btn.active {
    background: #3b82f6;
    color: #fff;
  }
</style>
