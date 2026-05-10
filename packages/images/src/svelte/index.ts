/**
 * Images Module Svelte Components
 *
 * Optional Svelte UI components for image gallery, editing, and upload.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { IMAGES_MODULE_META } from '../ui.js';

// Import components
import AssetsGallery from './components/AssetsGallery.svelte';
import ImageEditor from './components/ImageEditor.svelte';
import ImageUploader from './components/ImageUploader.svelte';

// Export components
export { AssetsGallery, ImageEditor, ImageUploader };

export type {
  ImageConvertRequest,
  ImageCropRequest,
  ImageEditorClient,
  ImageEditorResult,
  ImageEditRequest,
  ImageLike,
  ImageResizeRequest,
  ImagesGalleryClient,
  ImagesGalleryQuery,
  ImagesGalleryResult,
} from './image-clients';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(IMAGES_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-images',
  'assets-gallery',
  AssetsGallery,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-images',
  'image-editor',
  ImageEditor,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-images',
  'image-uploader',
  ImageUploader,
);
