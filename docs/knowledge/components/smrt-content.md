---
type: "Component"
title: "@happyvertical/smrt-content"
description: "Content processing module for SMRT framework - handles documents, web content, and media"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T19:39:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:7c0bd38205b8152a882926b23dbf427eb1d0394844b8f346aa259bebe3c54d9a"
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
---

# @happyvertical/smrt-content

## Package

- Directory: `packages/content`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/content/AGENTS.md`
- `packages/content/agents/content-list.md`

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

- `create_contentcontributionattachments`: create on `@happyvertical/smrt-content:ContentContributionAttachment`
- `create_contentcontributionattachments`: create on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `create_contentcontributionrevisions`: create on `@happyvertical/smrt-content:ContentContributionRevision`
- `create_contentcontributionrevisions`: create on `@happyvertical/smrt-content:ContentContributionRevisionCollection`
- `create_contentcontributions`: create on `@happyvertical/smrt-content:ContentContribution`
- `create_contentcontributiontypes`: create on `@happyvertical/smrt-content:ContentContributionType`
- `create_contentcontributiontypes`: create on `@happyvertical/smrt-content:ContentContributionTypeCollection`
- `create_contentcontributors`: create on `@happyvertical/smrt-content:ContentContributor`
- `create_contentcontributors`: create on `@happyvertical/smrt-content:ContentContributorCollection`
- `create_contentcorrections`: create on `@happyvertical/smrt-content:ContentCorrection`
- `create_contentcorrections`: create on `@happyvertical/smrt-content:ContentCorrectionCollection`
- `create_contentfeedsources`: create on `@happyvertical/smrt-content:ContentFeedSource`
- `create_contentfeedsources`: create on `@happyvertical/smrt-content:ContentFeedSourceCollection`
- `create_contentgovernanceassignments`: create on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `create_contentgovernanceassignments`: create on `@happyvertical/smrt-content:ContentGovernanceAssignmentCollection`
- `create_contentgovernancepolicies`: create on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `create_contentgovernancepolicies`: create on `@happyvertical/smrt-content:ContentGovernancePolicyCollection`
- `create_contentgovernanceprofiles`: create on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `create_contentgovernanceprofiles`: create on `@happyvertical/smrt-content:ContentGovernanceProfileCollection`
- `create_contentreferences`: create on `@happyvertical/smrt-content:ContentReference`
- `create_contentreferences`: create on `@happyvertical/smrt-content:ContentReferences`
- `create_contentreviews`: create on `@happyvertical/smrt-content:ContentReview`
- `create_contentreviews`: create on `@happyvertical/smrt-content:ContentReviewCollection`
- `create_contents`: create on `@happyvertical/smrt-content:Content`
- `create_contentversions`: create on `@happyvertical/smrt-content:ContentVersion`
- `create_contentversions`: create on `@happyvertical/smrt-content:ContentVersionCollection`
- `delete_contentcontributionattachments`: delete on `@happyvertical/smrt-content:ContentContributionAttachment`
- `delete_contentcontributionattachments`: delete on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `delete_contentcontributionrevisions`: delete on `@happyvertical/smrt-content:ContentContributionRevision`
- `delete_contentcontributionrevisions`: delete on `@happyvertical/smrt-content:ContentContributionRevisionCollection`
- `delete_contentcontributiontypes`: delete on `@happyvertical/smrt-content:ContentContributionType`
- `delete_contentcontributiontypes`: delete on `@happyvertical/smrt-content:ContentContributionTypeCollection`
- `delete_contentcontributors`: delete on `@happyvertical/smrt-content:ContentContributor`
- `delete_contentcontributors`: delete on `@happyvertical/smrt-content:ContentContributorCollection`
- `delete_contentfeedsources`: delete on `@happyvertical/smrt-content:ContentFeedSource`
- `delete_contentfeedsources`: delete on `@happyvertical/smrt-content:ContentFeedSourceCollection`
- `delete_contentgovernanceassignments`: delete on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `delete_contentgovernanceassignments`: delete on `@happyvertical/smrt-content:ContentGovernanceAssignmentCollection`
- `delete_contentgovernancepolicies`: delete on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `delete_contentgovernancepolicies`: delete on `@happyvertical/smrt-content:ContentGovernancePolicyCollection`
- `delete_contentgovernanceprofiles`: delete on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `delete_contentgovernanceprofiles`: delete on `@happyvertical/smrt-content:ContentGovernanceProfileCollection`
- `delete_contentreferences`: delete on `@happyvertical/smrt-content:ContentReference`
- `delete_contentreferences`: delete on `@happyvertical/smrt-content:ContentReferences`
- `getByEmail_contentcontributors`: getByEmail on `@happyvertical/smrt-content:ContentContributorCollection`
- `getByProfileId_contentcontributors`: getByProfileId on `@happyvertical/smrt-content:ContentContributorCollection`
- `getPublishedForContent_contentcorrections`: getPublishedForContent on `@happyvertical/smrt-content:ContentCorrectionCollection`
- `get_contentcontributionattachments`: get on `@happyvertical/smrt-content:ContentContributionAttachment`
- `get_contentcontributionattachments`: get on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `get_contentcontributionrevisions`: get on `@happyvertical/smrt-content:ContentContributionRevision`
- `get_contentcontributionrevisions`: get on `@happyvertical/smrt-content:ContentContributionRevisionCollection`
- `get_contentcontributions`: get on `@happyvertical/smrt-content:ContentContribution`
- `get_contentcontributiontypes`: get on `@happyvertical/smrt-content:ContentContributionType`
- `get_contentcontributiontypes`: get on `@happyvertical/smrt-content:ContentContributionTypeCollection`
- `get_contentcontributors`: get on `@happyvertical/smrt-content:ContentContributor`
- `get_contentcontributors`: get on `@happyvertical/smrt-content:ContentContributorCollection`
- `get_contentcorrections`: get on `@happyvertical/smrt-content:ContentCorrection`
- `get_contentcorrections`: get on `@happyvertical/smrt-content:ContentCorrectionCollection`
- `get_contentfeedsources`: get on `@happyvertical/smrt-content:ContentFeedSource`
- `get_contentfeedsources`: get on `@happyvertical/smrt-content:ContentFeedSourceCollection`
- `get_contentgovernanceassignments`: get on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `get_contentgovernanceassignments`: get on `@happyvertical/smrt-content:ContentGovernanceAssignmentCollection`
- `get_contentgovernancepolicies`: get on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `get_contentgovernancepolicies`: get on `@happyvertical/smrt-content:ContentGovernancePolicyCollection`
- `get_contentgovernanceprofiles`: get on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `get_contentgovernanceprofiles`: get on `@happyvertical/smrt-content:ContentGovernanceProfileCollection`
- `get_contentreferences`: get on `@happyvertical/smrt-content:ContentReference`
- `get_contentreferences`: get on `@happyvertical/smrt-content:ContentReferences`
- `get_contentreviews`: get on `@happyvertical/smrt-content:ContentReview`
- `get_contentreviews`: get on `@happyvertical/smrt-content:ContentReviewCollection`
- `get_contents`: get on `@happyvertical/smrt-content:Content`
- `get_contentversions`: get on `@happyvertical/smrt-content:ContentVersion`
- `get_contentversions`: get on `@happyvertical/smrt-content:ContentVersionCollection`
- `listForContent_contentcorrections`: listForContent on `@happyvertical/smrt-content:ContentCorrectionCollection`
- `listForContribution_contentcontributionattachments`: listForContribution on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `listForRevision_contentcontributionattachments`: listForRevision on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `list_contentcontributionattachments`: list on `@happyvertical/smrt-content:ContentContributionAttachment`
- `list_contentcontributionattachments`: list on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `list_contentcontributionrevisions`: list on `@happyvertical/smrt-content:ContentContributionRevision`
- `list_contentcontributionrevisions`: list on `@happyvertical/smrt-content:ContentContributionRevisionCollection`
- `list_contentcontributions`: list on `@happyvertical/smrt-content:ContentContribution`
- `list_contentcontributiontypes`: list on `@happyvertical/smrt-content:ContentContributionType`
- `list_contentcontributiontypes`: list on `@happyvertical/smrt-content:ContentContributionTypeCollection`
- `list_contentcontributors`: list on `@happyvertical/smrt-content:ContentContributor`
- `list_contentcontributors`: list on `@happyvertical/smrt-content:ContentContributorCollection`
- `list_contentcorrections`: list on `@happyvertical/smrt-content:ContentCorrection`
- `list_contentcorrections`: list on `@happyvertical/smrt-content:ContentCorrectionCollection`
- `list_contentfeedsources`: list on `@happyvertical/smrt-content:ContentFeedSource`
- `list_contentfeedsources`: list on `@happyvertical/smrt-content:ContentFeedSourceCollection`
- `list_contentgovernanceassignments`: list on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `list_contentgovernanceassignments`: list on `@happyvertical/smrt-content:ContentGovernanceAssignmentCollection`
- `list_contentgovernancepolicies`: list on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `list_contentgovernancepolicies`: list on `@happyvertical/smrt-content:ContentGovernancePolicyCollection`
- `list_contentgovernanceprofiles`: list on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `list_contentgovernanceprofiles`: list on `@happyvertical/smrt-content:ContentGovernanceProfileCollection`
- `list_contentreferences`: list on `@happyvertical/smrt-content:ContentReference`
- `list_contentreferences`: list on `@happyvertical/smrt-content:ContentReferences`
- `list_contentreviews`: list on `@happyvertical/smrt-content:ContentReview`
- `list_contentreviews`: list on `@happyvertical/smrt-content:ContentReviewCollection`
- `list_contents`: list on `@happyvertical/smrt-content:Content`
- `list_contentversions`: list on `@happyvertical/smrt-content:ContentVersion`
- `list_contentversions`: list on `@happyvertical/smrt-content:ContentVersionCollection`
- `update_contentcontributionattachments`: update on `@happyvertical/smrt-content:ContentContributionAttachment`
- `update_contentcontributionattachments`: update on `@happyvertical/smrt-content:ContentContributionAttachmentCollection`
- `update_contentcontributionrevisions`: update on `@happyvertical/smrt-content:ContentContributionRevision`
- `update_contentcontributionrevisions`: update on `@happyvertical/smrt-content:ContentContributionRevisionCollection`
- `update_contentcontributions`: update on `@happyvertical/smrt-content:ContentContribution`
- `update_contentcontributiontypes`: update on `@happyvertical/smrt-content:ContentContributionType`
- `update_contentcontributiontypes`: update on `@happyvertical/smrt-content:ContentContributionTypeCollection`
- `update_contentcontributors`: update on `@happyvertical/smrt-content:ContentContributor`
- `update_contentcontributors`: update on `@happyvertical/smrt-content:ContentContributorCollection`
- `update_contentcorrections`: update on `@happyvertical/smrt-content:ContentCorrection`
- `update_contentcorrections`: update on `@happyvertical/smrt-content:ContentCorrectionCollection`
- `update_contentfeedsources`: update on `@happyvertical/smrt-content:ContentFeedSource`
- `update_contentfeedsources`: update on `@happyvertical/smrt-content:ContentFeedSourceCollection`
- `update_contentgovernanceassignments`: update on `@happyvertical/smrt-content:ContentGovernanceAssignment`
- `update_contentgovernanceassignments`: update on `@happyvertical/smrt-content:ContentGovernanceAssignmentCollection`
- `update_contentgovernancepolicies`: update on `@happyvertical/smrt-content:ContentGovernancePolicy`
- `update_contentgovernancepolicies`: update on `@happyvertical/smrt-content:ContentGovernancePolicyCollection`
- `update_contentgovernanceprofiles`: update on `@happyvertical/smrt-content:ContentGovernanceProfile`
- `update_contentgovernanceprofiles`: update on `@happyvertical/smrt-content:ContentGovernanceProfileCollection`
- `update_contentreferences`: update on `@happyvertical/smrt-content:ContentReference`
- `update_contentreferences`: update on `@happyvertical/smrt-content:ContentReferences`
- `update_contentreviews`: update on `@happyvertical/smrt-content:ContentReview`
- `update_contentreviews`: update on `@happyvertical/smrt-content:ContentReviewCollection`
- `update_contents`: update on `@happyvertical/smrt-content:Content`
