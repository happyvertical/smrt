const sampleAssets = [
  {
    id: 'asset-aurora-hero',
    slug: 'aurora-hero',
    name: 'Aurora Hero',
    sourceUri:
      'data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221280%22 height=%22720%22 viewBox=%220 0 1280 720%22%3E%3Crect width=%221280%22 height=%22720%22 fill=%22%230f766e%22/%3E%3Ccircle cx=%22980%22 cy=%22140%22 r=%2272%22 fill=%22%23facc15%22/%3E%3Ctext x=%2296%22 y=%22300%22 fill=%22white%22 font-size=%2276%22 font-family=%22Arial%22%3EAurora Hero%3C/text%3E%3Ctext x=%2296%22 y=%22372%22 fill=%22%23ccfbf1%22 font-size=%2238%22 font-family=%22Arial%22%3EReference image asset for editorial coverage%3C/text%3E%3C/svg%3E',
    mimeType: 'image/svg+xml',
    description: 'Reference hero artwork used in the shared assets previews.',
    version: 3,
    typeSlug: 'image',
    statusSlug: 'published',
    sourceType: 'playground',
    externalId: '',
    createdAt: '2026-03-12T10:30:00.000Z',
    updatedAt: '2026-03-20T16:05:00.000Z',
    alt: 'Teal aurora gradient hero art with a yellow sun.',
  },
  {
    id: 'asset-governance-pdf',
    slug: 'governance-checklist',
    name: 'Governance Checklist',
    sourceUri: 'https://example.com/governance-checklist.pdf',
    mimeType: 'application/pdf',
    description:
      'Editorial review checklist shared with contributors and editors.',
    version: 1,
    typeSlug: 'document',
    statusSlug: 'approved',
    sourceType: 'playground',
    externalId: '',
    createdAt: '2026-03-10T08:00:00.000Z',
    updatedAt: '2026-03-19T13:45:00.000Z',
  },
  {
    id: 'asset-field-audio',
    slug: 'field-interview',
    name: 'Field Interview Clip',
    sourceUri: 'https://example.com/field-interview.mp3',
    mimeType: 'audio/mpeg',
    description: 'Audio clip attached to a logistics field report.',
    version: 2,
    typeSlug: 'audio',
    statusSlug: 'draft',
    sourceType: 'playground',
    externalId: '',
    createdAt: '2026-03-15T14:20:00.000Z',
    updatedAt: '2026-03-18T11:10:00.000Z',
  },
];

const noop = () => {};
const loadAssetManager = () => import('./AssetManager.svelte');
const loadAssetDetailPreview = () =>
  import('./playground/AssetDetailPreview.svelte');
const loadCreateAssetModalPreview = () =>
  import('./playground/CreateAssetModalPreview.svelte');

export default {
  packageName: '@happyvertical/smrt-assets',
  displayName: 'Assets',
  description:
    'Asset management components for selecting, reviewing, and annotating media.',
  entries: [
    {
      id: 'asset-manager',
      title: 'Asset Manager',
      description:
        'Manage assets with selection, filters, and the embedded detail drawer.',
      loadComponent: loadAssetManager,
      order: 1,
      props: {
        accept: 'image/*',
        customActions: [
          {
            label: 'Mark Featured',
            action: noop,
          },
        ],
        initialAssets: sampleAssets,
        mode: 'manage',
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'asset-picker',
      title: 'Asset Picker',
      description:
        'Selection-first asset browser for downstream content and commerce flows.',
      loadComponent: loadAssetManager,
      order: 2,
      props: {
        accept: 'image/*',
        initialAssets: sampleAssets,
        mode: 'pick',
        onselect: noop,
        onconfirm: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'asset-detail',
      title: 'Asset Detail',
      description:
        'Metadata, accessibility, and preview surface for a single asset.',
      loadComponent: loadAssetDetailPreview,
      order: 3,
      props: {
        asset: sampleAssets[0],
        onclose: noop,
        ondelete: noop,
        onedit: noop,
        onsave: noop,
        open: true,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'create-asset-modal',
      title: 'Create Asset Modal',
      description:
        'Upload-first asset creation flow with metadata and accessibility fields.',
      loadComponent: loadCreateAssetModalPreview,
      order: 4,
      props: {
        onclose: noop,
        oncreate: noop,
        open: true,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
