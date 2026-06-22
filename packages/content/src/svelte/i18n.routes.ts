/**
 * smrt-content route UI message catalog (S13 #1418).
 * Keys: `content.<route_snake>.<descriptor_snake>`, grouped by route file.
 */
import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // ContentContributionsRoute.svelte
  'content.contributions.eyebrow': 'Content contributions',
  'content.contributions.heading': 'Contribution operations',
  'content.contributions.intro':
    'Manage public intake, contributor records, moderation decisions, and\n          promotion into draft or review-ready content.',
  'content.contributions.nav_aria': 'Content navigation',
  'content.contributions.callout_title': 'Live contribution stack',
  'content.contributions.callout_body':
    'Intake, moderation, and contributor controls against the generated\n            content APIs.',
  'content.contributions.chips_aria': 'Workspace scope',
  'content.contributions.chip_held_intake': 'Held web intake',
  'content.contributions.chip_portal_actions': 'Contributor portal actions',
  'content.contributions.chip_inbox_decisions': 'Editorial inbox decisions',
  'content.contributions.chip_type_trust': 'Type and trust overrides',
  'content.contributions.email_note_prefix':
    'Email ingestion remains available at',
  'content.contributions.email_note_suffix':
    'when message\n        records exist.',
  'content.contributions.loading': 'Loading contribution operations...',
  'content.contributions.latest_action': 'Latest action',
  'content.contributions.submission_title': 'Contributor submission',
  'content.contributions.submission_body':
    'Submit a held contribution through the same generated action\n                your app would call.',
  'content.contributions.portal_title': 'Contributor portal',
  'content.contributions.portal_body':
    'Load a contributor by email to inspect their submissions and\n                withdraw eligible items.',
  'content.contributions.portal_email_placeholder': 'contributor@example.com',
  'content.contributions.inbox_title': 'Editorial inbox',
  'content.contributions.inbox_body':
    'Review held or quarantined submissions and promote them into\n              draft or review content.',
  'content.contributions.types_title': 'Contribution types',
  'content.contributions.types_body':
    'Adjust intake rules, allowed channels, and promotion behavior.',
  'content.contributions.trust_title': 'Contributor trust',
  'content.contributions.trust_body':
    'Set contributor trust levels for moderation and auto-promotion\n                paths.',

  // ContentFactsRoute.svelte
  'content.facts.eyebrow': 'Content facts',
  'content.facts.heading': 'Fact catalog',
  'content.facts.intro':
    'Search the tenant fact index, inspect confidence and domains, and\n          verify what governed content can cite or review against.',
  'content.facts.nav_aria': 'Content navigation',
  'content.facts.create_cta': 'Create Content',
  'content.facts.search_placeholder': 'Search fact text or domain',
  'content.facts.latest_only': 'Latest only',
  'content.facts.include_superseded': 'Include superseded',
  'content.facts.loading': 'Loading facts…',
  'content.facts.empty_title': 'No facts yet',
  'content.facts.empty_body':
    'Once Praeco or other content workflows record facts for this tenant,\n          they will appear here for linking and review.',
  'content.facts.raw_input': 'Raw input',

  // ContentGovernanceRoute.svelte
  'content.governance.eyebrow': 'Content governance',
  'content.governance.heading': 'Governance rules',
  'content.governance.intro':
    'Manage the policies, review profiles, fact-linking settings, and\n          publication rules the workspace applies during authoring.',
  'content.governance.nav_aria': 'Content navigation',
  'content.governance.controls_title': 'What you control here',
  'content.governance.controls_policies':
    'Create and edit review policies, profiles, and type assignments.',
  'content.governance.controls_types':
    'Control which content types require facts, reviews, and transparency.',
  'content.governance.controls_return_prefix': 'Return to the',
  'content.governance.controls_workspace_link': 'content workspace',
  'content.governance.controls_return_suffix':
    'to verify\n          how the current rules affect live authoring and publication.',

  // ContentWorkspaceRoute.svelte
  'content.workspace.eyebrow': 'Content operations',
  'content.workspace.heading': 'Content workspace',
  'content.workspace.intro':
    "Search, edit, and publish the tenant's articles, agendas, documents,\n        and mirrored records from one workspace.",
  'content.workspace.nav_aria': 'Content navigation',
  'content.workspace.stat_total': 'Records in the library',
  'content.workspace.stat_published': 'Published right now',
  'content.workspace.loading': 'Loading contents...',
  'content.workspace.try_again': 'Try again',
  'content.workspace.create_governed': 'Create governed article',
  'content.workspace.review_governance': 'Review governance settings',

  // PublishedArticleRoute.svelte
  'content.published_article.eyebrow': 'Published article',
  'content.published_article.untitled': 'Untitled article',
  'content.published_article.unknown_author': 'Unknown author',
  'content.published_article.empty_copy':
    'This published article does not have a public transparency snapshot yet.',
  'content.published_article.transparency_title': 'How this article was made',
});
