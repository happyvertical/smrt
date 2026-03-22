import { IMAGES_ROUTE_META } from './routes/shared.js';

const DEFAULT_IMAGES_PLAYGROUND_API_BASE_URL = '/api/v1';

type ImagesPlaygroundGlobal = typeof globalThis & {
  __SMRT_IMAGES_PLAYGROUND_API_BASE_URL__?: string;
};

function resolveImagesPlaygroundApiBaseUrl(): string {
  const configuredViaGlobal = (globalThis as ImagesPlaygroundGlobal)
    .__SMRT_IMAGES_PLAYGROUND_API_BASE_URL__;
  if (configuredViaGlobal) {
    return configuredViaGlobal;
  }

  if (typeof globalThis.location !== 'undefined') {
    const configuredViaQuery = new URLSearchParams(
      globalThis.location.search,
    ).get('smrtImagesApiBaseUrl');

    if (configuredViaQuery) {
      return configuredViaQuery;
    }
  }

  return DEFAULT_IMAGES_PLAYGROUND_API_BASE_URL;
}

function createPreviewImageUri(label: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
    <defs>
      <linearGradient id="bg" x1="0%" x2="100%" y1="0%" y2="100%">
        <stop offset="0%" stop-color="${accent}" />
        <stop offset="100%" stop-color="#111827" />
      </linearGradient>
    </defs>
    <rect width="1280" height="720" fill="url(#bg)" rx="40" />
    <circle cx="1040" cy="170" r="92" fill="rgba(255,255,255,0.18)" />
    <path d="M110 590L360 320l182 170 146-104 210 204H110z" fill="rgba(255,255,255,0.22)" />
    <text x="92" y="118" fill="#f8fafc" font-size="60" font-family="Arial, sans-serif" font-weight="700">${label}</text>
    <text x="92" y="662" fill="#dbeafe" font-size="30" font-family="Arial, sans-serif">SMRT Images preview</text>
  </svg>`;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const sampleImage = {
  id: 'image-harbor-dusk',
  name: 'Harbor Dusk',
  description: 'Wide editorial frame used for feature headers.',
  sourceUri: createPreviewImageUri('Harbor Dusk', '#2563eb'),
  url: createPreviewImageUri('Harbor Dusk', '#2563eb'),
  mimeType: 'image/jpeg',
  width: 1280,
  height: 720,
  alt: 'Cargo cranes and harbor lights reflected at dusk.',
};

const loadImageEditor = () => import('./components/ImageEditor.svelte');
const loadImageStudioRoute = () => import('./routes/ImageStudioRoute.svelte');
const loadImageUploader = () => import('./components/ImageUploader.svelte');

export default {
  packageName: '@happyvertical/smrt-images',
  displayName: 'Images',
  description: IMAGES_ROUTE_META.studio.description,
  entries: [
    {
      id: 'image-uploader',
      title: 'Image Uploader',
      description:
        'Mock-safe uploader preview for local files and external image URLs.',
      loadComponent: loadImageUploader,
      order: 1,
      tags: ['uploader', 'images', 'media'],
      props: {
        allowedTabs: ['upload', 'external'],
        onSelect: () => undefined,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'image-editor',
      title: 'Image Editor',
      description:
        'Editor controls for resizing, cropping, and AI-assisted image edits.',
      loadComponent: loadImageEditor,
      order: 2,
      tags: ['editor', 'images', 'media'],
      props: {
        image: sampleImage,
        onSave: () => undefined,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'image-studio-route',
      title: 'Image Studio Route',
      description:
        'Package-owned acquisition and editing flow backed by the generated images API.',
      loadComponent: loadImageStudioRoute,
      order: 3,
      tags: ['route', 'images', 'admin'],
      modes: {
        live: {
          label: 'Live',
          description:
            'Requires the images package dev server and generated routes. Override the base URL with ?smrtImagesApiBaseUrl=... or window.__SMRT_IMAGES_PLAYGROUND_API_BASE_URL__ when needed.',
          props: {
            apiBaseUrl: resolveImagesPlaygroundApiBaseUrl(),
          },
        },
      },
    },
  ],
};
