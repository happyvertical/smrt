import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // ArticleList
  'content.article_list.aria_label': 'Articles',

  // ContentContributionForm
  'content.contribution_form.heading': 'Submit a contribution',
  'content.contribution_form.contribution_type': 'Contribution type',
  'content.contribution_form.attach_files': 'Attach files',

  // ContentContributionInbox
  'content.contribution_inbox.heading': 'Contribution inbox',
  'content.contribution_inbox.intro':
    'Review held submissions, request changes, or promote them into editorial content.',
  'content.contribution_inbox.promoted_content': 'Promoted content',
  'content.contribution_inbox.intake_decision': 'Intake decision',
  'content.contribution_inbox.editorial_note': 'Editorial note',
  'content.contribution_inbox.promote_to': 'Promote to',
  'content.contribution_inbox.request_changes': 'Request changes',

  // ContentContributionPortal
  'content.contribution_portal.heading': 'Your contributions',
  'content.contribution_portal.intro':
    'Track the status of your submissions and follow up when editors request changes.',
  'content.contribution_portal.editor_notes': 'Editor notes',
  'content.contribution_portal.withdraw_submission': 'Withdraw submission',

  // ContentContributionTypeManager
  'content.contribution_type_manager.heading': 'Contribution types',
  'content.contribution_type_manager.intro':
    'Configure what contributors can send, where it promotes, and which intake rules apply.',
  'content.contribution_type_manager.add_type': 'Add type',
  'content.contribution_type_manager.allow_text': 'Allow text',
  'content.contribution_type_manager.allow_files': 'Allow files',
  'content.contribution_type_manager.allow_empty_text': 'Allow empty text',
  'content.contribution_type_manager.promotion_content_type':
    'Promotion content type',
  'content.contribution_type_manager.promotion_variant': 'Promotion variant',
  'content.contribution_type_manager.promotion_status': 'Promotion status',
  'content.contribution_type_manager.auto_promote_trusted':
    'Auto-promote trusted',
  'content.contribution_type_manager.create_assets_on_promotion':
    'Create assets on promotion',
  'content.contribution_type_manager.trusted_contributors_only':
    'Trusted contributors only',
  'content.contribution_type_manager.max_files': 'Max files',
  'content.contribution_type_manager.max_total_bytes': 'Max total bytes',
  'content.contribution_type_manager.allowed_mime_patterns':
    'Allowed MIME patterns',
  'content.contribution_type_manager.allowed_mime_patterns_placeholder':
    'image/*, video/mp4',
  'content.contribution_type_manager.blocked_mime_patterns':
    'Blocked MIME patterns',
  'content.contribution_type_manager.quarantine_mime_patterns':
    'Quarantine MIME patterns',
  'content.contribution_type_manager.blocked_text_patterns':
    'Blocked text patterns',
  'content.contribution_type_manager.quarantine_text_patterns':
    'Quarantine text patterns',
  'content.contribution_type_manager.save_type': 'Save type',

  // ContentContributorManager
  'content.contributor_manager.intro':
    'Manage contributor trust levels for intake queue bypass and moderation.',
  'content.contributor_manager.add_contributor': 'Add contributor',
  'content.contributor_manager.trust_level': 'Trust level',
  'content.contributor_manager.save_contributor': 'Save contributor',

  // ContentList
  'content.content_list.search_placeholder': 'Search contents...',
  'content.content_list.all_types': 'All Types',
  'content.content_list.all_statuses': 'All Statuses',
  'content.content_list.grid_view': 'Grid View',
  'content.content_list.detailed_list': 'Detailed List',
  'content.content_list.compact_list': 'Compact List',
  'content.content_list.add_content': 'Add Content',
  'content.content_list.empty': 'No contents match your filters.',
  'content.content_list.view_published_article': 'View published article',
  'content.content_list.edit': 'Edit',
  'content.content_list.delete': 'Delete',
  'content.content_list.delete_confirm_title': 'Delete content?',
  'content.content_list.delete_confirm_message':
    'Are you sure you want to delete "{title}"? This cannot be undone.',
  'content.content_list.cancel': 'Cancel',
  'content.content_list.source_material': 'Source material',
  'content.content_list.view_article': 'View article',
  'content.content_list.view_article_button': 'View Article',
});
