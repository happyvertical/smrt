import type { ImageEditorClient, ImagesGalleryClient } from './image-clients';

function createSvgImage(label: string, background: string, accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="${background}" />
    <circle cx="1020" cy="160" r="96" fill="${accent}" opacity="0.9" />
    <text x="96" y="312" fill="white" font-size="78" font-family="Arial">SMRT Images</text>
    <text x="96" y="392" fill="#e2e8f0" font-size="40" font-family="Arial">${label}</text>
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const sampleImages = [
  {
    id: 'image-aurora',
    slug: 'aurora-preview',
    name: 'Aurora Preview',
    sourceUri: createSvgImage('Aurora Preview', '#0f766e', '#facc15'),
    url: createSvgImage('Aurora Preview', '#0f766e', '#facc15'),
    mimeType: 'image/svg+xml',
    description: 'Reference preview used in the image gallery and editor.',
    width: 1280,
    height: 720,
    alt: 'Teal aurora art with a yellow sun.',
  },
  {
    id: 'image-night-market',
    slug: 'night-market-preview',
    name: 'Night Market',
    sourceUri: createSvgImage('Night Market', '#1d4ed8', '#f97316'),
    url: createSvgImage('Night Market', '#1d4ed8', '#f97316'),
    mimeType: 'image/svg+xml',
    description: 'Blue market scene used to exercise the gallery filters.',
    width: 1200,
    height: 1200,
    alt: 'Blue market scene with an orange accent circle.',
  },
  {
    id: 'image-field-report',
    slug: 'field-report-preview',
    name: 'Field Report',
    sourceUri: createSvgImage('Field Report', '#4338ca', '#22c55e'),
    url: createSvgImage('Field Report', '#4338ca', '#22c55e'),
    mimeType: 'image/svg+xml',
    description: 'Portrait-oriented reference image for editor operations.',
    width: 900,
    height: 1280,
    alt: 'Indigo field report art with a green accent.',
  },
];

const noop = () => {};

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function determineOrientation(image: {
  width: number;
  height: number;
}): 'landscape' | 'portrait' | 'square' {
  if (image.width === image.height) {
    return 'square';
  }

  return image.width > image.height ? 'landscape' : 'portrait';
}

function createImagePlaygroundClients(seed = sampleImages): {
  galleryClient: ImagesGalleryClient;
  editorClient: ImageEditorClient;
} {
  let images = cloneValue(seed);

  const findImage = (id: string) => {
    const image = images.find((item) => item.id === id);
    if (!image) {
      throw new Error(`Unknown image: ${id}`);
    }
    return image;
  };

  const replaceImage = (id: string, nextImage: Record<string, unknown>) => {
    images = images.map((image) =>
      image.id === id ? { ...image, ...nextImage } : image,
    );
    return cloneValue(findImage(id));
  };

  return {
    galleryClient: {
      list: async (query) => {
        const filtered = images.filter((image) => {
          if (
            query.q &&
            !`${image.name} ${image.description} ${image.alt}`
              .toLowerCase()
              .includes(query.q.toLowerCase())
          ) {
            return false;
          }

          if (
            query.orientation &&
            determineOrientation(image) !== query.orientation
          ) {
            return false;
          }

          if (
            typeof query.minWidth === 'number' &&
            image.width < query.minWidth
          ) {
            return false;
          }

          if (
            typeof query.minHeight === 'number' &&
            image.height < query.minHeight
          ) {
            return false;
          }

          return true;
        });

        return {
          items: cloneValue(
            filtered.slice(query.offset, query.offset + query.limit),
          ),
        };
      },
    },
    editorClient: {
      resize: async (id, payload) => ({
        image: replaceImage(id, {
          height: payload.height,
          width: payload.width,
        }),
      }),
      crop: async (id, payload) => ({
        image: replaceImage(id, {
          height: payload.h,
          width: payload.w,
        }),
      }),
      convert: async (id, payload) => ({
        image: replaceImage(id, {
          mimeType: `image/${payload.format}`,
          name: `${findImage(id).name} (${payload.format.toUpperCase()})`,
        }),
      }),
      edit: async (id, payload) => ({
        image: replaceImage(id, {
          alt: `${findImage(id).alt} Edited: ${payload.prompt}.`,
          description: `Edited with prompt: ${payload.prompt}`,
          name: `${findImage(id).name} Remix`,
        }),
      }),
    },
  };
}

const { editorClient, galleryClient } = createImagePlaygroundClients();
const loadAssetsGallery = () => import('./components/AssetsGallery.svelte');
const loadImageEditor = () => import('./components/ImageEditor.svelte');
const loadImageUploader = () => import('./components/ImageUploader.svelte');

export default {
  packageName: '@happyvertical/smrt-images',
  displayName: 'Images',
  description:
    'Image-focused components for browsing, selecting, and editing visual assets.',
  entries: [
    {
      id: 'assets-gallery',
      title: 'Assets Gallery',
      description:
        'Filterable gallery backed by a package-owned image client for reliable previews.',
      loadComponent: loadAssetsGallery,
      order: 1,
      props: {
        client: galleryClient,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'image-uploader',
      title: 'Image Uploader',
      description:
        'Multi-tab uploader with gallery, camera, external URL, and variation generation flows.',
      loadComponent: loadImageUploader,
      order: 2,
      props: {
        editorClient,
        galleryClient,
        onSelect: noop,
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
        'Resize, crop, convert, and AI edit workflows against a package-owned editor client.',
      loadComponent: loadImageEditor,
      order: 3,
      props: {
        client: editorClient,
        image: sampleImages[0],
        onCancel: noop,
        onSave: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
