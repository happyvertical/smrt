<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import {
  IntakeInbox,
  IntakeReview,
  IntakeWorkspace,
} from '../../src/svelte/index.js';
import { host, login, session } from './client.js';

let authenticated = $state(false);
let intakeContext = $state(0);
const params = new URLSearchParams(location.search);
// `?layout=workspace` mounts the single-page triage workspace instead.
const workspace = params.get('layout') === 'workspace';
let itemId = $state(params.get('itemId') ?? '');
onMount(() => {
  session()
    .then(() => (authenticated = true))
    .catch(() => {});
});
async function signIn() {
  await login();
  authenticated = true;
}
function select(id: string | undefined) {
  itemId = id ?? '';
  const next = new URLSearchParams(workspace ? { layout: 'workspace' } : {});
  if (id) next.set('itemId', id);
  history.replaceState({}, '', `?${next}`);
}
</script>
<main data-theme="material" data-color-scheme="light" class:workspace>
{#if authenticated}
  <Button onclick={() => { intakeContext++; }}>Switch intake context</Button>
  {#if workspace}<IntakeWorkspace {host} contextKey={String(intakeContext)} itemId={itemId || undefined} onselect={select} pollMs={250}/>
  {:else}
  <IntakeInbox {host} contextKey={String(intakeContext)} onselect={select}/>
  {#if itemId}<IntakeReview {host} {itemId}/>{/if}
  {/if}
{:else}<Button onclick={signIn}>Sign in to review fixture</Button>{/if}
</main>
<style>main{max-width:72rem;margin:auto;padding:1rem;min-width:0;}main.workspace{max-width:none}</style>
