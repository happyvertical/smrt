import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  // ContentClaimAuditTool
  'content.claim_audit_tool.save_to_audit_claims':
    'Save this content to audit article claims against evidence.',
  'content.claim_audit_tool.article_claims': 'article claims',
  'content.claim_audit_tool.article_claims_help':
    'Article claims are statements made by this draft. A supported claim has linked source evidence from the references; unsupported means the audit has not found that supporting evidence yet.',
  'content.claim_audit_tool.no_claim_audit_generated':
    'No article claim audit has been generated yet.',
  'content.claim_audit_tool.group_article_claims': '{group} article claims',
  'content.claim_audit_tool.recheck_support': 'Recheck support',
  'content.claim_audit_tool.article_claim_label': 'Article claim:',
  'content.claim_audit_tool.support_assessment_label': 'Support assessment:',
  'content.claim_audit_tool.based_on_source_evidence':
    'Based on source evidence',
  'content.claim_audit_tool.source_claim_label': 'Source claim:',
  'content.claim_audit_tool.based_on_label': 'Based on:',
  'content.claim_audit_tool.no_supporting_source_evidence':
    'No supporting source evidence linked.',

  // ContentCorrectionsTool
  'content.corrections_tool.save_to_issue_corrections':
    'Save this content to issue corrections.',
  'content.corrections_tool.related_fact': 'Related fact',
  'content.corrections_tool.general_correction': 'General correction',
  'content.corrections_tool.corrected_fact_text': 'Corrected fact text',
  'content.corrections_tool.public_note': 'Public note',
  'content.corrections_tool.publish_immediately': 'Publish immediately',
  'content.corrections_tool.published_history': 'Published history',
  'content.corrections_tool.no_corrections_issued': 'No corrections issued.',
  'content.corrections_tool.what_was_wrong': 'What was wrong?',
  'content.corrections_tool.provide_corrected_wording':
    'Provide the corrected claim or wording',
  'content.corrections_tool.optional_public_correction_note':
    'Optional public-facing correction note',

  // ContentGovernanceAssignmentEditor
  'content.governance_assignment_editor.content_type': 'Content type',
  'content.governance_assignment_editor.content_variant': 'Content variant',
  'content.governance_assignment_editor.publication_profile':
    'Publication profile',
  'content.governance_assignment_editor.select_a_profile': 'Select a profile',
  'content.governance_assignment_editor.correction_profile':
    'Correction profile',
  'content.governance_assignment_editor.default_fact_relationship':
    'Default fact relationship',
  'content.governance_assignment_editor.fact_linking': 'Fact linking',
  'content.governance_assignment_editor.enforce_publish_readiness':
    'Enforce publish readiness',
  'content.governance_assignment_editor.save_assignment': 'Save assignment',

  // ContentGovernanceManager
  'content.governance_manager.content_governance': 'Content Governance',
  'content.governance_manager.manage_governed_content':
    'Manage effective policies, profiles, and type assignments for governed content.',
  'content.governance_manager.loading_governance_definitions':
    'Loading governance definitions...',
  'content.governance_manager.add_policy': 'Add policy',
  'content.governance_manager.delete_override': 'Delete override',
  'content.governance_manager.add_profile': 'Add profile',
  'content.governance_manager.add_assignment': 'Add assignment',

  // ContentGovernancePolicyEditor
  'content.governance_policy_editor.save_policy': 'Save policy',

  // ContentGovernanceProfileEditor
  'content.governance_profile_editor.add_requirement': 'Add requirement',
  'content.governance_profile_editor.save_profile': 'Save profile',

  // ContentTransparencyReport
  'content.transparency_report.facts_used': 'facts used',
  'content.transparency_report.references': 'references',
  'content.transparency_report.corrections': 'corrections',
  'content.transparency_report.ai_assisted': 'AI-assisted',
  'content.transparency_report.authored_without_disclosure':
    'Authored without public AI disclosure',
  'content.transparency_report.no_public_prompt_attached':
    'No public prompt was attached to this publication.',
  'content.transparency_report.facts_used_heading': 'Facts Used',
  'content.transparency_report.no_explicit_facts':
    'No explicit facts were marked as used in the article.',
  'content.transparency_report.source_material': 'Source Material',
  'content.transparency_report.no_public_references':
    'No public references are attached to this snapshot.',
  'content.transparency_report.other_extracted_facts': 'Other Extracted Facts',
  'content.transparency_report.no_reviews_captured':
    'No reviews were captured in this snapshot.',
  'content.transparency_report.no_public_corrections':
    'No public corrections have been issued.',
  'content.transparency_report.version_history': 'Version History',
  'content.transparency_report.no_version_history':
    'No version history is attached to this snapshot.',

  // ContentTransparencyTool
  'content.transparency_tool.save_to_preview_transparency':
    'Save this content to preview the public transparency breakdown.',
  'content.transparency_tool.loading_transparency': 'Loading transparency...',
  'content.transparency_tool.transparency_snapshots_not_enabled':
    'Public transparency snapshots are not enabled for this governed content type.',
  'content.transparency_tool.no_transparency_preview':
    'No transparency preview is available yet.',
  'content.transparency_tool.transparency_preview_explainer':
    'The preview below reflects the latest saved article state. The published snapshot stays frozen until the next successful publication.',
  'content.transparency_tool.facts_used': 'Facts used',
  'content.transparency_tool.other_extracted_facts': 'Other extracted facts',
  'content.transparency_tool.public_corrections': 'Public corrections',
  'content.transparency_tool.current_preview': 'Current preview',
  'content.transparency_tool.public_prompt_set':
    'Public prompt is set for publication.',
  'content.transparency_tool.no_public_prompt_exposed':
    'No public prompt is exposed yet.',
  'content.transparency_tool.facts_used_in_article':
    'Facts used in the article',
  'content.transparency_tool.no_used_facts_public':
    'No used facts will be shown publicly yet.',
  'content.transparency_tool.source_material': 'Source material',
  'content.transparency_tool.no_references_public':
    'No references will be shown publicly yet.',
  'content.transparency_tool.reference_fact_counts':
    '{used} used fact(s) · {extracted} extracted fact(s)',
  'content.transparency_tool.latest_published_snapshot':
    'Latest published snapshot',
  'content.transparency_tool.timeline_and_corrections':
    '{events} timeline event(s) and {corrections} public correction(s)',
  'content.transparency_tool.no_published_snapshot':
    'No published transparency snapshot yet. Publish this article to freeze one for the built site.',

  // ContentVersionsTool
  'content.versions_tool.save_to_manage_versions':
    'Save this content to manage versions.',
  'content.versions_tool.no_versions_saved': 'No versions saved yet.',
});
