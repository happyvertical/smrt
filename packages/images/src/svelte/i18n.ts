import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // PhotoCutoutSetup
  'images.photo_cutout_setup.title': 'Photographic character setup',
  'images.photo_cutout_setup.choose_photo': 'Choose character photo',
  'images.photo_cutout_setup.photo_formats': 'PNG, JPEG, or WebP below 8 MB',
  'images.photo_cutout_setup.preview_speech': 'Preview speech',
  'images.photo_cutout_setup.stop_speech': 'Stop speech',
  'images.photo_cutout_setup.transparent_head': 'Step 1: transparent head',
  'images.photo_cutout_setup.isolated_head_alt':
    'Isolated head on transparent background',
  'images.photo_cutout_setup.source_alt': 'Selected character source',
  'images.photo_cutout_setup.preview_label': 'Animated character preview',
  'images.photo_cutout_setup.steps_label': 'Character setup steps',
  'images.photo_cutout_setup.options_label': 'Character setup options',
  'images.photo_cutout_setup.redo_head': 'Redo head isolation',
  'images.photo_cutout_setup.redo_mouth': 'Redo mouth segmentation',
  'images.photo_cutout_setup.step_choose': 'Choose photo',
  'images.photo_cutout_setup.step_isolate': 'Isolate head',
  'images.photo_cutout_setup.step_mouth': 'Set mouth',
  'images.photo_cutout_setup.step_save': 'Save to gallery',
  'images.photo_cutout_setup.save_hint':
    'Saving adds this character to your gallery. It does not change your active helper.',

  // AssetsGallery
  'images.assets_gallery.title': 'Pictures',
  'images.assets_gallery.search_placeholder': 'Search pictures',
  'images.assets_gallery.any_orientation': 'Any shape',
  'images.assets_gallery.min_width_placeholder': 'Wider than (pixels)',
  'images.assets_gallery.min_height_placeholder': 'Taller than (pixels)',
  'images.assets_gallery.no_images_found': 'No pictures match.',

  // ImageEditor
  'images.image_editor.title': 'Image Editor',
  'images.image_editor.no_image_selected': 'No image selected for editing.',
  'images.image_editor.standard_tools': 'Standard Tools',
  'images.image_editor.ai_edit': 'AI Edit',
  'images.image_editor.apply_resize': 'Apply Resize',
  'images.image_editor.reset_dimensions': 'Reset Dimensions',
  'images.image_editor.apply_crop': 'Apply Crop',
  'images.image_editor.convert_format': 'Convert Format',
  'images.image_editor.ai_powered_edit': 'AI Powered Edit',
  'images.image_editor.ai_powered_edit_hint':
    'Describe how you want to change this image. A new derivative asset will be created.',
  'images.image_editor.ai_prompt_placeholder':
    'e.g. Change the background to a sunset...',

  // ImageUploader
  'images.image_uploader.select_image': 'Use this picture',
  'images.image_uploader.create_variation': 'Create Variation',
  'images.image_uploader.variation_hint':
    'Describe how this image should be changed. A new derivative will be created from the original.',
  'images.image_uploader.variation_prompt_placeholder':
    'e.g. Change the sky to show heavy rain and overcast clouds...',
  'images.image_uploader.generating': 'Generating…',
  'images.image_uploader.generate_variation': 'Generate Variation',
  'images.image_uploader.choose_image': 'Choose a picture',
  'images.image_uploader.external_url': 'Web address',
  'images.image_uploader.drag_and_drop': 'Drop a picture here',
  'images.image_uploader.browse_files': 'Choose from your device',
  'images.image_uploader.try_again': 'Try Again',
  'images.image_uploader.starting_camera': 'Starting camera...',
  'images.image_uploader.take_picture': 'Take Picture',
  'images.image_uploader.external_hint': 'Paste the web address of a picture.',
  'images.image_uploader.external_url_placeholder':
    'https://example.com/image.jpg',

  // ImageStudioRoute (route)
  'images.image_studio_route.eyebrow': 'Package Route Surface',
  'images.image_studio_route.title': 'Image Studio',
  'images.image_studio_route.lede':
    'A package-owned route for acquiring images, browsing stored assets, and moving directly into the editor workflow.',
  'images.image_studio_route.acquire_images': 'Acquire Images',
  'images.image_studio_route.acquire_images_description':
    'Use the uploader to test gallery selection, local uploads, camera capture, and external URLs from the same package surface downstream apps can mount.',
  'images.image_studio_route.browse_and_edit': 'Browse And Edit',
  'images.image_studio_route.browse_and_edit_description':
    'The gallery and editor stay wired together so route consumers can see the intended package flow instead of disconnected component snapshots.',
});
