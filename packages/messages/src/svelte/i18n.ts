/**
 * smrt-messages Svelte component message catalog (Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in a subset of the messages
 * components under `src/svelte/components/`. Keys use the `messages.` namespace
 * (`messages.<component>.<descriptor>`). Importing this module registers the
 * defaults so `useI18n().t` renders correctly even without a server snapshot.
 *
 * `M` is a typed key map — `M['messages.account_list.loading']` is the key
 * literal — so component call sites stay typo-safe.
 */
import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // AccountList
  'messages.account_list.accounts': 'Accounts',
  'messages.account_list.loading': 'Loading accounts...',
  'messages.account_list.empty': 'No accounts configured.',

  // AttachmentUpload
  'messages.attachment_upload.drop_files': 'Drop files or click to attach',

  // ComposeForm
  'messages.compose_form.subject_placeholder': 'Subject',
  'messages.compose_form.channel_id_placeholder': 'Channel ID',
  'messages.compose_form.save_draft': 'Save Draft',

  // EmailAccountManager
  'messages.email_account_manager.section_description':
    'Configure email accounts for mailbox access and message routing.',
  'messages.email_account_manager.add_account': '+ Add Account',
  'messages.email_account_manager.mail_account': 'Mail Account',
  'messages.email_account_manager.account_name': 'Account Name',
  'messages.email_account_manager.account_name_placeholder':
    'e.g. Work, Personal',
  'messages.email_account_manager.email_address': 'Email Address',
  'messages.email_account_manager.email_placeholder': 'user@example.com',
  'messages.email_account_manager.incoming_mail': 'Incoming Mail (IMAP)',
  'messages.email_account_manager.imap_host_placeholder': 'imap.example.com',
  'messages.email_account_manager.outgoing_mail': 'Outgoing Mail (SMTP)',
  'messages.email_account_manager.smtp_host_placeholder': 'smtp.example.com',
  'messages.email_account_manager.username_placeholder': 'user@example.com',
  'messages.email_account_manager.connection_successful':
    'Connection successful',
  'messages.email_account_manager.connection_failed': 'Connection failed:',
  'messages.email_account_manager.empty': 'No mail accounts configured yet.',
  'messages.email_account_manager.imap_host_title': 'IMAP: {host}:{port}',
  'messages.email_account_manager.test_connection': 'Test connection',
  'messages.email_account_manager.remove': 'Remove',

  // EmailFilterManager
  'messages.email_filter_manager.whitelist_description':
    'Whitelisted senders bypass blacklist checks and are always allowed through.',
  'messages.email_filter_manager.add_whitelist_entry': 'Add Whitelist Entry',
  'messages.email_filter_manager.category_placeholder': 'e.g. support, sales',
  'messages.email_filter_manager.whitelist_description_placeholder':
    'Why is this entry whitelisted?',
  'messages.email_filter_manager.no_whitelist_entries':
    'No whitelist entries yet.',
  'messages.email_filter_manager.whitelist_remove': 'Remove',
  'messages.email_filter_manager.blacklist_description':
    'Blacklisted senders are automatically blocked or archived.',
  'messages.email_filter_manager.add_blacklist_entry': 'Add Blacklist Entry',
  'messages.email_filter_manager.reason_placeholder':
    'Why is this entry blocked?',
  'messages.email_filter_manager.no_blacklist_entries':
    'No blacklist entries yet.',
  'messages.email_filter_manager.blacklist_remove': 'Remove',

  // ForwardForm
  'messages.forward_form.header': 'Forward message',
  'messages.forward_form.note_placeholder': 'Add a note (optional)...',

  // ReplyForm
  'messages.reply_form.body_placeholder': 'Write your reply...',
});
