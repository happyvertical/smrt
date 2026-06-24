/**
 * Content editor component message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in the EDITOR component group
 * of the content Svelte components under `components/`. Keys follow
 * `content.<component>.<descriptor>`.
 */
import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // ContentAgentChat
  'content.content_agent_chat.loading_ai_assistant': 'Loading AI Assistant...',
  'content.content_agent_chat.loading_topic': 'Loading topic...',
  'content.content_agent_chat.loading_participant': 'Loading participant...',
  'content.content_agent_chat.no_topics': 'No topics...',
  'content.content_agent_chat.topic_name_placeholder': 'Topic name...',
  'content.content_agent_chat.new_topic': 'New Topic',
  'content.content_agent_chat.cancel': 'Cancel',
  'content.content_agent_chat.new': 'New',
  'content.content_agent_chat.untitled_topic': 'Untitled Topic',

  // ContentBodyEditor
  'content.content_body_editor.toolbar': 'Body editor toolbar',
  'content.content_body_editor.bold': 'Bold',
  'content.content_body_editor.italic': 'Italic',
  'content.content_body_editor.heading': 'Heading',
  'content.content_body_editor.bulleted_list': 'Bulleted list',
  'content.content_body_editor.insert_image': 'Insert image',
  'content.content_body_editor.save_as': 'Save as',
  'content.content_body_editor.selected_image_controls':
    'Selected image controls',
  'content.content_body_editor.move_image': 'Move image',
  'content.content_body_editor.wrap_text_on_right': 'Wrap text on right',
  'content.content_body_editor.center_image': 'Center image',
  'content.content_body_editor.wrap_text_on_left': 'Wrap text on left',
  'content.content_body_editor.full_width': 'Full width',
  'content.content_body_editor.make_smaller': 'Make smaller',
  'content.content_body_editor.make_image_smaller': 'Make image smaller',
  'content.content_body_editor.make_larger': 'Make larger',
  'content.content_body_editor.make_image_larger': 'Make image larger',
  'content.content_body_editor.use_as_primary_image': 'Use as primary image',
  'content.content_body_editor.remove_image': 'Remove image',
  'content.content_body_editor.resize_image': 'Resize image',
  'content.content_body_editor.resize_selected_image': 'Resize selected image',

  // ContentEditor
  'content.content_editor.publish_date': 'Publish Date',
  'content.content_editor.document_title_placeholder': 'Document title...',
  'content.content_editor.ai_updated_fields':
    'AI updated {count} {fieldLabel}: {fields}',
  'content.content_editor.field_singular': 'field',
  'content.content_editor.field_plural': 'fields',
  'content.content_editor.drag_into_body': 'Drag into the body',
  'content.content_editor.make_thumbnail': 'Make Thumbnail',
  'content.content_editor.remove': 'Remove',
  'content.content_editor.no_images_attached': 'No images attached.',
  'content.content_editor.add_image': 'Add Image',
  'content.content_editor.author_name_placeholder': 'Author name',
  'content.content_editor.brief_summary_placeholder': 'Brief summary...',
  'content.content_editor.tags_comma_separated': 'Tags (Comma separated):',
  'content.content_editor.tags_placeholder': 'e.g. news, tech',
  'content.content_editor.no_references': 'No references.',
  'content.content_editor.evidence_items_selected':
    '{count} evidence {itemLabel} selected',
  'content.content_editor.evidence_item_singular': 'item',
  'content.content_editor.evidence_item_plural': 'items',
  'content.content_editor.repair_resources': 'Repair resources',
  'content.content_editor.evidence_claims': '{count} evidence {claimLabel}',
  'content.content_editor.evidence_claim_singular': 'claim',
  'content.content_editor.evidence_claim_plural': 'claims',
  'content.content_editor.reference_id_or_url_placeholder':
    'Reference ID or URL',
  'content.content_editor.file_key': 'File Key:',
  'content.content_editor.agent_chat_unavailable': 'Agent chat unavailable',
  'content.content_editor.reference_drop_failed':
    'Could not add the dropped file as a reference. Please try again.',
  'content.content_editor.image_select_failed':
    'Could not add the selected image. Please try again.',
  'content.content_editor.dismiss_message': 'Dismiss',

  // ContentImageBrowser
  'content.content_image_browser.no_images_attached': 'No images attached.',

  // ContentImageChooser
  'content.content_image_chooser.body_images': 'Body images',
  'content.content_image_chooser.previous_body_image': 'Previous body image',
  'content.content_image_chooser.focus_selected_body_image':
    'Focus selected body image',
  'content.content_image_chooser.next_body_image': 'Next body image',

  // ContentMetadataFields
  'content.content_metadata_fields.file_key': 'File Key',
  'content.content_metadata_fields.tags_placeholder': 'e.g. news, tech',

  // ContentReferencesPanel
  'content.content_references_panel.no_references': 'No references.',
  'content.content_references_panel.reference_id_or_url_placeholder':
    'Reference ID or URL',
  'content.content_references_panel.add_reference_by_id_or_url':
    'Add reference by ID or URL',

  // ContentStatusFields
  'content.content_status_fields.video_segment': 'Video Segment',

  // ImageThumbnail
  'content.image_thumbnail.preview_unavailable': 'Preview unavailable',
  'content.image_thumbnail.thumbnail_preview': 'Thumbnail preview',
  'content.image_thumbnail.thumbnail_unavailable': 'Thumbnail unavailable',
});
