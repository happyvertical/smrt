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
import { defineMessages } from '@happyvertical/smrt-ui/i18n';

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
  'chat.tool_call_display.applied_successfully': 'Change applied successfully.',
  'chat.tool_call_display.confirm': 'Confirm',
  'chat.tool_call_display.reject': 'Reject',

  // ModelPicker (#2904)
  'chat.model_picker.label': 'Model',

  // AssistantComposer (#2904)
  'chat.assistant_composer.attach_files': 'Attach files',
  'chat.assistant_composer.message_label': 'Message',
  'chat.assistant_composer.send': 'Send',
  'chat.assistant_composer.remove_attachment': 'Remove {name}',
  'chat.assistant_composer.send_error': 'Could not send: {message}',
  'chat.assistant_composer.send_failed': 'Send failed',
  'chat.assistant_composer.upload_error': 'Could not attach file: {message}',
  'chat.assistant_composer.upload_failed': 'Attachment failed',

  // AssistantThreadList (#2904)
  'chat.assistant_thread_list.conversations_label': 'Assistant conversations',
  'chat.assistant_thread_list.new_conversation': '+ New conversation',
  'chat.assistant_thread_list.untitled': 'Untitled',

  // AssistantDock (#2904)
  'chat.assistant_dock.no_surfaces':
    'Nothing on this page can be changed from the chat. You can still ask questions.',
  'chat.assistant_dock.loading_conversations': 'Loading conversations…',
  'chat.assistant_dock.choose_conversation': 'Choose a conversation',
  'chat.assistant_dock.choose_conversation_hint':
    'Select a conversation to start chatting with the assistant.',
  'chat.assistant_dock.view_conversations': 'View conversations',
  'chat.assistant_dock.start_conversation': 'Start a conversation',
  'chat.assistant_dock.start_conversation_hint':
    'Create a conversation to start chatting with the assistant.',
  'chat.assistant_dock.start_new_conversation': 'Create conversation',
  'chat.assistant_dock.no_conversations': 'No conversations available',
  'chat.assistant_dock.no_conversations_hint':
    'There is not a conversation available for this workspace yet.',
  // Streamed turns and browser tools (#2908)
  'chat.assistant_dock.stop': 'Stop',
  'chat.assistant_dock.tool_request_title': 'The assistant wants to do this:',
  'chat.assistant_dock.choices_pick': 'Pick one to use it.',
  'chat.assistant_dock.choices_none': 'None of these',
  'chat.assistant_dock.choices_applying': 'Using your pick…',
  'chat.assistant_dock.choices_applied': 'Used: {label}',
  'chat.assistant_dock.choices_failed':
    'That did not work: {message}. Pick again.',
  'chat.assistant_dock.choices_making': 'Making…',
  'chat.assistant_dock.choices_unavailable':
    'That could not be made: {message}',
  'chat.assistant_dock.tool_request_allow': 'Allow',
  'chat.assistant_dock.tool_request_decline': "Don't allow",
  'chat.assistant_dock.tool_request_destructive': "This can't be undone.",
  'chat.assistant_dock.tool_request_details': 'Details',
  'chat.assistant_dock.steps_label': 'What the assistant did',
  'chat.assistant_dock.reply_in_progress': 'Reply in progress',
  'chat.assistant_dock.taking_longer':
    'The assistant is taking longer than expected.',
  'chat.assistant_dock.retry': 'Retry "{content}"',
  'chat.assistant_dock.error': 'Something went wrong: {message}',
  'chat.assistant_dock.send_failed':
    'A message failed to send. You can retry it below.',
  'chat.assistant_dock.attachments': 'Attachments',
  'chat.assistant_dock.conversations_toggle': 'Conversations',
  // Single-conversation mode
  'chat.assistant_dock.opening_conversation': 'Opening the assistant…',
  'chat.assistant_dock.retry_conversation': 'Try again',
  'chat.assistant_dock.clear_conversation': 'Clear conversation',
  'chat.assistant_dock.action_outcome_unknown':
    "We couldn't confirm whether this change was applied. Checking again is safe: it resends the same request, so the change can't be applied twice.",
  'chat.assistant_dock.action_check_again': 'Check again',

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
