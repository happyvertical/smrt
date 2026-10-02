<script lang="ts">
import ThemeProvider from '../../../themes/ThemeProvider.svelte';
import DataTable from '../DataTable.svelte';

let { mode = 'hide-columns' }: { mode?: 'scroll' | 'hide-columns' } = $props();
const columns = Array.from({ length: 7 }, (_, index) => ({
  id: `c${index}`,
  label: `Column ${index}`,
  sortable: true,
  width: '200px',
  minWidth: '180px',
  responsive: { priority: index, keepVisible: index === 0 },
  headerPath: [{ id: 'group', label: 'Group' }],
}));
const data = [
  {
    id: 'one',
    ...Object.fromEntries(
      columns.map((column) => [
        column.id,
        `${column.label}LongUnbrokenTextThatMustWrap`,
      ]),
    ),
  },
];
</script>
<ThemeProvider density="touch" persist={false} inlineVariables>
  <DataTable {columns} {data} responsiveMode={mode} rowKey="id" sortable caption="Responsive table" />
</ThemeProvider>
