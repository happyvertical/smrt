<script lang="ts">
import ExpenseForm from '../src/svelte/components/ExpenseForm.svelte';
import { values } from './fixture.js';
</script>
<div data-theme="material" data-color-scheme="light">
  <ExpenseForm action="/save" {values} costObject={{ type: "@example/jobs:Job", id: "job-a" }} correcting hiddenFields={[{ name: 'requestId', value: 'same-request' }, { name: 'tenantId', value: 'same-tenant' }, { name: 'predecessorId', value: 'same-predecessor' }]} />
</div>
