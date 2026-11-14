---
type: "Component"
title: "@happyvertical/smrt-content"
description: "Content processing module for SMRT framework - handles documents, web content, and media"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-12T08:37:29Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:7461555e22eb922236291de5e4a1da83b9c62a24699d09182dd602b06482626f"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/content/package.json"
    title: "@happyvertical/smrt-content package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/content/AGENTS.md"
    title: "@happyvertical/smrt-content packages/content/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/content/agents/content-list.md"
    title: "@happyvertical/smrt-content packages/content/agents/content-list.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/content/agents/optional-capabilities.md"
    title: "@happyvertical/smrt-content packages/content/agents/optional-capabilities.md"
---

# @happyvertical/smrt-content

## Package

- Directory: `packages/content`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/content/AGENTS.md`
- `packages/content/agents/content-list.md`
- `packages/content/agents/optional-capabilities.md`

## Framework dependencies

- [smrt-agents](/components/smrt-agents.md)
- [smrt-assets](/components/smrt-assets.md)
- [smrt-chat](/components/smrt-chat.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-facts](/components/smrt-facts.md)
- [smrt-images](/components/smrt-images.md)
- [smrt-messages](/components/smrt-messages.md)
- [smrt-playground](/components/smrt-playground.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/documents`
- `@happyvertical/files`
- `@happyvertical/geo`
- `@happyvertical/images`
- `@happyvertical/logger`
- `@happyvertical/ocr`
- `@happyvertical/pdf`
- `@happyvertical/spider`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./mock-smrt-client`
- `./playground`
- `./server`
- `./svelte`
- `./ui`
- `./workbench`

## Models

- `Article` (collection `contents`, extends `Content`, STI table)
- `Content` (collection `contents`, extends `SmrtObject`, STI table)
- `ContentAsset` (collection `contentassets`, extends `SmrtObject`)
- `ContentAssetCollection` (collection `contentassets`, extends `SmrtJunction`)
- `ContentContribution` (collection `contentcontributions`, extends `SmrtObject`)
- `ContentContributionAttachment` (collection `contentcontributionattachments`, extends `SmrtObject`)
- `ContentContributionAttachmentCollection` (collection `contentcontributionattachments`, extends `SmrtCollection`)
- `ContentContributionRevision` (collection `contentcontributionrevisions`, extends `SmrtObject`)
- `ContentContributionRevisionCollection` (collection `contentcontributionrevisions`, extends `SmrtCollection`)
- `ContentContributionType` (collection `contentcontributiontypes`, extends `SmrtObject`)
- `ContentContributionTypeCollection` (collection `contentcontributiontypes`, extends `SmrtCollection`)
- `ContentContributions` (collection `contentcontributions`, extends `SmrtCollection`)
- `ContentContributor` (collection `contentcontributors`, extends `SmrtObject`)
- `ContentContributorCollection` (collection `contentcontributors`, extends `SmrtCollection`)
- `ContentCorrection` (collection `contentcorrections`, extends `SmrtObject`)
- `ContentCorrectionCollection` (collection `contentcorrections`, extends `SmrtCollection`)
- `ContentDocument` (collection `contents`, extends `Content`, STI table)
- `ContentFeedSource` (collection `contentfeedsources`, extends `SmrtObject`)
- `ContentFeedSourceCollection` (collection `contentfeedsources`, extends `SmrtCollection`)
- `ContentGovernanceAssignment` (collection `contentgovernanceassignments`, extends `SmrtObject`)
- `ContentGovernanceAssignmentCollection` (collection `contentgovernanceassignments`, extends `SmrtCollection`)
- `ContentGovernancePolicy` (collection `contentgovernancepolicies`, extends `SmrtObject`)
- `ContentGovernancePolicyCollection` (collection `contentgovernancepolicies`, extends `SmrtCollection`)
- `ContentGovernanceProfile` (collection `contentgovernanceprofiles`, extends `SmrtObject`)
- `ContentGovernanceProfileCollection` (collection `contentgovernanceprofiles`, extends `SmrtCollection`)
- `ContentReference` (collection `contentreferences`, extends `SmrtObject`)
- `ContentReferences` (collection `contentreferences`, extends `SmrtJunction`)
- `ContentReview` (collection `contentreviews`, extends `SmrtObject`)
- `ContentReviewCollection` (collection `contentreviews`, extends `SmrtCollection`)
- `ContentVersion` (collection `contentversions`, extends `SmrtObject`)
- `ContentVersionCollection` (collection `contentversions`, extends `SmrtCollection`)
- `Contents` (collection `contents`, extends `SmrtCollection`)
- `Mirror` (collection `contents`, extends `Content`, STI table)

## MCP tools

- `content_create`: create on `@happyvertical/smrt-content:Content`
- `content_get`: get on `@happyvertical/smrt-content:Content`
- `content_list`: list on `@happyvertical/smrt-content:Content`
- `content_update`: update on `@happyvertical/smrt-content:Content`
- `contentcontribution_create`: create on `@happyvertical/smrt-content:ContentContribution`
- `contentcontribution_get`: get on `@happyvertical/smrt-content:ContentContribution`
- `contentcontribution_list`: list on `@happyvertical/smrt-content:ContentContribution`
- `contentcontribution_update`: update on `@happyvertical/smrt-content:ContentContribution`
- `contentcontributionattachment_create`: create on `@happyvertical/smrt-content:ContentContributionAttachment`
- `contentcontributionattachment_delete`: delete on `@happyvertical/smrt-content:ContentContributionAttachment`
- `contentcontributionattachment_get`: get on `@happyvertical/smrt-content:ContentContributionAttachment`
- `contentcontributionattachment_list`: list on `@happyvertical/smrt-content:ContentContributionAttachment`
- `contentcontributionattachment_update`: update on `@happyvertical/smrt-content:ContentContributionAttachment`
- `contentcontributionattachmentcollection_listforcontribution`: listForContribution on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `contentcontributionattachmentcollection_listforrevision`: listForRevision on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `contentcontributionrevision_create`: create on `@happyvertical/smrt-content:ContentContributionRevision`
- `contentcontributionrevision_delete`: delete on `@happyvertical/smrt-content:ContentContributionRevision`
- `contentcontributionrevision_get`: get on `@happyvertical/smrt-content:ContentContributionRevision`
- `contentcontributionrevision_list`: list on `@happyvertical/smrt-content:ContentContributionRevision`
- `contentcontributionrevision_update`: update on `@happyvertical/smrt-content:ContentContributionRevision`
- `contentcontributiontype_create`: create on `@happyvertical/smrt-content:ContentContributionType`
- `contentcontributiontype_delete`: delete on `@happyvertical/smrt-content:ContentContributionType`
- `contentcontributiontype_get`: get on `@happyvertical/smrt-content:ContentContributionType`
- `contentcontributiontype_list`: list on `@happyvertical/smrt-content:ContentContributionType`
- `contentcontributiontype_update`: update on `@happyvertical/smrt-content:ContentContributionType`
- `contentcontributor_create`: create on `@happyvertical/smrt-content:ContentContributor`
- `contentcontributor_delete`: delete on `@happyvertical/smrt-content:ContentContributor`
- `contentcontributor_get`: get on `@happyvertical/smrt-content:ContentContributor`
- `contentcontributor_list`: list on `@happyvertical/smrt-content:ContentContributor`
- `contentcontributor_update`: update on `@happyvertical/smrt-content:ContentContributor`
- `contentcontributorcollection_getbyemail`: getByEmail on `@happyvertical/smrt-content:ContentContributorCollection`
- `contentcontributorcollection_getbyprofileid`: getByProfileId on `@happyvertical/smrt-content:ContentContributorCollection`
- `contentcorrection_create`: create on `@happyvertical/smrt-content:ContentCorrection`
- `contentcorrection_get`: get on `@happyvertical/smrt-content:ContentCorrection`
- `contentcorrection_list`: list on `@happyvertical/smrt-content:ContentCorrection`
- `contentcorrection_update`: update on `@happyvertical/smrt-content:ContentCorrection`
- `contentcorrectioncollection_getpublishedforcontent`: getPublishedForContent on `@happyvertical/smrt-content:ContentCorrectionCollection`
- `contentcorrectioncollection_listforcontent`: listForContent on `@happyvertical/smrt-content:ContentCorrectionCollection`
- `contentfeedsource_create`: create on `@happyvertical/smrt-content:ContentFeedSource`
- `contentfeedsource_delete`: delete on `@happyvertical/smrt-content:ContentFeedSource`
- `contentfeedsource_get`: get on `@happyvertical/smrt-content:ContentFeedSource`
- `contentfeedsource_list`: list on `@happyvertical/smrt-content:ContentFeedSource`
- `contentfeedsource_update`: update on `@happyvertical/smrt-content:ContentFeedSource`
- `contentgovernanceassignment_create`: create on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `contentgovernanceassignment_delete`: delete on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `contentgovernanceassignment_get`: get on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `contentgovernanceassignment_list`: list on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `contentgovernanceassignment_update`: update on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `contentgovernancepolicy_create`: create on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `contentgovernancepolicy_delete`: delete on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `contentgovernancepolicy_get`: get on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `contentgovernancepolicy_list`: list on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `contentgovernancepolicy_update`: update on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `contentgovernanceprofile_create`: create on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `contentgovernanceprofile_delete`: delete on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `contentgovernanceprofile_get`: get on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `contentgovernanceprofile_list`: list on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `contentgovernanceprofile_update`: update on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `contentreference_create`: create on `@happyvertical/smrt-content:ContentReference`
- `contentreference_delete`: delete on `@happyvertical/smrt-content:ContentReference`
- `contentreference_get`: get on `@happyvertical/smrt-content:ContentReference`
- `contentreference_list`: list on `@happyvertical/smrt-content:ContentReference`
- `contentreference_update`: update on `@happyvertical/smrt-content:ContentReference`
- `contentreferences_attach`: attach on `@happyvertical/smrt-content:ContentReferences`
- `contentreferences_byleft`: byLeft on `@happyvertical/smrt-content:ContentReferences`
- `contentreferences_byright`: byRight on `@happyvertical/smrt-content:ContentReferences`
- `contentreferences_detach`: detach on `@happyvertical/smrt-content:ContentReferences`
- `contentreferences_getforsource`: getForSource on `@happyvertical/smrt-content:ContentReferences`
- `contentreferences_getfortarget`: getForTarget on `@happyvertical/smrt-content:ContentReferences`
- `contentreferences_setlinks`: setLinks on `@happyvertical/smrt-content:ContentReferences`
- `contentreferences_unlink`: unlink on `@happyvertical/smrt-content:ContentReferences`
- `contentreview_create`: create on `@happyvertical/smrt-content:ContentReview`
- `contentreview_get`: get on `@happyvertical/smrt-content:ContentReview`
- `contentreview_list`: list on `@happyvertical/smrt-content:ContentReview`
- `contentreview_update`: update on `@happyvertical/smrt-content:ContentReview`
- `contentversion_create`: create on `@happyvertical/smrt-content:ContentVersion`
- `contentversion_get`: get on `@happyvertical/smrt-content:ContentVersion`
- `contentversion_list`: list on `@happyvertical/smrt-content:ContentVersion`
