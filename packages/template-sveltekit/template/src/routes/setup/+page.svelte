<script lang="ts">
  import { enhance } from '$app/forms';
  import { OwnerSetupForm } from '@happyvertical/smrt-svelte/app';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Set up your local application</title></svelte:head>

<OwnerSetupForm {data} {form} {enhance} />
