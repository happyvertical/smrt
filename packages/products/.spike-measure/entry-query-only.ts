// Fallback comparison: TanStack Query core alone (the documented fallback).
// Resolved through smrt-web's node_modules (query-core is its transitive dep;
// measurement-only shortcut, not an app import path).
import {
  QueryClient,
  QueryObserver,
} from '../node_modules/@happyvertical/smrt-web/node_modules/@tanstack/query-core/build/modern/index.js';

const client = new QueryClient();
const observer = new QueryObserver(client, {
  queryKey: ['products'],
  queryFn: async () => fetch('/api/v1/products').then((r) => r.json()),
});
(globalThis as Record<string, unknown>).__spike = { client, observer };
