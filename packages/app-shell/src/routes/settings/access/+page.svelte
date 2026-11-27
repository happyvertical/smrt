<script lang="ts">
import { untrack } from 'svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
let rows = $state(untrack(() => data.models));
let message = $state('');
let busy = $state(false);

type Action = 'read' | 'create' | 'update';
const columns: { action: Action; label: string }[] = [
  { action: 'read', label: 'See' },
  { action: 'create', label: 'Add' },
  { action: 'update', label: 'Change' },
];

async function put(model: string, action: Action, allowed: boolean) {
  const response = await fetch('/api/shell/access', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, action, allowed }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'The change was not saved.');
  rows = body.models;
}

async function toggle(model: string, action: Action, allowed: boolean) {
  busy = true;
  message = '';
  try {
    const row = rows.find((r) => r.model === model);
    // Adding or changing returns the record, so seeing it comes first.
    if (allowed && action !== 'read' && row && !row.read)
      await put(model, 'read', true);
    await put(model, action, allowed);
    message = 'Saved.';
  } catch (e) {
    message = e instanceof Error ? e.message : 'The change was not saved.';
  } finally {
    busy = false;
  }
}
</script>
<svelte:head><title>Staff access</title></svelte:head>
<div class="smrt-app-shell__page" data-smrt-component="AppShellAccessSettings">
  <header class="smrt-app-shell__head" data-smrt-part="header">
    <div>
      <h1>Staff access</h1>
      <p class="smrt-app-shell__sub">Choose what the people you have added may do with each kind of record. Everything starts closed. Deleting always waits for you.</p>
    </div>
  </header>
  {#if rows.length === 0}
    <p class="smrt-app-shell__muted">Your app has nothing to share yet.</p>
  {:else}
    <div class="smrt-app-shell__card" data-smrt-part="panel">
      <table class="smrt-app-shell__table">
        <thead>
          <tr>
            <th scope="col">Records</th>
            {#each columns as col (col.action)}<th scope="col">{col.label}</th>{/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.model)}
            <tr>
              <th scope="row">{row.label}</th>
              {#if row.grantable}
                {#each columns as col (col.action)}
                  <td>
                    <input
                      type="checkbox"
                      aria-label="{col.label} {row.label.toLowerCase()}"
                      checked={row[col.action]}
                      disabled={busy}
                      onchange={(e) => toggle(row.model, col.action, e.currentTarget.checked)}
                    />
                  </td>
                {/each}
              {:else}
                <td colspan="3" class="smrt-app-shell__muted">Shares its table with another kind of record, so it cannot be shared.</td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <p role="status" aria-live="polite">{message}</p>
</div>
