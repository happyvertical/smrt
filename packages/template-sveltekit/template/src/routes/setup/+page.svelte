<script lang="ts">
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Set up your local application</title></svelte:head>

<main>
  <h1>Set up your local application</h1>
  {#if !data.available}
    <p>Local owner setup is unavailable or has already been completed.</p>
  {:else}
    <p>Create the real local owner account. This invitation works once and stays on this device.</p>
    {#if form?.message}<p role="alert">{form.message}</p>{/if}
    <form method="POST">
      <input type="hidden" name="token" value={data.token} />
      <label>Name <input name="name" autocomplete="name" required /></label>
      <label>Email <input name="email" type="email" autocomplete="email" required /></label>
      <button type="submit">Create owner</button>
    </form>
  {/if}
</main>

<style>
  main { max-width: 36rem; margin: 4rem auto; padding: 1.5rem; }
  form { display: grid; gap: 1rem; }
  label { display: grid; gap: 0.35rem; }
  input { padding: 0.65rem; }
  button { width: fit-content; padding: 0.65rem 1rem; }
</style>
