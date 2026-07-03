// Minimal entry: the smrt-web TanStack DB layer, to isolate its bundle cost.
// Imports flow through @happyvertical/smrt-web exactly as a consumer's would.
import { createSmrtCollection } from '@happyvertical/smrt-web';
import { useLiveQuery } from '@happyvertical/smrt-web/svelte';

const collection = createSmrtCollection(
  {
    name: 'products',
    className: 'Product',
    endpoint: '/products',
    idField: 'id',
    actions: ['list', 'create'],
    fields: { name: { type: 'text', required: true } },
  },
  { basePath: '/api/v1' },
);
(globalThis as Record<string, unknown>).__spike = { collection, useLiveQuery };
