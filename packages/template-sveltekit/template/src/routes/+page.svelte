<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  let creating = $state(false);
</script>

<svelte:head>
  <title>s-m-r-t SvelteKit starter</title>
</svelte:head>

<div class="page">
  <header>
    <p class="eyebrow">s-m-r-t 0.38.25</p>
    <h1>Learn the application foundation</h1>
    <p>
      One object, SQLite defaults, server-loaded data, generated interfaces,
      session-authorized tenancy, and room to grow.
    </p>
  </header>

  <section>
    <div class="section-heading">
      <div>
        <h2>Items</h2>
        <p>The initial list comes from <code>+page.server.ts</code>.</p>
      </div>
    </div>

    {#if data.loadError}
      <p class="notice notice--error">{data.loadError}</p>
      <p>Run <code>pnpm db:migrate</code> after changing object fields.</p>
    {:else if data.accessMessage}
      <p class="notice">{data.accessMessage}</p>
    {:else if data.items.length === 0}
      <p class="notice">No items yet.</p>
    {:else}
      <ul class="items">
        {#each data.items as item (item.id)}
          <li>
            <strong>{item.title}</strong>
            <span>{item.status}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if data.canCreate}
      <form
        method="POST"
        action="?/create"
        use:enhance={() => {
          creating = true;
          return async ({ result, update }) => {
            try {
              await update({ invalidateAll: false });
              if (result.type === 'success') {
                await invalidate('smrt:items');
              }
            } finally {
              creating = false;
            }
          };
        }}
      >
        <label for="title">New item</label>
        <div class="form-row">
          <input id="title" name="title" placeholder="Write a title" required />
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create item'}
          </button>
        </div>
      </form>
    {/if}

    {#if form?.error}
      <p class="notice notice--error">{form.error}</p>
    {/if}
  </section>

  <section>
    <h2>Where to extend</h2>
    <ol>
      <li>Edit <code>src/lib/objects/Item.ts</code>.</li>
      <li>Run <code>pnpm db:migrate</code>.</li>
      <li>Add pages that query collections in <code>+page.server.ts</code>.</li>
      <li>Add membership-gated login and tenant-switch actions for your app.</li>
    </ol>
  </section>
</div>

<style>
  .page {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 56rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-8);
  }

  header,
  section,
  .section-heading,
  form {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  header p,
  h1,
  h2,
  section p {
    margin: 0;
  }

  .eyebrow {
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-large);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  section {
    padding: var(--smrt-spacing-6);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
    background: var(--smrt-color-surface);
  }

  .notice {
    padding: var(--smrt-spacing-3);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
  }

  .notice--error {
    color: var(--smrt-color-error);
  }

  .items {
    display: grid;
    gap: var(--smrt-spacing-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .items li {
    display: flex;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    padding-block: var(--smrt-spacing-2);
    border-block-end: 1px solid var(--smrt-color-outline-variant);
  }

  .items span {
    color: var(--smrt-color-on-surface-variant);
  }

  label {
    font-weight: var(--smrt-typography-weight-semibold);
  }

  .form-row {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  input,
  button {
    min-height: 2.75rem;
    padding-inline: var(--smrt-spacing-3);
    border-radius: var(--smrt-radius-medium);
    font: inherit;
  }

  input {
    flex: 1;
    border: 1px solid var(--smrt-color-outline);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  button {
    border: 0;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  code {
    font-family: var(--smrt-typography-code-font-family, monospace);
  }

  @media (max-width: 42rem) {
    .page {
      padding: var(--smrt-spacing-4);
    }

    .form-row {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
