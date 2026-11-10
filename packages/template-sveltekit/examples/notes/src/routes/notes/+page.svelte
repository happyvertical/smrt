<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { Form, FormGroup, Input, Textarea } from '@happyvertical/smrt-ui/forms';
  import { EmptyState } from '@happyvertical/smrt-ui/layout';
  import { Button, Card } from '@happyvertical/smrt-ui/ui';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { fromAction } from 'svelte/attachments';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
  let creating = $state(false);
  let title = $state('');
  let body = $state('');
  let composing = $state(false);

  // The form shows once the owner has notes, or after "Start your first note".
  const showForm = $derived(
    data.canCreate && (data.notes.length > 0 || composing),
  );

  // Match `enhance`'s generics: a SubmitFunction with SvelteKit's default
  // `Record<string, any>` params is not assignable to the action's argument.
  const submit: SubmitFunction<
    Record<string, unknown> | undefined,
    Record<string, unknown> | undefined
  > = () => {
    creating = true;
    return async ({ result, update }) => {
      try {
        await update({ invalidateAll: false, reset: false });
        if (result.type === 'success') {
          title = '';
          body = '';
          await invalidate('smrt:notes');
        }
      } finally {
        creating = false;
      }
    };
  };
</script>

<svelte:head>
  <title>Notes</title>
</svelte:head>

<main class="page">
  <h1>Notes</h1>

  {#if data.loadError}
    <Card>
      <p role="alert">{data.loadError}</p>
      <p>Run <code>pnpm db:migrate</code> after changing object fields.</p>
    </Card>
  {:else if data.accessMessage}
    <Card>
      <p>{data.accessMessage}</p>
      {#if !data.authenticated}
        <Button href="/setup">Set up this app</Button>
      {/if}
    </Card>
  {:else}
    {#if showForm}
      <Card>
        <Form
          method="POST"
          action="?/create"
          preventDefault={false}
          {@attach fromAction(enhance, () => submit)}
        >
          <FormGroup label="Title" required>
            <Input name="title" bind:value={title} required />
          </FormGroup>
          <FormGroup label="Body">
            <Textarea name="body" bind:value={body} rows={4} />
          </FormGroup>
          {#if form?.error}<p role="alert">{form.error}</p>{/if}
          <div>
            <Button type="submit" loading={creating} disabled={creating}>
              Add note
            </Button>
          </div>
        </Form>
      </Card>
    {/if}

    {#if data.notes.length === 0}
      <EmptyState
        title="Start your first note"
        description={data.canCreate
          ? 'Notes you add show up here for everyone in this workspace.'
          : 'Notes will show up here once someone adds them.'}
        actionLabel={data.canCreate && !composing ? 'New note' : undefined}
        onaction={() => {
          composing = true;
        }}
      />
    {:else}
      <ul class="notes">
        {#each data.notes as note (note.id)}
          <li>
            <Card>
              <h2>{note.title}</h2>
              {#if note.body}<p>{note.body}</p>{/if}
            </Card>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</main>

<style>
  @layer smrt.theme {
    .page {
      display: grid;
      gap: var(--smrt-spacing-6);
      width: min(100%, 48rem);
      margin-inline: auto;
      padding: var(--smrt-spacing-6) var(--smrt-spacing-4);
    }

    .notes {
      display: grid;
      gap: var(--smrt-spacing-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    h2 {
      font: var(--smrt-typography-title-medium);
    }
  }
</style>
