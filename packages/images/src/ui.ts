/**
 * Images Module UI Slot Declarations
 *
 * This file defines the UI extension points for the images module.
 * UI components are implemented in the ./svelte subpath.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Images module UI slots
 */
export const IMAGES_UI_SLOTS: Record<string, ModuleUISlot> = {
  'assets-gallery': {
    id: 'assets-gallery',
    label: 'Assets Gallery',
    description: 'Grid gallery of image assets with filtering and selection',
    icon: 'images',
    category: 'list',
    order: 1,
    propsInterface: 'AssetsGalleryProps',
  },
  'image-editor': {
    id: 'image-editor',
    label: 'Image Editor',
    description:
      'Resize, crop, convert, and AI-edit an image with derivative tracking',
    icon: 'image',
    category: 'form',
    order: 2,
    propsInterface: 'ImageEditorProps',
  },
  'image-uploader': {
    id: 'image-uploader',
    label: 'Image Uploader',
    description: 'Upload images with metadata extraction and AI categorization',
    icon: 'upload',
    category: 'form',
    order: 3,
    propsInterface: 'ImageUploaderProps',
  },
};

/**
 * Images module metadata
 */
export const IMAGES_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-images',
  displayName: 'Images',
  description:
    'Image asset management with AI-powered categorization, search, editing, and metadata extraction',
  uiSlots: IMAGES_UI_SLOTS,
  models: ['Image'],
  collections: ['ImageCollection'],
};
