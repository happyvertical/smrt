<script lang="ts">
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import {
  type DataSurfaceDescriptor,
  DataTable,
} from '@happyvertical/smrt-ui/data';
import Form from '../../components/forms/Form.svelte';
import TextInput from '../../components/forms/TextInput.svelte';
import { useWebMcpTool } from '../webmcp.svelte.js';

let { dataSurfaceRegistry }: { dataSurfaceRegistry: DataSurfaceRegistry } =
  $props();

useWebMcpTool(() => ({
  name: 'fixture_component_preview',
  description:
    'Preview the composed fixture without changing application state.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
  execute: () => JSON.stringify({ ok: true, source: 'bespoke-component' }),
}));

// No `annotations`: fail-closed classifies this destructive (#2586), so it
// must be excluded under the Provider's default read-only exposure policy
// and must never reach document.modelContext.registerTool.
useWebMcpTool(() => ({
  name: 'fixture_component_unannotated',
  description: 'A bespoke tool with no declared effect.',
  inputSchema: { type: 'object', properties: {} },
  execute: () =>
    JSON.stringify({ ok: true, source: 'bespoke-component-unannotated' }),
}));

const tableDescriptor: DataSurfaceDescriptor = {
  version: 1,
  identity: { surfaceId: 'fixture-items', kind: 'table' },
  schemaVersion: 1,
  label: 'Fixture items',
  rowKey: 'id',
  columns: [
    { id: 'id', label: 'ID', capabilities: ['read', 'project'] },
    {
      id: 'name',
      label: 'Name',
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    },
  ],
  query: { modes: ['rows', 'count'], projectableColumnIds: ['id', 'name'] },
  controls: ['set-search', 'toggle-sorting'].map((id) => ({ id, label: id })),
  actions: [],
  limits: { maxQueryRows: 50, maxQueryBytes: 10_000, maxSelectionSize: 10 },
};

const rows = [
  { id: 'item-1', name: 'First' },
  { id: 'item-2', name: 'Second' },
];
const columns = [
  { id: 'id', label: 'ID', accessor: 'id' },
  { id: 'name', label: 'Name', accessor: 'name', sortable: true },
];
</script>

<Form formId="fixture-form">
  <TextInput name="title" label="Title" />
</Form>
<DataTable
  data={rows}
  {columns}
  rowKey="id"
  sortable={true}
  dataSurface={{ registry: dataSurfaceRegistry, descriptor: tableDescriptor }}
/>
