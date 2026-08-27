import type { WebMcpToolDefinition } from '../index';

// Source-compatibility probe: hand-authored definitions that predate semantic
// effect metadata remain valid and are normalized fail-closed at registration.
const legacyWebMcpToolDefinition: WebMcpToolDefinition = {
  action: 'archive',
  name: 'article_archive',
  description: 'Archive an article',
  inputSchema: { type: 'object' },
  readOnly: false,
  collection: 'articles',
  objectRef: '@example/content:Article',
  className: 'Article',
  endpoint: '/api/articles',
  idField: 'id',
  idType: 'uuid',
  route: { method: 'POST', scope: 'item', path: ['[id]', 'archive'] },
  relationships: [],
};

void legacyWebMcpToolDefinition;
