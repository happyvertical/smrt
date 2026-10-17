<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import { IntakeInbox, IntakeReview } from '../../src/svelte/index.js';
import { host, login, session } from './client.js';

let authenticated = $state(false);
let intakeContext = $state(0);
let itemId = $state(new URLSearchParams(location.search).get('itemId') ?? '');
onMount(() => {
  session()
    .then(() => (authenticated = true))
    .catch(() => {});
});
async function signIn() {
  await login();
  authenticated = true;
}
function select(id: string) {
  itemId = id;
  history.replaceState({}, '', `?itemId=${encodeURIComponent(id)}`);
}
</script>
<main data-theme="material" data-color-scheme="light">
{#if authenticated}
  <Button onclick={() => { intakeContext++; }}>Switch intake context</Button>
  <IntakeInbox {host} contextKey={String(intakeContext)} onselect={select}/>
  {#if itemId}<IntakeReview {host} {itemId}/>{/if}
{:else}<Button onclick={signIn}>Sign in to review fixture</Button>{/if}
</main>
<style>main{max-width:72rem;margin:auto;padding:1rem;min-width:0;}</style>
