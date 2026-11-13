/** Findings from #4924. Remove entries as their contracts become representable. */
export interface MinimalRowExpectedFailure {
  model: string;
  /** Omitted on original entries: optional-field. All kinds are shrink-only. */
  kind?: 'optional-field' | 'service-only' | 'needs-domain-value';
  field: string;
  reason: string;
  /** Stable error excerpt; a different defect must still fail. */
  error: string;
}

export const minimalRowExpectedFailures: readonly MinimalRowExpectedFailure[] =
  [
    {
      model: '@happyvertical/smrt-commerce:BillingPeriodClose',
      field: 'periodEnd',
      reason:
        'The real epoch defaults satisfy required metadata, but billing/period-close.ts reads the stored end to select carried-forward credits; periodEnd must be later than periodStart, a cross-field date rule that requiredFor cannot express.',
      error: 'A billing period must end after it starts.',
    },
    {
      model: '@happyvertical/smrt-commerce:Invoice',
      field: 'tenantId',
      reason:
        'Invoice money calculation scopes tax reads by tenantId, so tenant-scope fits. A required declaration makes the legacy-money upgrade fixture fail on invoices.tenant_id NOT NULL; correcting that fixture exceeds the permitted test edits, so retain this finding pending that coordinated change.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:PaymentAllocation',
      field: 'amount',
      reason:
        'PaymentAllocation.save() requires a positive safe-integer amount and adds it to both balance caps; the real zero initializer already satisfies required metadata, and none of the five reasons describes a positive monetary amount.',
      error: 'PaymentAllocation amount must be a positive number',
    },
    {
      model: '@happyvertical/smrt-commerce:Payout',
      field: 'paymentId',
      reason:
        'Payout.assertCappedBySourcePayment() loads paymentId and caps remittance by the source Payment. Identity fits, but the plain-string reference cannot supply a resolvable parent in a minimal row; changing the reference contract or fixture is outside this declaration-only audit.',
      error:
        'a paymentId is required \u2014 a payout must reference the source Payment that funded it (use createFromPayment()).',
    },
    {
      model: '@happyvertical/smrt-commerce:TaxComponent',
      field: 'name',
      reason:
        'The name is copied into immutable tax snapshots and DocumentTax rejects empty component snapshots; no reason value describes display/snapshot content. Removing the save guard needs a review of those readers, outside declaration-only edits.',
      error: 'Tax component requires a nonempty name',
    },
    {
      model: '@happyvertical/smrt-education:EducationGroup',
      field: 'name',
      reason:
        'Model validation rejects empty/default name: Group sharing requires exact identity',
      error: 'Group sharing requires exact identity',
    },
    {
      model: '@happyvertical/smrt-expenses:Expense',
      field: 'currency',
      reason:
        "Model validation rejects empty/default currency: currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
    },
    {
      model: '@happyvertical/smrt-facts:Fact',
      field: 'catalogSearch',
      reason:
        'The persistence normalizer fills catalogSearch from required text; the stored search column differs from its empty default.',
      error: 'optional field catalogSearch read back populated',
    },
    {
      model: '@happyvertical/smrt-ledgers:Ledger',
      field: 'name',
      reason:
        'Model validation rejects empty/default name: Ledger name is required',
      error: 'Ledger name is required',
    },
    {
      model: '@happyvertical/smrt-manufacturing:ProductionRun',
      field: 'targetQty',
      reason:
        'Validation requires targetQty > 0 although the field is optional with a default of zero.',
      error: 'A production run needs a target quantity greater than zero.',
    },
    {
      model: '@happyvertical/smrt-messages:NotificationDelivery',
      field: 'recipientUserId',
      reason:
        'Validation requires exactly one typed recipient (user or profile). Neither column can be required alone, so the entry stays (#4935, P9). A populated recipientUserId advances through CRUD.',
      error:
        'Notification requires exactly one matching typed recipient and reserved protected email policy for profiles.',
    },
    {
      model: '@happyvertical/smrt-subscriptions:PriceBook',
      field: 'bookKey',
      reason:
        'Model validation rejects empty/default bookKey: Price books require a bookKey.',
      error: 'Price books require a bookKey.',
    },
    {
      model: '@happyvertical/smrt-subscriptions:SubscriptionPlanVersion',
      field: 'version',
      reason:
        'Model validation rejects empty/default version: Plan version must be a positive integer',
      error: 'Plan version must be a positive integer',
    },
    {
      model: '@happyvertical/smrt-timesheets:AttendancePunch',
      field: 'profileId',
      reason:
        'Model validation rejects empty/default profileId: Attendance requires tenantId and profileId.',
      error: 'Attendance requires tenantId and profileId.',
    },
    {
      model: '@happyvertical/smrt-video:VideoComposition',
      field: 'title',
      reason:
        'Content.validateBeforeSave() copies required name into optional title; persisted title differs from its empty initialized value.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-video:VideoSequence',
      field: 'title',
      reason:
        'Content.validateBeforeSave() copies required name into optional title; persisted title differs from its empty initialized value.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-video:VideoShot',
      field: 'title',
      reason:
        'Content.validateBeforeSave() copies required name into optional title; persisted title differs from its empty initialized value.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-voice:VoiceOutput',
      field: 'title',
      reason:
        'Content.validateBeforeSave() copies required name into optional title; persisted title differs from its empty initialized value.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-approvals:ApprovalEvent',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'ApprovalRequest rows are created only by ApprovalService.requestApproval().',
      reason:
        'ApprovalRequest writes are owned by ApprovalService.requestApproval(); its owner must run once against a minimal row. Required-parent path: requestId.',
    },
    {
      model: '@happyvertical/smrt-approvals:ApprovalPolicy',
      kind: 'needs-domain-value',
      field: 'kind',
      error: "Approval kind 'minimal' is not defined in this process.",
      reason:
        'A kind registered by defineApprovalKind() must exist in this process.',
    },
    {
      model: '@happyvertical/smrt-approvals:ApprovalRequest',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'ApprovalRequest rows are created only by ApprovalService.requestApproval().',
      reason:
        'ApprovalRequest writes are owned by ApprovalService.requestApproval(); its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-comments:ParticipationPolicy',
      kind: 'needs-domain-value',
      field: 'action',
      error: 'Invalid participation policy.',
      reason:
        'action must be comment/react/vote/report; the required string has no declared enum.',
    },
    {
      model: '@happyvertical/smrt-commerce:ContractLineItem',
      kind: 'optional-field',
      field: 'tenantId',
      error: 'Commerce money documents require a tenant',
      reason:
        'Contract money recomputation scopes tax reads by tenantId. Requiring this field alone exposed the omitted contractId (Money parent id must be a nonempty identifier); that unassigned parent field blocks removing this ledger entry under declaration-only scope.',
    },
    {
      model: '@happyvertical/smrt-commerce:DocumentTax',
      kind: 'service-only',
      field: '(service-only write)',
      error: 'DocumentTax rows are derived and cannot be saved directly',
      reason:
        'DocumentTax writes are owned by Commerce document-money commands (saveInvoice/saveInvoiceLineItem); its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-commerce:HistoricalCustomerFunds',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'Historical financial records require their public historical Commerce command',
      reason:
        'HistoricalCustomerFunds writes are owned by recordHistoricalCustomerFunds/refundHistoricalCustomerFunds; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-commerce:HistoricalCustomerFundsAllocation',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'Historical financial records require their public historical Commerce command',
      reason:
        'HistoricalCustomerFundsAllocation writes are owned by recordHistoricalCustomerAllocation/applyHistoricalCustomerFunds; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-commerce:HistoricalSalesLine',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'Historical financial records require their public historical Commerce command',
      reason:
        'HistoricalSalesLine writes are owned by recordHistoricalSalesMoney; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-commerce:InvoiceLineItem',
      kind: 'optional-field',
      field: 'tenantId',
      error: 'Commerce money documents require a tenant',
      reason:
        'Invoice money recomputation scopes tax reads by tenantId. Requiring this field alone exposed the omitted invoiceId (Invoice  was not found); that unassigned parent field blocks removing this ledger entry under declaration-only scope.',
    },
    {
      model: '@happyvertical/smrt-commerce:PurchasePriceObservation',
      kind: 'service-only',
      field: '(service-only write)',
      error: 'Purchase price observations require their owning commands',
      reason:
        'PurchasePriceObservation writes are owned by recordPurchasePriceObservation/completePurchasePriceObservation; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-commerce:TaxCode',
      kind: 'optional-field',
      field: 'code, name',
      error: 'Tax code requires a nonempty code and name',
      reason:
        'code is a tenant conflict key and lookup identity, while name is snapshot/display content with no matching reason. The combined save guard and taxable-component requirement prevent this model passing after a code-only declaration; retain the combined finding pending a wider guard/fixture audit.',
    },
    {
      model: '@happyvertical/smrt-commerce:TaxSummaryReport',
      kind: 'needs-domain-value',
      field: 'tenantId',
      error: 'Tax summary report reads require a tenant context.',
      reason:
        'Reads require an ambient authenticated tenant context, not just a tenantId on the row.',
    },
    {
      model: '@happyvertical/smrt-commerce:TenantPaymentAccount',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'TenantPaymentAccount is written only by the connected-payments commands',
      reason:
        'TenantPaymentAccount writes are owned by onboardTenantPaymentAccount/linkTenantPaymentAccount and the connected-payments account commands; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-commerce:TenantPaymentDispute',
      kind: 'service-only',
      field: '(service-only write)',
      error: 'Disputes are written only by connected-payments commands',
      reason:
        'TenantPaymentDispute writes are owned by handleConnectedPaymentWebhook; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-content:ContentContributionType',
      kind: 'optional-field',
      field: 'promotion',
      error: 'must define promotion.targetContentType.',
      reason:
        'packages/content/src/content-contribution-type.ts:210 and content-contribution.ts:595 require nested promotion.targetContentType to choose the promoted Content subtype. A required string only forbids empty JSON text, not a missing nested target; no reason names promotion configuration, so retain pending a nested-rule/default decision outside declaration-only scope.',
    },
    {
      model: '@happyvertical/smrt-education:CourseRevision',
      kind: 'optional-field',
      field: 'authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:LessonRevision',
      kind: 'optional-field',
      field: 'lessonKey',
      error: 'Lesson revision requires a lesson key',
      reason:
        'packages/education/src/course-authoring-models.ts: LessonRevision requires nonempty lessonKey although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseDraftHead',
      kind: 'optional-field',
      field: 'headRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseRelease',
      kind: 'optional-field',
      field: 'revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:ReleasedLesson',
      kind: 'optional-field',
      field: 'releaseId.revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseArchiveDecision',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Archive decision requires an actor',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseArchiveDecision requires nonempty actorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseVisibilityChange',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Visibility change requires an actor',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseVisibilityChange requires nonempty actorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseCoverChange',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Cover change requires an actor',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseCoverChange requires nonempty actorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseDiscardTombstone',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Discard requires an actor',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseDiscardTombstone requires nonempty actorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:EnrollmentReleasePin',
      kind: 'needs-domain-value',
      field:
        'enrollmentId.curriculumId.learnerId.userId, enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:CourseUpgradeChoice',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Upgrade choice requires an actor',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseUpgradeChoice requires nonempty actorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:EnrollmentAutoUpgradeSkip',
      kind: 'needs-domain-value',
      field:
        'enrollmentId.curriculumId.learnerId.userId, enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:EnrollmentAssignmentRecord',
      kind: 'needs-domain-value',
      field:
        'enrollmentId.curriculumId.learnerId.userId, enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:CurriculumCreationRecord',
      kind: 'needs-domain-value',
      field: 'curriculumId.learnerId.userId, curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleImport',
      kind: 'optional-field',
      field: 'bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'packages/education/src/course-bundle-models.ts: CourseBundleImport requires nonempty bundleIdentity although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleMember',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'packages/education/src/course-bundle-models.ts: CourseBundleImport requires nonempty bundleIdentity although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleRendering',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'packages/education/src/course-bundle-models.ts: CourseBundleImport requires nonempty bundleIdentity although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleAttachment',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'packages/education/src/course-bundle-models.ts: CourseBundleImport requires nonempty bundleIdentity although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleAudienceChoice',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'packages/education/src/course-bundle-models.ts: CourseBundleImport requires nonempty bundleIdentity although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundlePlacement',
      kind: 'optional-field',
      field: 'key',
      error: 'Placement requires a key',
      reason:
        'packages/education/src/course-bundle-models.ts: CourseBundlePlacement requires nonempty key although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleUnit',
      kind: 'optional-field',
      field: 'unitKey',
      error: 'Unit requires a key',
      reason:
        'packages/education/src/course-bundle-models.ts: CourseBundleUnit requires nonempty unitKey although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleSupersession',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'packages/education/src/course-bundle-models.ts: CourseBundleImport requires nonempty bundleIdentity although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseGenerationJob',
      kind: 'optional-field',
      field: 'baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseGenerationEvent',
      kind: 'optional-field',
      field: 'jobId.baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseProposal',
      kind: 'optional-field',
      field: 'jobId.baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseProposalDecision',
      kind: 'optional-field',
      field: 'proposalId.jobId.baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseGenerationBriefRecord',
      kind: 'optional-field',
      field: 'jobId.baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseReview',
      kind: 'optional-field',
      field: 'revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseReviewFinding',
      kind: 'optional-field',
      field: 'reviewId.revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseReviewOutdatedMarker',
      kind: 'optional-field',
      field: 'reviewId.revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:CourseFindingResolution',
      kind: 'optional-field',
      field: 'findingId.reviewId.revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'packages/education/src/course-authoring-models.ts: CourseRevision requires nonempty authorUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:EnrollmentParentNote',
      kind: 'needs-domain-value',
      field:
        'enrollmentId.curriculumId.learnerId.userId, enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:FamilyIntakeAsset',
      kind: 'optional-field',
      field: 'assetId, intakeId.ownerProfileId',
      error: 'Family original ownership mismatch',
      reason:
        'FamilyIntakeAsset code requires assetId, intakeId.ownerProfileId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-education:GroupLearnerInvitation',
      kind: 'optional-field',
      field: 'groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'EducationGroup identity guard requires nonempty name despite optional metadata. Required-parent path: groupId.',
    },
    {
      model: '@happyvertical/smrt-education:GroupLearnerMembership',
      kind: 'optional-field',
      field: 'groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'EducationGroup identity guard requires nonempty name despite optional metadata. Required-parent path: groupId.',
    },
    {
      model: '@happyvertical/smrt-education:GroupSharingPolicy',
      kind: 'optional-field',
      field: 'membershipId.groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'EducationGroup identity guard requires nonempty name despite optional metadata. Required-parent path: membershipId.groupId.',
    },
    {
      model: '@happyvertical/smrt-education:GroupRevisionComment',
      kind: 'optional-field',
      field: 'membershipId.groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'EducationGroup identity guard requires nonempty name despite optional metadata. Required-parent path: membershipId.groupId.',
    },
    {
      model: '@happyvertical/smrt-education:GroupLearnerRosterEntry',
      kind: 'optional-field',
      field: 'groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'EducationGroup identity guard requires nonempty name despite optional metadata. Required-parent path: groupId.',
    },
    {
      model: '@happyvertical/smrt-education:LessonProgressTransition',
      kind: 'needs-domain-value',
      field:
        'progressId.enrollmentId.curriculumId.learnerId.userId, progressId.enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: progressId.enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:EnrollmentStatusChange',
      kind: 'needs-domain-value',
      field:
        'enrollmentId.curriculumId.learnerId.userId, enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:LessonCompletionRecord',
      kind: 'needs-domain-value',
      field:
        'progressId.enrollmentId.curriculumId.learnerId.userId, progressId.enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: progressId.enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:EnrollmentPaceChange',
      kind: 'needs-domain-value',
      field:
        'enrollmentId.curriculumId.learnerId.userId, enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:LearnerInterestThemeChange',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:Learner',
      kind: 'needs-domain-value',
      field: 'userId, profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge.',
    },
    {
      model: '@happyvertical/smrt-education:Curriculum',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:Enrollment',
      kind: 'needs-domain-value',
      field: 'curriculumId.learnerId.userId, curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:LessonProgress',
      kind: 'needs-domain-value',
      field:
        'enrollmentId.curriculumId.learnerId.userId, enrollmentId.curriculumId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: enrollmentId.curriculumId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:LessonAsset',
      kind: 'needs-domain-value',
      field: 'relationship',
      error: 'Unknown material role',
      reason:
        'Needs a supported material role such as attachment; required relationship is text without an enum.',
    },
    {
      model: '@happyvertical/smrt-education:CourseAsset',
      kind: 'needs-domain-value',
      field: 'relationship',
      error: 'Unknown material role',
      reason:
        'Needs a supported material role such as attachment; required relationship is text without an enum.',
    },
    {
      model: '@happyvertical/smrt-education:LessonExternalVideo',
      kind: 'optional-field',
      field: 'provider, videoId, title',
      error: 'Invalid external video reference',
      reason:
        'LessonExternalVideo code requires provider, videoId, title although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-education:LessonPage',
      kind: 'optional-field',
      field: 'pageKey',
      error: 'Invalid lesson page',
      reason:
        'LessonPage code requires pageKey although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-education:WorkCompletionDecision',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:LessonActivity',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:LessonWorkFiling',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:WorkAttempt',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:WorkAssessmentRevision',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:WorkFeedbackRelease',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:WorkFeedbackDelivery',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:QuestionExtractionRecord',
      kind: 'optional-field',
      field: 'intakeItemId',
      error: 'Extraction requires an intake item',
      reason:
        'packages/education/src/question-extraction-models.ts: QuestionExtractionRecord requires nonempty intakeItemId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:ExtractedQuestionLink',
      kind: 'optional-field',
      field: 'extractionId.intakeItemId',
      error: 'Extraction requires an intake item',
      reason:
        'packages/education/src/question-extraction-models.ts: QuestionExtractionRecord requires nonempty intakeItemId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:LearningObjective',
      kind: 'optional-field',
      field: 'externalKey',
      error: 'Objective requires a key',
      reason:
        'packages/education/src/question-models.ts: LearningObjective requires nonempty externalKey although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:LearningObjectiveRevision',
      kind: 'optional-field',
      field: 'objectiveId.externalKey',
      error: 'Objective requires a key',
      reason:
        'packages/education/src/question-models.ts: LearningObjective requires nonempty externalKey although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:Question',
      kind: 'optional-field',
      field: 'createdByUserId',
      error: 'Question requires an author',
      reason:
        'packages/education/src/question-models.ts: Question requires nonempty createdByUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:QuestionRevision',
      kind: 'optional-field',
      field: 'questionId.createdByUserId',
      error: 'Question requires an author',
      reason:
        'packages/education/src/question-models.ts: Question requires nonempty createdByUserId although metadata permits empty/default. Changing required/NOT NULL would change schema.',
    },
    {
      model: '@happyvertical/smrt-education:QuestionResponse',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:GeneratedPrintable',
      kind: 'optional-field',
      field: 'lessonRevisionId',
      error: 'Question record parent ownership mismatch',
      reason:
        'GeneratedPrintable code requires lessonRevisionId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-education:Submission',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:SubmissionIntakeBinding',
      kind: 'needs-domain-value',
      field: 'submissionId.learnerId.userId, submissionId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: submissionId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:ScannedSubmission',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:ExternalCompletion',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:Attestation',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:LessonSelfAttestation',
      kind: 'needs-domain-value',
      field: 'submissionId.learnerId.userId, submissionId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: submissionId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:SubmissionAsset',
      kind: 'needs-domain-value',
      field: 'submissionId.learnerId.userId, submissionId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: submissionId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:Grade',
      kind: 'needs-domain-value',
      field: 'submissionId.learnerId.userId, submissionId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: submissionId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:TutorSession',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:TutorSessionClosure',
      kind: 'needs-domain-value',
      field: 'sessionId.learnerId.userId, sessionId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: sessionId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:TutorExchange',
      kind: 'needs-domain-value',
      field: 'sessionId.learnerId.userId, sessionId.learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: sessionId.learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:WorkbookPhotoIntake',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:WorkbookPhotoAsset',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:WorkbookPhotoDecision',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-education:BookContextRevision',
      kind: 'needs-domain-value',
      field: 'learnerId.userId, learnerId.profileId',
      error:
        'Learner requires a linked user/profile and active tenant membership',
      reason:
        'Needs a User linked to the same Person profile and an active Membership for the tenant. Registry relationships name Profile, not Person, and do not express the Membership edge. Required-parent path: learnerId.',
    },
    {
      model: '@happyvertical/smrt-expenses:ExpenseAllocationRevision',
      kind: 'optional-field',
      field: 'sourceExpenseId.currency',
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
      reason:
        'Expense guard requires nonempty currency despite optional metadata. Required-parent path: sourceExpenseId.',
    },
    {
      model: '@happyvertical/smrt-expenses:ExpenseAllocationPortion',
      kind: 'optional-field',
      field: 'sourceExpenseId.currency',
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
      reason:
        'Expense guard requires nonempty currency despite optional metadata. Required-parent path: sourceExpenseId.',
    },
    {
      model: '@happyvertical/smrt-expenses:ExpenseAllocationBilling',
      kind: 'optional-field',
      field: 'sourceExpenseId.currency',
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
      reason:
        'Expense guard requires nonempty currency despite optional metadata. Required-parent path: sourceExpenseId.',
    },
    {
      model: '@happyvertical/smrt-expenses:ExpenseReceipt',
      kind: 'optional-field',
      field: 'expenseId.currency',
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
      reason:
        'Expense guard requires nonempty currency despite optional metadata. Required-parent path: expenseId.',
    },
    {
      model: '@happyvertical/smrt-fields:FieldPolicy',
      kind: 'needs-domain-value',
      field: 'objectRef',
      error: "Permission denied for 'fields.policy.manage'.",
      reason:
        'Needs an authenticated tenant context with fields.policy.manage permission and a registered qualified objectRef.',
    },
    {
      model: '@happyvertical/smrt-fields:FieldPolicySuggestion',
      kind: 'needs-domain-value',
      field: 'objectRef',
      error: 'Field policy objectRef must be a qualified class name',
      reason:
        'Needs a registered qualified class name, not an arbitrary required string.',
    },
    {
      model: '@happyvertical/smrt-fields:FieldUsageCounter',
      kind: 'needs-domain-value',
      field: 'period',
      error: 'FieldUsageCounter.period must be a UTC day bucket',
      reason: 'Needs a UTC YYYY-MM-DD day bucket; metadata only declares text.',
    },
    {
      model: '@happyvertical/smrt-human-resources:Employment',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'Employment columns owned by the HR package are writable only through EmploymentService.',
      reason:
        'Employment writes are owned by EmploymentService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-human-resources:EmploymentTerm',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'HR records are writable only through EmploymentService and QualificationService.',
      reason:
        'EmploymentTerm writes are owned by EmploymentService and QualificationService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-human-resources:EmploymentChange',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'HR records are writable only through EmploymentService and QualificationService.',
      reason:
        'EmploymentChange writes are owned by EmploymentService and QualificationService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-human-resources:Qualification',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'HR records are writable only through EmploymentService and QualificationService.',
      reason:
        'Qualification writes are owned by EmploymentService and QualificationService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-human-resources:HeldQualification',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'HR records are writable only through EmploymentService and QualificationService.',
      reason:
        'HeldQualification writes are owned by EmploymentService and QualificationService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-human-resources:HeldQualificationChange',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'HR records are writable only through EmploymentService and QualificationService.',
      reason:
        'HeldQualificationChange writes are owned by EmploymentService and QualificationService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-inference:InferenceOverride',
      kind: 'needs-domain-value',
      field: 'binding',
      error: 'unknown binding id',
      reason: 'Needs an inference binding registered by the host.',
    },
    {
      model: '@happyvertical/smrt-ledgers:JournalEntry',
      kind: 'optional-field',
      field: 'journalId',
      error: 'Journal entry requires an accessible parent journal',
      reason:
        'JournalEntry code requires journalId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-manufacturing:ProductionRunCompletion',
      kind: 'optional-field',
      field: 'runId.targetQty',
      error: 'A production run needs a target quantity greater than zero.',
      reason:
        'ProductionRun requires positive targetQty despite optional metadata. Required-parent path: runId.',
    },
    {
      model: '@happyvertical/smrt-playbooks:PlaybookOverride',
      kind: 'needs-domain-value',
      field: 'key',
      error: 'Unknown playbook key "minimal"',
      reason: 'Needs a host-registered playbook key.',
    },
    {
      model: '@happyvertical/smrt-preferences:UiPreferenceRecord',
      kind: 'needs-domain-value',
      field: 'tenantId',
      error: 'User-interface preferences need an authenticated tenant context',
      reason:
        'Needs an authenticated active tenant context plus a registered preference kind.',
    },
    {
      model: '@happyvertical/smrt-profiles:ProfileLink',
      kind: 'needs-domain-value',
      field: 'platform',
      error: 'Unknown profile link platform: minimal',
      reason:
        'Needs a supported profile-link platform; the required string has no enum.',
    },
    {
      model: '@happyvertical/smrt-projects:ProjectSpecification',
      kind: 'optional-field',
      field: 'actorType, actorId',
      error: 'Project specification actor is required.',
      reason:
        'packages/projects/src/models/ProjectSpecification.ts:68-72 requires a valid actor type and nonempty actor id together, but stored actors are provenance only: project-specification-service.ts:74 authorizes the incoming actor.canManage, never these fields. No demonstrated stored-row dependency supports a reason; retain pending a decision on the runtime guard outside declaration-only scope.',
    },
    {
      model: '@happyvertical/smrt-prompts:PromptOverride',
      kind: 'needs-domain-value',
      field: 'key',
      error: 'Unknown prompt key "minimal"',
      reason: 'Needs a host-registered prompt key.',
    },
    {
      model: '@happyvertical/smrt-reactions:Poll',
      kind: 'service-only',
      field: '(service-only write)',
      error: 'Participation records require service write authority.',
      reason:
        'Poll writes are owned by PollService (ParticipationRuntime.polls); its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-reactions:PollVote',
      kind: 'service-only',
      field: '(service-only write)',
      error: 'Participation records require service write authority.',
      reason:
        'Poll writes are owned by PollService (ParticipationRuntime.polls); its owner must run once against a minimal row. Required-parent path: pollId.',
    },
    {
      model: '@happyvertical/smrt-reactions:Reaction',
      kind: 'service-only',
      field: '(service-only write)',
      error: 'Participation records require service write authority.',
      reason:
        'Reaction writes are owned by ReactionService (ParticipationRuntime.reactions); its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-reports:RuntimeReport',
      kind: 'needs-domain-value',
      field: 'spec',
      error: 'spec is not valid JSON',
      reason:
        'Needs a valid serialized RuntimeReportSpec, not an arbitrary required string.',
    },
    {
      model: '@happyvertical/smrt-sales:SalesGovernanceEvent',
      kind: 'service-only',
      field: '(service-only write)',
      error: 'Sales governance state is service-owned',
      reason:
        'SalesGovernanceEvent writes are owned by SalesGovernanceService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-sales:SalesGovernanceState',
      kind: 'service-only',
      field: '(service-only write)',
      error: 'Sales governance state is service-owned',
      reason:
        'SalesGovernanceState writes are owned by SalesGovernanceService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-subscriptions:TenantSubscription',
      kind: 'optional-field',
      field: 'planId',
      error: 'Subscription plan is unavailable',
      reason:
        'TenantSubscription code requires planId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-subscriptions:CreditGrant',
      kind: 'optional-field',
      field: 'amount',
      error:
        'Credit grant amounts must be nonzero integer minor units (cents).',
      reason:
        'CreditGrant code requires amount although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-timesheets:AttendanceCorrection',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'Attendance corrections are writable only through AttendanceCorrectionService.',
      reason:
        'AttendanceCorrection writes are owned by AttendanceCorrectionService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-timesheets:AttendanceBreak',
      kind: 'optional-field',
      field: 'punchId',
      error: 'Invalid attendance break.',
      reason:
        'AttendanceBreak code requires punchId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-timesheets:AttendanceSegment',
      kind: 'optional-field',
      field: 'punchId, workRefType, workRefId',
      error: 'Invalid attendance work segment.',
      reason:
        'AttendanceSegment code requires punchId, workRefType, workRefId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-timesheets:AttendanceReplay',
      kind: 'optional-field',
      field: 'outcome',
      error: 'Invalid stored attendance replay outcome.',
      reason:
        'AttendanceReplay code requires outcome although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-timesheets:PeriodTimecard',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'Timecards and adjustments are writable only through PeriodRollupService.',
      reason:
        'PeriodTimecard writes are owned by PeriodRollupService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-timesheets:TimecardAdjustment',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'Timecards and adjustments are writable only through PeriodRollupService.',
      reason:
        'TimecardAdjustment writes are owned by PeriodRollupService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-timesheets:TimecardReopening',
      kind: 'service-only',
      field: '(service-only write)',
      error:
        'Timecards and adjustments are writable only through PeriodRollupService.',
      reason:
        'TimecardReopening writes are owned by PeriodRollupService; its owner must run once against a minimal row.',
    },
    {
      model: '@happyvertical/smrt-webhooks:WebhookSubscription',
      kind: 'needs-domain-value',
      field: 'url',
      error: 'Webhook URL must be an absolute HTTPS URL.',
      reason: 'Needs an absolute HTTPS URL; metadata only declares text.',
    },
  ];
