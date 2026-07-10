import { IMAGES_ROUTE_MODULE } from './route-module.js';
import type {
  ImageCropRequest,
  ImageEditorClient,
  ImageEditorResult,
  ImageLike,
  ImageResizeRequest,
  ImagesGalleryClient,
  ImagesGalleryQuery,
} from './svelte/image-clients.js';
import playground from './svelte/playground.js';

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
    <text x="92" y="662" fill="#dbeafe" font-size="30" font-family="Arial, sans-serif">SMRT Images workbench</text>
  </svg>`;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const sampleImages: ImageLike[] = [
  {
    id: 'image-harbor-dusk',
    name: 'Harbor Dusk',
    description: 'Wide editorial frame used for feature headers.',
    sourceUri: createPreviewImageUri('Harbor Dusk', '#2563eb'),
    url: createPreviewImageUri('Harbor Dusk', '#2563eb'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    alt: 'Cargo cranes and harbor lights reflected at dusk.',
  },
  {
    id: 'image-studio-square',
    name: 'Studio Square',
    description: 'Square crop used for social image tooling.',
    sourceUri: createPreviewImageUri('Studio Square', '#0f766e'),
    url: createPreviewImageUri('Studio Square', '#0f766e'),
    mimeType: 'image/png',
    width: 900,
    height: 900,
    alt: 'Abstract studio preview frame.',
  },
  {
    id: 'image-portrait-window',
    name: 'Portrait Window',
    description: 'Portrait-oriented sample for orientation filters.',
    sourceUri: createPreviewImageUri('Portrait Window', '#9333ea'),
    url: createPreviewImageUri('Portrait Window', '#9333ea'),
    mimeType: 'image/webp',
    width: 720,
    height: 1080,
    alt: 'Portrait image preview.',
  },
];

function cloneImage(image: ImageLike): ImageLike {
  return {
    ...image,
  };
}

function matchesOrientation(
  image: ImageLike,
  orientation: ImagesGalleryQuery['orientation'],
) {
  if (!orientation) {
    return true;
  }

  if (orientation === 'square') {
    return image.width === image.height;
  }

  if (orientation === 'landscape') {
    return image.width > image.height;
  }

  return image.height > image.width;
}

const galleryClient: ImagesGalleryClient = {
  async list(query) {
    const filteredImages = sampleImages.filter((image) => {
      const haystack = [
        image.name,
        image.description,
        image.alt,
        image.mimeType,
      ]
        .join(' ')
        .toLowerCase();

      return (
        (!query.q || haystack.includes(query.q.toLowerCase())) &&
        matchesOrientation(image, query.orientation) &&
        (!query.minWidth || image.width >= query.minWidth) &&
        (!query.minHeight || image.height >= query.minHeight)
      );
    });

    return {
      items: filteredImages
        .slice(query.offset, query.offset + query.limit)
        .map(cloneImage),
    };
  },
};

function findImage(id: string): ImageLike {
  return sampleImages.find((image) => image.id === id) || sampleImages[0];
}

function buildDerivative(
  source: ImageLike,
  suffix: string,
  updates: Partial<ImageLike> = {},
): ImageEditorResult {
  return {
    image: {
      ...source,
      ...updates,
      id: `${source.id}-${suffix}`,
      name: `${source.name} ${suffix}`,
    },
  };
}

const editorClient: ImageEditorClient = {
  async resize(id: string, payload: ImageResizeRequest) {
    return buildDerivative(findImage(id), 'resize', {
      width: payload.width,
      height: payload.height,
    });
  },
  async crop(id: string, payload: ImageCropRequest) {
    return buildDerivative(findImage(id), 'crop', {
      width: payload.w,
      height: payload.h,
    });
  },
  async convert(id: string, payload) {
    return buildDerivative(findImage(id), payload.format, {
      mimeType: `image/${payload.format}`,
    });
  },
  async edit(id: string) {
    return buildDerivative(findImage(id), 'ai-edit');
  },
};

const routeModule = {
  ...IMAGES_ROUTE_MODULE,
  routes: {
    studio: {
      ...IMAGES_ROUTE_MODULE.routes.studio,
      props: {
        galleryClient,
        editorClient,
        initialImage: sampleImages[0],
      },
    },
  },
};

export default {
  packageName: '@happyvertical/smrt-images',
  displayName: 'Images',
  description:
    'Workbench surfaces for image acquisition, browsing, editing, and package previews.',
  routeModules: [routeModule],
  recommendedCommands: [
    {
      id: 'images:test',
      label: 'Test',
      command: 'pnpm --filter @happyvertical/smrt-images test',
    },
    {
      id: 'images:typecheck',
      label: 'Typecheck',
      command: 'pnpm --filter @happyvertical/smrt-images typecheck',
    },
  ],
  examples: [
    {
      id: 'images:playground',
      title: 'Images playground module',
      path: 'src/svelte/playground.ts',
      source: 'playground',
    },
  ],
};

export { playground };
