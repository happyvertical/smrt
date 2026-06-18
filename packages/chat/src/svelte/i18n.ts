/**
 * smrt-chat Svelte component message catalog (Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in the chat components under
 * `src/svelte/components/`. Keys use the `chat.` namespace
 * (`chat.<component>.<descriptor>`). Importing this module registers the
 * defaults so `useI18n().t` renders correctly even without a server snapshot.
 *
 * `M` is a typed key map — `M['chat.agent_chat.empty']` is the key literal — so
 * component call sites stay typo-safe.
 */
import { defineMessages } from '@happyvertical/smrt-svelte/i18n';

export const M = defineMessages({
  // AgentChat
  'chat.agent_chat.conversation': 'Agent conversation',
  'chat.agent_chat.inactive_notice': 'Session {status}. Cannot send messages.',
  'chat.agent_chat.input_placeholder': 'Ask the AI to write or edit content...',
  'chat.agent_chat.message_input': 'Message input',
  'chat.agent_chat.send_message': 'Send message',
  'chat.agent_chat.messages': 'Conversation messages',
  'chat.agent_chat.updated_fields': '✓ Updated {count} field{plural}',
  'chat.agent_chat.empty': 'Ask the AI to write or edit your content',
  'chat.agent_chat.field_changes': 'Field Changes',

  // AgentSelector
  'chat.agent_selector.select_an_agent': 'Select an agent',
  'chat.agent_selector.title': 'Choose an Agent',
  'chat.agent_selector.available_agents': 'Available agents',
  'chat.agent_selector.empty': 'No agents available',

  // AgentSessionPanel
  'chat.agent_session_panel.sessions': 'Agent sessions',
  'chat.agent_session_panel.new_session': 'New session',
  'chat.agent_session_panel.session_list': 'Session list',
  'chat.agent_session_panel.empty': 'No sessions yet',

  // ToolCallDisplay
  'chat.tool_call_display.tool_call': 'Tool call: {toolName}',
  'chat.tool_call_display.running': 'Running',

  // RoomCreateDialog
  'chat.room_create_dialog.close': 'Close room creation dialog',
  'chat.room_create_dialog.title': 'Create a Room',
  'chat.room_create_dialog.room_name': 'Room Name',
  'chat.room_create_dialog.required': 'required',
  'chat.room_create_dialog.name_placeholder': 'e.g. general, project-updates',
  'chat.room_create_dialog.room_type': 'Room Type',
  'chat.room_create_dialog.description_placeholder': 'What is this room about?',
  'chat.room_create_dialog.create_room': 'Create Room',

  // SearchMessages
  'chat.search_messages.search': 'Search messages',
  'chat.search_messages.title': 'Search Messages',
  'chat.search_messages.close': 'Close search',
  'chat.search_messages.input_placeholder': 'Search messages...',
  'chat.search_messages.query': 'Search query',
  'chat.search_messages.clear': 'Clear search',
  'chat.search_messages.results': 'Search results',
  'chat.search_messages.results_count': '{count} result{plural} found',
  'chat.search_messages.no_results': 'No messages found for "{query}"',
  'chat.search_messages.no_results_hint':
    'Try different keywords or check your spelling',
  'chat.search_messages.empty': 'Enter a search term to find messages',

  // FileUpload
  'chat.file_upload.preview': 'Files to upload',
  'chat.file_upload.remove': 'Remove {name}',
  'chat.file_upload.upload_files': 'Upload {count} file{plural}',
  'chat.file_upload.disabled': 'Upload disabled',
  'chat.file_upload.drop_files': 'Drop files here or click to browse',
  'chat.file_upload.max_size': 'Max {size} per file',

  // MentionAutocomplete
  'chat.mention_autocomplete.suggestions': 'Mention suggestions',

  // ReactionPicker
  'chat.reaction_picker.reactions': 'Emoji reactions',
  'chat.reaction_picker.react_with': 'React with {emoji}',

  // ReadReceipts
  'chat.read_receipts.read_status': '{readCount} of {total} read',
});
