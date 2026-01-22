<script lang="ts">
import type { AppMode, User } from '@happyvertical/smrt-svelte';
import { smrt, ThemeProvider } from '@happyvertical/smrt-svelte';
import type { Snippet } from 'svelte';

interface Props {
  children: Snippet;
}

const { children }: Props = $props();
let mode: AppMode = $state('dumb');

// Theme State
let themeMode = $state<'light' | 'dark' | 'system'>('system');
let themeSeed = $state('#6750A4');

// Mock user for demo purposes
// In a real app, this would come from your +layout.server.ts load function
let mockUser: User | null = $state({
  id: 'user-123',
  profileId: 'profile-456',
  email: 'demo@example.com',
  status: 'active' as const,
  lastLoginAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
} as User);

let mockPermissions = $state([
  'articles.create',
  'articles.read',
  'users.view',
]);
let isLoggedIn = $state(true);

function toggleLogin() {
  isLoggedIn = !isLoggedIn;
}
</script>

<smrt
  {mode}
  user={isLoggedIn ? mockUser : null}
  permissions={isLoggedIn ? mockPermissions : []}
  onModeChange={(m) => mode = m}
>
  <ThemeProvider mode={themeMode} seed={themeSeed}>
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

        <div class="theme-controls">
          <div class="row">
            <label for="theme-mode-select">Mode</label>
            <select id="theme-mode-select" bind:value={themeMode}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div class="row">
            <label for="theme-seed-input">Seed</label>
            <input id="theme-seed-input" type="color" bind:value={themeSeed} />
          </div>
        </div>

        <div class="auth-toggle">
          <button
            class="auth-btn"
            class:logged-in={isLoggedIn}
            onclick={toggleLogin}
          >
            {isLoggedIn ? 'Logged In' : 'Logged Out'}
          </button>
        </div>

        <ul>
        <li><a href="/">Overview</a></li>
        <li><a href="/foundation">Foundation</a></li>

        <li class="section">AI Features</li>
        <li><a href="/ai">AI Overview</a></li>
        <li><a href="/ai/stt">Speech-to-Text</a></li>
        <li><a href="/ai/tts">Text-to-Speech</a></li>
        <li><a href="/ai/llm">LLM Chat</a></li>
        <li><a href="/ai/pipeline">Voice → LLM</a></li>

        <li class="section">Forms</li>
        <li><a href="/forms">SMRT Forms</a></li>
        <li><a href="/forms/advanced">Advanced Inputs</a></li>
        <li><a href="/forms/construction">Construction</a></li>

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
        <li class="section">State</li>
        <li><a href="/auth-socket">Auth & Socket</a></li>
        <li class="section">Display</li>
        <li><a href="/display">Display Components</a></li>
        <li class="section">Layout</li>
        <li><a href="/layout">Layout Components</a></li>
        <li class="section">Navigation</li>
        <li><a href="/navigation">Navigation Components</a></li>
        <li class="section">Feedback</li>
        <li><a href="/feedback">Feedback Components</a></li>
        <li class="section">Commerce</li>
        <li><a href="/commerce">Invoice Components</a></li>
      </ul>
    </nav>
    <main class="content">
      {@render children()}
    </main>
    </div>
  </ThemeProvider>
</smrt>

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

  .auth-toggle {
    margin-bottom: 20px;
  }

  .auth-btn {
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: #dc2626;
    color: #fff;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .auth-btn:hover {
    opacity: 0.9;
  }

  .auth-btn.logged-in {
    background: #059669;
  }

  .theme-controls {
    margin-bottom: 20px;
    background: #0f0f1a;
    padding: 8px;
    border-radius: 8px;
  }

  .theme-controls label {
    display: block;
    font-size: 0.75rem;
    color: #888;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .theme-controls .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .theme-controls select {
    flex: 1;
    background: #1a1a2e;
    color: #fff;
    border: 1px solid #333;
    padding: 4px;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .theme-controls input[type="color"] {
    width: 32px;
    height: 32px;
    border: none;
    padding: 0;
    background: transparent;
    cursor: pointer;
  }
</style>
