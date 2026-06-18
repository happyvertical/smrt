import { defineMessages } from '@happyvertical/smrt-svelte/i18n';

export const M = defineMessages({
  // ActionBar
  'assets.action_bar.delete_confirm_title': 'Delete {count} asset{plural}?',
  // Separate singular/plural messages (an English `{plural}` suffix doesn't translate).
  'assets.action_bar.delete_confirm_message_one':
    'This action cannot be undone. The asset and its file data will be permanently removed.',
  'assets.action_bar.delete_confirm_message_other':
    'This action cannot be undone. The assets and their file data will be permanently removed.',
  'assets.action_bar.delete': 'Delete',
  'assets.action_bar.cancel': 'Cancel',

  // AssetDetail
  'assets.asset_detail.open_pdf_in_new_tab': 'Open PDF in new tab',
  'assets.asset_detail.alt_text': 'Alt Text',
  'assets.asset_detail.alt_text_missing_warning':
    '⚠️ Missing — required for accessibility',
  'assets.asset_detail.quick_actions': 'Quick Actions',
  'assets.asset_detail.copy_url': '📋 Copy URL',
  'assets.asset_detail.copy_markdown': '📝 Copy Markdown',
  'assets.asset_detail.edit_image': '✏️ Edit Image',
  'assets.asset_detail.used_in': 'Used In',
  'assets.asset_detail.alt_text_placeholder':
    'Describe this image for screen readers',
  'assets.asset_detail.description_placeholder': 'Optional description',

  // AssetGrid
  'assets.asset_grid.loading': 'Loading assets...',
  'assets.asset_grid.no_assets_found': 'No assets found',
  'assets.asset_grid.empty_hint':
    'Upload an asset or change your search filters to see results.',
  'assets.asset_grid.no_alt': '⚠️ No alt',
  'assets.asset_grid.missing_alt_text': 'Missing alt text',
  'assets.asset_grid.open_named': 'Open {name}',
  'assets.asset_grid.select_named': 'Select {name}',
  'assets.asset_grid.select_named_checkbox': 'Select {name}',

  // AssetList
  'assets.asset_list.loading': 'Loading assets...',
  'assets.asset_list.no_assets_found': 'No assets found',
  'assets.asset_list.empty_hint':
    'Upload an asset or change your search filters to see results.',
  'assets.asset_list.select_all': 'Select all',
  'assets.asset_list.select_named': 'Select {name}',

  // AssetManager
  'assets.asset_manager.drop_file_to_upload': 'Drop file to upload',

  // AssetToolbar
  'assets.asset_toolbar.all_types': 'All types',
  'assets.asset_toolbar.newest_first': 'Newest first',
  'assets.asset_toolbar.oldest_first': 'Oldest first',
  'assets.asset_toolbar.name_a_z': 'Name A–Z',
  'assets.asset_toolbar.name_z_a': 'Name Z–A',
  'assets.asset_toolbar.recently_updated': 'Recently updated',
  'assets.asset_toolbar.search_placeholder': 'Search assets...',
  'assets.asset_toolbar.search_assets': 'Search assets',
  'assets.asset_toolbar.clear_search': 'Clear search',
  'assets.asset_toolbar.filter_by_type': 'Filter by type',
  'assets.asset_toolbar.sort_assets': 'Sort assets',
  'assets.asset_toolbar.view_mode': 'View mode',
  'assets.asset_toolbar.view_label': '{label} view',

  // CreateAssetModal
  'assets.create_asset_modal.dropzone_text':
    'Drag & drop a file here, or click to browse',
  'assets.create_asset_modal.dropzone_hint':
    'You can also paste an image from your clipboard',
  'assets.create_asset_modal.large_file_warning':
    '⚠️ Large file — may slow page loads',
  'assets.create_asset_modal.alt_text': 'Alt Text',
  'assets.create_asset_modal.alt_text_recommended_warning':
    '⚠️ Recommended for accessibility',
  'assets.create_asset_modal.name_placeholder': 'Asset name',
  'assets.create_asset_modal.description_placeholder': 'Optional description',
  'assets.create_asset_modal.alt_text_placeholder':
    'Describe this image for screen readers',
  'assets.create_asset_modal.upload_asset': 'Upload Asset',
  'assets.create_asset_modal.preview_alt': 'Preview',
  'assets.create_asset_modal.remove_file': 'Remove file',

  // AssetDetailPreview (playground)
  'assets.asset_detail_preview.modal_preview': 'Modal Preview',
  'assets.asset_detail_preview.description':
    'Launch the asset detail dialog from inside the preview stage so the shared\n      playground stays navigable.',
  'assets.asset_detail_preview.open_asset_detail': 'Open Asset Detail',

  // CreateAssetModalPreview (playground)
  'assets.create_asset_modal_preview.modal_preview': 'Modal Preview',
  'assets.create_asset_modal_preview.title': 'Create Asset Modal',
  'assets.create_asset_modal_preview.description':
    'Open the upload dialog from inside the preview stage to exercise the real\n      modal flow without covering the host navigation.',
  'assets.create_asset_modal_preview.open_upload_modal': 'Open Upload Modal',
  'assets.create_asset_modal_preview.alt_text': 'Alt Text',

  // AssetManagerRoute (route)
  'assets.asset_manager_route.eyebrow': 'Package Route Surface',
  'assets.asset_manager_route.title': 'Asset Manager',
  'assets.asset_manager_route.lede':
    'The reference route for browsing, selecting, and reviewing uploaded\n        assets with the package-owned asset manager UI.',
  'assets.asset_manager_route.selection_state': 'Selection State',
  'assets.asset_manager_route.no_assets_selected': 'No assets selected.',
  'assets.asset_manager_route.assets_selected': 'asset{plural} selected.',
  'assets.asset_manager_route.custom_action_example': 'Custom Action Example',
  'assets.asset_manager_route.custom_action_description':
    'This route keeps package-owned defaults while leaving room for app\n          specific actions.',
  'assets.asset_manager_route.queue_review': 'Queue Review',
  'assets.asset_manager_route.queue_review_hint':
    'from the selection action bar to see\n            the package route feedback.',
  'assets.asset_manager_route.surface_label': 'Asset manager surface',
  'assets.asset_manager_route.route_state_label': 'Asset route state',
});
