import { ASSETS_ROUTE_META } from './routes/shared.js';

function createPreviewAssetUri(label: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">
    <defs>
      <linearGradient id="bg" x1="0%" x2="100%" y1="0%" y2="100%">
        <stop offset="0%" stop-color="${accent}" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
    </defs>
    <rect width="1200" height="800" fill="url(#bg)" rx="48" />
    <circle cx="260" cy="220" r="110" fill="rgba(255,255,255,0.16)" />
    <path d="M120 620L430 330l210 190 150-120 290 220H120z" fill="rgba(255,255,255,0.22)" />
    <text x="96" y="126" fill="#e2e8f0" font-size="64" font-family="Arial, sans-serif" font-weight="700">${label}</text>
    <text x="96" y="690" fill="#cbd5e1" font-size="34" font-family="Arial, sans-serif">SMRT Assets preview</text>
  </svg>`;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const sampleAssets = [
  {
    id: 'asset-harbor-map',
    name: 'Harbor Map',
    description: 'Annotated port operations map for logistics planning.',
    sourceUri: createPreviewAssetUri('Harbor Map', '#0891b2'),
    mimeType: 'image/png',
    createdAt: '2026-03-11T09:15:00.000Z',
    updatedAt: '2026-03-18T15:44:00.000Z',
    statusSlug: 'active',
    alt: 'Stylized harbor map with highlighted shipping lanes.',
  },
  {
    id: 'asset-spring-lookbook',
    name: 'Spring Lookbook',
    description: 'Photography sheet prepared for the seasonal launch.',
    sourceUri: createPreviewAssetUri('Lookbook', '#7c3aed'),
    mimeType: 'image/jpeg',
    createdAt: '2026-03-07T13:22:00.000Z',
    updatedAt: '2026-03-19T08:05:00.000Z',
    statusSlug: 'draft',
    alt: '',
  },
  {
    id: 'asset-style-guide',
    name: 'Brand Style Guide',
    description: 'Reference PDF for typography, voice, and image treatment.',
    sourceUri: '',
    mimeType: 'application/pdf',
    createdAt: '2026-03-01T18:00:00.000Z',
    updatedAt: '2026-03-10T18:45:00.000Z',
    statusSlug: 'published',
  },
];

const loadAssetGrid = () => import('./AssetGrid.svelte');
const loadAssetManagerRoute = () => import('./routes/AssetManagerRoute.svelte');

export default {
  packageName: '@happyvertical/smrt-assets',
  displayName: 'Assets',
  description: ASSETS_ROUTE_META.manager.description,
  entries: [
    {
      id: 'asset-manager-route',
      title: 'Asset Manager Route',
      description:
        'Package-owned route surface for browsing, selecting, and reviewing assets.',
      loadComponent: loadAssetManagerRoute,
      order: 1,
      tags: ['route', 'assets', 'admin'],
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'asset-grid',
      title: 'Asset Grid',
      description:
        'Thumbnail grid preview showing selection state and missing-alt warnings.',
      loadComponent: loadAssetGrid,
      order: 2,
      tags: ['grid', 'assets', 'media'],
      props: {
        assets: sampleAssets,
        selectedIds: new Set(['asset-spring-lookbook']),
        loading: false,
        onSelectionChange: () => undefined,
        onAssetClick: () => undefined,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
