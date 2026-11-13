import type {
  ApprovalView,
  Description,
  DraftInfo,
  PublishPreview,
  VersionInfo,
} from '../lib/ui/types.ts';

export const draftInfo: DraftInfo = {
  id: 'draft-1',
  name: 'Better orders',
  status: 'open',
  baseVersion: 1,
  version: 3,
  changes: 2,
  createdAt: '2026-11-10T00:00:00Z',
  createdBy: 'owner-1',
  liveVersion: 1,
  liveFrozen: true,
  publishable: true,
  problem: null,
  recovery: 'none',
};
const customer = {
  kind: 'app' as const,
  label: 'Customers',
  table: 'customers',
  className: 'Customer',
  extends: null,
  fields: { name: { type: 'text' as const } },
  ownFields: ['name'],
  methods: {},
};
export function description(mode: 'live' | 'draft' = 'draft'): Description {
  return {
    mode,
    draft: { ...draftInfo },
    frozen: mode === 'live',
    name: 'My app',
    version: 3,
    models: {
      Customer: customer,
      ...(mode === 'draft'
        ? { Order: { ...customer, label: 'Orders', className: 'Order' } }
        : {}),
    },
    recipes: [],
    pendingApprovals: 0,
  };
}
export const preview: PublishPreview = {
  digest: 'reviewed-chain',
  fromVersion: 1,
  toVersion: 3,
  definition: {
    modelsAdded: ['Order'],
    modelsRemoved: ['Note'],
    recipesAdded: [],
    recipesRemoved: [],
    models: {
      Customer: {
        fieldsAdded: ['email'],
        fieldsRemoved: ['oldName'],
        fieldsChanged: [
          { field: 'age', from: { type: 'text' }, to: { type: 'integer' } },
        ],
      },
    },
  },
  archives: { values: 7, tables: 1 },
  versions: [
    { version: 2, summary: 'Improve orders', statements: [], steps: [] },
    {
      version: 3,
      summary: 'Convert ages',
      statements: [],
      steps: [{ op: 'convertColumn', table: 'customers', column: 'age' }],
    },
  ],
  methods: [
    {
      model: 'Customer',
      name: 'greet',
      change: 'unchanged',
      description: 'Greeting',
      code: 'return { result: "hello" };',
    },
    {
      model: 'Order',
      name: 'total',
      change: 'added',
      description: 'Calculate total',
      code: 'return { result: records.length };',
    },
  ],
};
export function publishApproval(): ApprovalView {
  return {
    id: 'approval-publish',
    status: 'pending',
    summary: 'Publish Better orders',
    preview: { ...preview, draft: draftInfo.name },
    action: {
      kind: 'publish-draft',
      draftId: draftInfo.id,
      draftName: draftInfo.name,
      digest: preview.digest,
    },
    requestedBy: 'owner-1',
    decidedBy: '',
    decidedAt: '',
    result: null,
    createdAt: draftInfo.createdAt,
  };
}
export const versions: VersionInfo[] = [
  {
    version: 1,
    parent: null,
    author: 'Owner',
    summary: 'Base',
    createdAt: draftInfo.createdAt,
    purged: false,
    current: false,
    publish: null,
  },
  ...[2, 3].map((version) => ({
    version,
    parent: version - 1,
    author: 'Owner',
    summary: `Change ${version}`,
    createdAt: draftInfo.createdAt,
    purged: false,
    current: version === 3,
    publish: { draftId: draftInfo.id, name: draftInfo.name },
  })),
];
