---
id: relaxed-required-fields
title: Fields smrt no longer requires
sidebar_label: Relaxed required fields
sidebar_position: 6
---

# Fields smrt no longer requires

smrt requires a field only when its own code would be wrong or unsafe without
it ([data shape rules](./data-shape-rules.md), rule 1). The audit of every
required field in a smrt package made the 90 fields below optional. Their
columns lose `NOT NULL` when you run `smrt db:migrate` (on every engine). No
data changes.

If your app relied on one of these fields being required, harden it in a
same-named subclass. For a text field:

```ts
@smrt()
export class Course extends SmrtCourse {
  @field({ required: true })
  override title: string = '';
}
```

A save without a value is then refused in code, and an own-table class gets its
`NOT NULL` back. Details: [data shape rules](./data-shape-rules.md).

Each field below is optional in the built manifest of its package.

## smrt-chat

- `VoiceGatewayTurn`: `gatewaySessionId`

## smrt-comments

- `CommentReport`: `reason`
- `CommentRevision`: `editorUserId`
- `ParticipationBan`: `reason`

## smrt-commerce

- `Agreement`: `customerId`
- `BillingLineSource`: `sellerTenantId`
- `Estimate`: `customerId`
- `Lease`: `customerId`
- `Order`: `customerId`
- `PurchaseOrder`: `vendorId`
- `SupplierQuote`: `vendorId`
- `TenantPaymentWebhookEvent`: `tenantId`
- `WholesaleOrder`: `customerId`

## smrt-content

- `Content`: `name`
- `ContentContribution`: `contributorId`
- `ContentFeedSource`: `name`

## smrt-education

- `CatalogAcquisition`: `sha256`
- `CatalogProvider`: `name`, `providerId`
- `CatalogResource`: `title`
- `CatalogSelection`: `selectedByUserId`
- `Course`: `title`
- `CourseSection`: `title`
- `CourseSource`: `name`
- `Curriculum`: `title`
- `EducationGroup`: `creatorProfileId`, `creatorUserId`
- `GroupLearnerInvitation`: `creatorUserId`
- `GroupLearnerMembership`: `consentParentUserId`
- `GroupRevisionComment`: `authorProfileId`, `authorUserId`
- `GroupSharingPolicy`: `actorUserId`
- `Lesson`: `title`
- `ReleasedLesson`: `sectionId`

## smrt-events

- `EventType`: `name`

## smrt-expenses

- `ExpenseAllocationRevision`: `reviewedByProfileId`, `reviewedByUserId`

## smrt-ingestion

- `IntakeAction`: `resultDigest`
- `IntakeAnalysisAttempt`: `leaseToken`, `outputDigest`, `safeError`
- `IntakeDispatch`: `jobId`
- `IntakeDisposition`: `disposition`
- `IntakeEvidence`: `contentHash`, `mediaType`, `sourceUri`
- `IntakeExecution`: `resultDigest`
- `IntakeItem`: `leaseToken`, `ownerKey`, `sourceVersion`, `traceId`

## smrt-inventory

- `Lot`: `lotNumber`
- `LotCorrection`: `reason`

## smrt-jobs

- `ForgeDelivery`: `eventName`
- `ForgeProjectionCheckpoint`: `deliveryId`
- `SmrtJobEvent`: `message`

## smrt-languages

- `LanguageOverride`: `template`

## smrt-ledgers

- `Ledger`: `name`

## smrt-manufacturing

- `Operation`: `name`
- `RoutingStep`: `operationId`

## smrt-marketing

- `Campaign`: `name`
- `CampaignMetricSnapshot`: `source`

## smrt-messages

- `NotificationDelivery`: `href`, `subject`, `textBody`
- `UserNotification`: `kind`, `title`

## smrt-places

- `PlaceType`: `name`

## smrt-profiles

- `Profile`: `name`
- `ProfileMetadata`: `value`
- `ProfileMetafield`: `name`
- `ProfileRelationshipType`: `name`
- `ProfileType`: `name`

## smrt-projects

- `AssistanceRequestEvent`: `assistanceRequestId`
- `ProjectDecision`: `question`
- `ProjectQuestion`: `prompt`
- `ProjectSpecification`: `title`

## smrt-reactions

- `Poll`: `question`

## smrt-reports

- `SmrtReportRefreshTask`: `reportClass`
- `SmrtReportRun`: `sourceClass`

## smrt-sales

- `CommissionAdjustment`: `reason`
- `EarningEvent`: `eventKind`
- `Lead`: `name`
- `Opportunity`: `name`
- `ReferralClickOperation`: `requestedOccurredAt`

## smrt-social

- `SocialPostAnalyticsSnapshot`: `platform`

## smrt-tags

- `Tag`: `name`

## smrt-users

- `UsersLoginAuditEvent`: `kind`
- `UsersPasskeyCredential`: `name`

## smrt-voice

- `VoiceOutput`: `title`
