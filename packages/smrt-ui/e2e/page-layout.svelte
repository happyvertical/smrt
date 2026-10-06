<script lang="ts">
import PageLayout from '../src/components/layout/PageLayout.svelte';
import PageHeader from '../src/components/layout/PageHeader.svelte';
import Card from '../src/components/ui/Card.svelte';
import DataTable from '../src/components/data/DataTable.svelte';
import Tabs from '../src/components/nav/Tabs.svelte';
import '../src/themes/styles/smrt.css';

const columns = Array.from({ length: 7 }, (_, index) => ({
  id: `column${index}`, label: `Column ${index}`, minWidth: '12rem',
}));
const data = [Object.fromEntries(columns.map((column) => [column.id, column.label]))];
const tabs = Array.from({ length: 12 }, (_, index) => ({
  id: `section${index}`, label: `Project section ${index}`, href: `#section${index}`,
}));
</script>

<div data-theme="smrt" data-color-scheme="light">
  <PageLayout maxWidth="xl">
    <section aria-label="Project workspace">
      <PageHeader title="Construction project" />
      <Tabs {tabs} active="section0" aria-label="Project sections" />
      <Card padding="none"><DataTable {columns} {data} caption="Project records" /></Card>
    </section>
  </PageLayout>
</div>
