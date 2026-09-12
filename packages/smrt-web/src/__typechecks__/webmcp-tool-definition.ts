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

// New callbacks can consume host cancellation; old one-argument callbacks remain valid.
import type {
  WebMcpBespokeToolSpec,
  WebMcpToolExecutionOptions,
} from '../index';
import type { WebMcpToolExecutionOptions as SubpathExecutionOptions } from '../webmcp';

const callbackOptions: WebMcpToolExecutionOptions = {};
const subpathOptions: SubpathExecutionOptions = callbackOptions;
const contextualCallback: WebMcpBespokeToolSpec['execute'] = (
  _args,
  options,
) => {
  options?.signal?.throwIfAborted();
  return 'ok';
};
const legacyCallback: WebMcpBespokeToolSpec['execute'] = (_args) => 'ok';
void subpathOptions;
void contextualCallback;
void legacyCallback;
