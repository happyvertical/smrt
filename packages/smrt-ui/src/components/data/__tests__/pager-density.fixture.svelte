<script lang="ts">
import ThemeProvider from '../../../themes/ThemeProvider.svelte';
import Pagination from '../../ui/Pagination.svelte';
import DataTable from '../DataTable.svelte';

let { target = '48px' }: { target?: string } = $props();
const data = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
].map((id) => ({ id, title: id }));
const noop = () => {};
</script>
<!-- Comfortable provider: only the local `density` props may raise the pagers. -->
<ThemeProvider density="comfortable" overrides={{ '--smrt-touch-target-min': target }} persist={false} inlineVariables>
  <div data-pager="table-touch">
    <DataTable {data} columns={[{ id: 'title', label: 'Title' }]} rowKey="id" pageSize={1} density="touch" caption="Touch table" />
  </div>
  <div data-pager="link-touch">
    <Pagination currentPage={4} totalPages={8} baseUrl="/items" density="touch" aria-label="Touch links" />
  </div>
  <div data-pager="comfortable">
    <Pagination currentPage={4} totalPages={8} onPageChange={noop} aria-label="Comfortable pages" />
  </div>
</ThemeProvider>
