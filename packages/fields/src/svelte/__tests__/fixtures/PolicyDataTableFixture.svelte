<script lang="ts">
import { DataTable, type DataTableColumn } from '@happyvertical/smrt-ui/data';
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import { policyToVisibleColumnIds } from '../../data-table.js';

interface Row {
  name: string;
  published: boolean;
  metadata: string;
  computed: string;
  actions: string;
}

interface Props {
  policy: ResolvedObjectFieldPolicy;
}

let { policy }: Props = $props();
const columns: DataTableColumn<Row>[] = [
  { id: 'name', label: 'Name' },
  { id: 'published', label: 'Published' },
  { id: 'metadata', label: 'Metadata', hidden: true },
  { id: 'computed', label: 'Computed' },
  { id: 'actions', label: 'Actions' },
];
const rows: Row[] = [
  {
    name: 'Launch',
    published: true,
    metadata: 'server only',
    computed: 'Derived',
    actions: 'Edit',
  },
];
const visibleColumnIds = $derived.by(() =>
  policyToVisibleColumnIds(policy, columns),
);
</script>

<DataTable data={rows} {columns} {visibleColumnIds} caption="Policy table" />
