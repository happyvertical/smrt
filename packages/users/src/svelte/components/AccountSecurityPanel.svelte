<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  AccountApiKey,
  AccountSession,
  UsersAuthAdapter,
} from '../auth.js';
import { messageFrom } from '../auth.js';
export interface Props {
  /** Authorized server-side revocation callbacks. */
  adapter: UsersAuthAdapter;
  /** Sanitized sessions owned by the current account. */
  sessions?: AccountSession[];
  /** Sanitized API-key metadata owned by the current account. */
  apiKeys?: AccountApiKey[];
}
let { adapter, sessions = [], apiKeys = [] }: Props = $props();
let error = $state('');
let pending = $state<string | null>(null);
async function revoke(kind: 'session' | 'api-key', id: string) {
  error = '';
  pending = `${kind}:${id}`;
  try {
    if (kind === 'session') {
      await adapter.revokeSession?.(id);
    } else {
      await adapter.revokeApiKey?.(id);
    }
  } catch (cause) {
    error = messageFrom(cause, `Unable to revoke ${kind}.`);
  } finally {
    pending = null;
  }
}
</script>
<section class="security" aria-labelledby="account-security-title"><h2 id="account-security-title">Account security</h2>{#if error}<p role="alert">{error}</p>{/if}<h3>Signed-in sessions</h3>{#if sessions.length}<ul>{#each sessions as session (session.id)}<li><div><strong>{session.label}</strong>{#if session.current}<span>Current session</span>{/if}{#if session.lastActiveAt}<small>Last active {session.lastActiveAt}</small>{/if}</div><Button variant="secondary" size="sm" onclick={()=>revoke('session',session.id)} disabled={session.current||!adapter.revokeSession} loading={pending===`session:${session.id}`}>Sign out</Button></li>{/each}</ul>{:else}<p>No active sessions.</p>{/if}<h3>API keys</h3>{#if apiKeys.length}<ul>{#each apiKeys as key (key.id)}<li><div><strong>{key.label}</strong>{#if key.lastUsedAt}<small>Last used {key.lastUsedAt}</small>{/if}</div><Button variant="secondary" size="sm" onclick={()=>revoke('api-key',key.id)} disabled={!adapter.revokeApiKey} loading={pending===`api-key:${key.id}`}>Revoke</Button></li>{/each}</ul>{:else}<p>No API keys.</p>{/if}</section>
<style>.security{display:grid;gap:var(--smrt-spacing-sm,.5rem);color:var(--smrt-color-on-surface)}h2,h3,p{margin:0}h2{font:var(--smrt-typography-title-large-font)}h3{margin-top:var(--smrt-spacing-sm,.5rem);font:var(--smrt-typography-title-small-font)}p[role=alert]{color:var(--smrt-color-error)}ul{list-style:none;padding:0;margin:0;display:grid;gap:var(--smrt-spacing-sm,.5rem)}li{display:flex;justify-content:space-between;align-items:center;gap:var(--smrt-spacing-md,1rem);padding:var(--smrt-spacing-sm,.5rem);background:var(--smrt-color-surface-container-low);border-radius:var(--smrt-radius-sm,.25rem)}li div{display:grid;gap:var(--smrt-spacing-2,.25rem)}small,span{color:var(--smrt-color-on-surface-variant)}span{font:var(--smrt-typography-label-small-font)}</style>
