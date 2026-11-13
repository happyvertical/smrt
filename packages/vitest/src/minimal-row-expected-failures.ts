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
      model: '@happyvertical/smrt-commerce:Agreement',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:BillingAccount',
      field: 'customerId',
      reason:
        'Model validation rejects empty/default customerId: Billing accounts require a customerId.',
      error: 'Billing accounts require a customerId.',
    },
    {
      model: '@happyvertical/smrt-commerce:BillingPeriodClose',
      field: 'periodEnd',
      reason:
        'Model validation rejects empty/default periodEnd: A billing period must end after it starts.',
      error: 'A billing period must end after it starts.',
    },
    {
      model: '@happyvertical/smrt-commerce:Cart',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:Contract',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:Estimate',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:Invoice',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:Lease',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:LicenseSale',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:Order',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:PaymentAllocation',
      field: 'amount',
      reason:
        'Model validation rejects empty/default amount: PaymentAllocation amount must be a positive number',
      error: 'PaymentAllocation amount must be a positive number',
    },
    {
      model: '@happyvertical/smrt-commerce:Payout',
      field: 'paymentId',
      reason:
        'Model validation rejects empty/default paymentId: a paymentId is required \u2014 a payout must reference the source Payment that funded it (use createFromPayment()).',
      error:
        'a paymentId is required \u2014 a payout must reference the source Payment that funded it (use createFromPayment()).',
    },
    {
      model: '@happyvertical/smrt-commerce:ProductionOrder',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:PurchaseOrder',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:SupplierQuote',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-commerce:TaxComponent',
      field: 'name',
      reason:
        'Model validation rejects empty/default name: Tax component requires a nonempty name',
      error: 'Tax component requires a nonempty name',
    },
    {
      model: '@happyvertical/smrt-commerce:WholesaleOrder',
      field: 'tenantId',
      reason:
        'The model declares optional tenancy, but its money-document save guard requires a tenant.',
      error: 'Commerce money documents require a tenant',
    },
    {
      model: '@happyvertical/smrt-content:Article',
      field: 'title',
      reason:
        'Content.validateBeforeSave() copies required name into optional title; persisted title differs from its empty initialized value.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-content:Content',
      field: 'title',
      reason:
        'Content.validateBeforeSave() copies required name into optional title; persisted title differs from its empty initialized value.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-content:ContentDocument',
      field: 'title',
      reason:
        'Content.validateBeforeSave() copies required name into optional title; persisted title differs from its empty initialized value.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-content:Mirror',
      field: 'title',
      reason:
        'Content.validateBeforeSave() copies required name into optional title; persisted title differs from its empty initialized value.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-education:EducationGroup',
      field: 'name',
      reason:
        'name reaches the empty-name guard at packages/education/src/group-sharing-models.ts:90; packages/education/src/group-sharing-service.ts:52 only displays the name. Retain conservatively until the parent guard and other optional inputs in this minimal-row graph can be audited together; the guard alone is not identity evidence.',
      error: 'Group sharing requires exact identity',
    },
    {
      model: '@happyvertical/smrt-expenses:Expense',
      field: 'currency',
      reason:
        'Expense totals group by currency (ExpenseCollection.ts:346), and commitment/refund guards compare it (Expense.ts:1198,1332); no requiredFor value describes a monetary unit. Keep this exception pending that decision.',
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
    },
    {
      model: '@happyvertical/smrt-facts:Fact',
      field: 'catalogSearch',
      reason:
        'Fact.normalizePersistenceData derives catalogSearch from serialized text (fact.ts:142-149); the helper expects optional defaults to survive, but this read-only column must be recomputed for correct catalog queries. It is not caller-required.',
      error: 'optional field catalogSearch read back populated',
    },
    {
      model: '@happyvertical/smrt-manufacturing:ProductionRun',
      field: 'targetQty',
      reason:
        'ProductionRun.validateBeforeSave rejects targetQty = 0 (ProductionRun.ts); the real decimal initializer is outside this audit, and no reason value expresses a positive planning quantity. Retain the domain-value exception.',
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
      model: '@happyvertical/smrt-projects:Comment',
      field: 'createdAt',
      reason:
        'Nullable createdAt shadows the framework created_at timestamp; validation rejects the missing framework timestamp.',
      error: "Required field 'created_at' is missing for Comment",
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
      model: '@happyvertical/smrt-video:VideoComposition',
      field: 'title',
      reason:
        'Inherited Content.validateBeforeSave (content.ts:932) derives empty title from name. This is framework-maintained compatibility data, not caller-required video identity; changing the owning content package is outside this batch, so retain the populated-optional-field exception.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-video:VideoSequence',
      field: 'title',
      reason:
        'Inherited Content.validateBeforeSave (content.ts:932) derives empty title from name. This is framework-maintained compatibility data, not caller-required video identity; changing the owning content package is outside this batch, so retain the populated-optional-field exception.',
      error: 'optional field title read back populated',
    },
    {
      model: '@happyvertical/smrt-video:VideoShot',
      field: 'title',
      reason:
        'Inherited Content.validateBeforeSave (content.ts:932) derives empty title from name. This is framework-maintained compatibility data, not caller-required video identity; changing the owning content package is outside this batch, so retain the populated-optional-field exception.',
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
        'ContractLineItem code requires tenantId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
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
        'InvoiceLineItem code requires tenantId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
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
        'TaxCode code requires code, name although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
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
      model: '@happyvertical/smrt-commerce:BillingPaymentAttempt',
      kind: 'optional-field',
      field: 'provider, checkoutId',
      error: 'Payment attempts require a provider and checkoutId.',
      reason:
        'BillingPaymentAttempt code requires provider, checkoutId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
    },
    {
      model: '@happyvertical/smrt-content:ContentContributionType',
      kind: 'optional-field',
      field: 'promotion',
      error: 'must define promotion.targetContentType.',
      reason:
        'ContentContributionType code requires promotion although registry metadata allows it empty/default; changing required/NOT NULL would change schema. promotion must contain targetContentType. ',
    },
    {
      model: '@happyvertical/smrt-education:CourseRevision',
      kind: 'optional-field',
      field: 'authorUserId',
      error: 'Revision requires an author',
      reason:
        'CourseRevision.authorUserId is checked by the save guard (course-authoring-models.ts:117) and returned as provenance (course-authoring-service.ts:1461); no key or authorization read was found. Keep until the provenance guard is decided; none of the five reasons justifies that read alone.',
    },
    {
      model: '@happyvertical/smrt-education:LessonRevision',
      kind: 'optional-field',
      field: 'lessonKey',
      error: 'Lesson revision requires a lesson key',
      reason:
        'LessonRevision.lessonKey identifies a conflict-key member (course-authoring-models.ts:147), but a trial required declaration exposed the next optional title guard. Keep the original finding pending a coordinated decision on the remaining guards; the model has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseDraftHead',
      kind: 'optional-field',
      field: 'headRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path headRevisionId.authorUserId reaches the CourseRevision save guard (course-authoring-models.ts:117); its only observed later author read is provenance (course-authoring-service.ts:1461). Keep pending the provenance-guard decision; no identity or authorization dependency was found for the author.',
    },
    {
      model: '@happyvertical/smrt-education:CourseRelease',
      kind: 'optional-field',
      field: 'revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path revisionId.authorUserId reaches the CourseRevision save guard (course-authoring-models.ts:117); its only observed later author read is provenance (course-authoring-service.ts:1461). Keep pending the provenance-guard decision; the model still fails.',
    },
    {
      model: '@happyvertical/smrt-education:ReleasedLesson',
      kind: 'optional-field',
      field: 'releaseId.revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path releaseId.revisionId.authorUserId reaches the CourseRevision save guard (course-authoring-models.ts:117); author is only returned as provenance (course-authoring-service.ts:1461). Nullable section metadata does not repair this independent parent failure.',
    },
    {
      model: '@happyvertical/smrt-education:CourseArchiveDecision',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Archive decision requires an actor',
      reason:
        'actorUserId is checked by the save guard (course-authoring-models.ts:414) and returned in archive history (course-authoring-service.ts:1773), with no authorization or conflict-key read. Keep pending a decision on the provenance-only guard; display alone does not establish a requiredFor reason.',
    },
    {
      model: '@happyvertical/smrt-education:CourseVisibilityChange',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Visibility change requires an actor',
      reason:
        'actorUserId is checked by the save guard (course-authoring-models.ts:465); setVisibility replays by requestKey, visibility and delegationId (course-authoring-service.ts:2528), without reading the stored actor. Keep pending a decision on the provenance-only guard; no permitted reason was established.',
    },
    {
      model: '@happyvertical/smrt-education:CourseCoverChange',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Cover change requires an actor',
      reason:
        'actorUserId is checked by the save guard (course-authoring-models.ts:518); setCover replays by requestKey, assetId and delegationId (course-authoring-service.ts:2741), without reading the stored actor. Keep pending a decision on the provenance-only guard; no permitted reason was established.',
    },
    {
      model: '@happyvertical/smrt-education:CourseDiscardTombstone',
      kind: 'optional-field',
      field: 'actorUserId',
      error: 'Discard requires an actor',
      reason:
        'actorUserId is checked by the save guard (course-authoring-models.ts:565); discard replay checks request_key and delegation_id (course-authoring-service.ts:2889), without reading the stored actor. Keep pending a decision on the provenance-only guard; no permitted reason was established.',
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
        'The stored actor is reauthorized for automatic upgrades (course-authoring-service.ts:3382-3430), so identity applies; a trial required declaration exposed requestKey and policyBasis guards. Keep the original finding until those guards are audited together; the model has not been shown to pass.',
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
        'bundleIdentity is the replay key (course-bundle-service.ts:963-966; course-bundle-models.ts:65), but a trial required declaration exposed the optional readerId guard. Keep pending a coordinated decision on the remaining import guards; the model has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleMember',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'Required-parent path importId.bundleIdentity reaches the import replay identity (course-bundle-models.ts:65); making it required exposes the parent readerId guard. Keep until the import guards are audited together; this child has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleRendering',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'Required-parent path importId.bundleIdentity reaches the import replay identity (course-bundle-models.ts:65); making it required exposes the parent readerId guard. Keep until the import guards are audited together; this child has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleAttachment',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'Required-parent path importId.bundleIdentity reaches the import replay identity (course-bundle-models.ts:65); making it required exposes the parent readerId guard. Keep until the import guards are audited together; this child has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleAudienceChoice',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'Required-parent path importId.bundleIdentity reaches the import replay identity (course-bundle-models.ts:65); making it required exposes the parent readerId guard. Keep until the import guards are audited together; this child has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundlePlacement',
      kind: 'optional-field',
      field: 'key',
      error: 'Placement requires a key',
      reason:
        'key identifies the placement conflict key (course-bundle-models.ts:458) and the part reconciliation lookup (course-bundle-service.ts:2083); a trial required declaration exposed the optional title guard. Keep until that guard is decided; the model has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleUnit',
      kind: 'optional-field',
      field: 'unitKey',
      error: 'Unit requires a key',
      reason:
        'unitKey identifies the transaction lock row (course-bundle-service.ts:2357-2361), but a trial required declaration exposed the optional derived courseId guard. Keep until that guard is decided; the model has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseBundleSupersession',
      kind: 'optional-field',
      field: 'importId.bundleIdentity',
      error: 'Bundle requires an identity',
      reason:
        'Required-parent path importId.bundleIdentity reaches the import replay identity (course-bundle-models.ts:65); making it required exposes the parent readerId guard. Keep until the import guards are audited together; this child has not been shown to pass.',
    },
    {
      model: '@happyvertical/smrt-education:CourseGenerationJob',
      kind: 'optional-field',
      field: 'baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path baseRevisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
    },
    {
      model: '@happyvertical/smrt-education:CourseGenerationEvent',
      kind: 'optional-field',
      field: 'jobId.baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path jobId.baseRevisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
    },
    {
      model: '@happyvertical/smrt-education:CourseProposal',
      kind: 'optional-field',
      field: 'jobId.baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path jobId.baseRevisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
    },
    {
      model: '@happyvertical/smrt-education:CourseProposalDecision',
      kind: 'optional-field',
      field: 'proposalId.jobId.baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path proposalId.jobId.baseRevisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
    },
    {
      model: '@happyvertical/smrt-education:CourseGenerationBriefRecord',
      kind: 'optional-field',
      field: 'jobId.baseRevisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path jobId.baseRevisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
    },
    {
      model: '@happyvertical/smrt-education:CourseReview',
      kind: 'optional-field',
      field: 'revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path revisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
    },
    {
      model: '@happyvertical/smrt-education:CourseReviewFinding',
      kind: 'optional-field',
      field: 'reviewId.revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path reviewId.revisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
    },
    {
      model: '@happyvertical/smrt-education:CourseReviewOutdatedMarker',
      kind: 'optional-field',
      field: 'reviewId.revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path reviewId.revisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
    },
    {
      model: '@happyvertical/smrt-education:CourseFindingResolution',
      kind: 'optional-field',
      field: 'findingId.reviewId.revisionId.authorUserId',
      error: 'Revision requires an author',
      reason:
        'Required-parent path findingId.reviewId.revisionId.authorUserId reaches the empty author guard at packages/education/src/course-authoring-models.ts:117. That guard alone does not justify requiredFor; retain pending audit of the parent snapshot guards, outside this batch.',
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
        'family-intake-models.ts save checks an existing private asset against the intake tenant and owner profile. A required flag alone cannot provide that cross-row ownership match; retain until minimal-row setup can represent the exact shared owner.',
    },
    {
      model: '@happyvertical/smrt-education:GroupLearnerInvitation',
      kind: 'optional-field',
      field: 'groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'groupId.name reaches the empty-name guard at packages/education/src/group-sharing-models.ts:90; packages/education/src/group-sharing-service.ts:52 only displays the name. Retain conservatively until the parent guard and other optional inputs in this minimal-row graph can be audited together; the guard alone is not identity evidence.',
    },
    {
      model: '@happyvertical/smrt-education:GroupLearnerMembership',
      kind: 'optional-field',
      field: 'groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'groupId.name reaches the empty-name guard at packages/education/src/group-sharing-models.ts:90; packages/education/src/group-sharing-service.ts:52 only displays the name. Retain conservatively until the parent guard and other optional inputs in this minimal-row graph can be audited together; the guard alone is not identity evidence.',
    },
    {
      model: '@happyvertical/smrt-education:GroupSharingPolicy',
      kind: 'optional-field',
      field: 'membershipId.groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'membershipId.groupId.name reaches the empty-name guard at packages/education/src/group-sharing-models.ts:90; packages/education/src/group-sharing-service.ts:52 only displays the name. Retain conservatively until the parent guard and other optional inputs in this minimal-row graph can be audited together; the guard alone is not identity evidence.',
    },
    {
      model: '@happyvertical/smrt-education:GroupRevisionComment',
      kind: 'optional-field',
      field: 'membershipId.groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'membershipId.groupId.name reaches the empty-name guard at packages/education/src/group-sharing-models.ts:90; packages/education/src/group-sharing-service.ts:52 only displays the name. Retain conservatively until the parent guard and other optional inputs in this minimal-row graph can be audited together; the guard alone is not identity evidence.',
    },
    {
      model: '@happyvertical/smrt-education:GroupLearnerRosterEntry',
      kind: 'optional-field',
      field: 'groupId.name',
      error: 'Group sharing requires exact identity',
      reason:
        'groupId.name reaches the empty-name guard at packages/education/src/group-sharing-models.ts:90; packages/education/src/group-sharing-service.ts:52 only displays the name. Retain conservatively until the parent guard and other optional inputs in this minimal-row graph can be audited together; the guard alone is not identity evidence.',
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
        'lesson-assets.ts save requires a supported provider, an 11-character YouTube id and a bounded nonempty title; submission-service.ts uses the provider/id for the embed URL. Generic required text does not supply this domain identity, and no allowed reason describes the title-content rule; retain pending a domain-value decision.',
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
        'packages/education/src/question-extraction-service.ts:230-234 keys preserve replays by tenant, intakeItemId and analysisAttemptId; question-extraction-models.ts:117-122 also demands attempt, source identity, digests and actor. Keep this first-failure entry until those optional prerequisites are audited together; promoting intakeItemId alone exposes a different unledgered failure.',
    },
    {
      model: '@happyvertical/smrt-education:ExtractedQuestionLink',
      kind: 'optional-field',
      field: 'extractionId.intakeItemId',
      error: 'Extraction requires an intake item',
      reason:
        'packages/education/src/question-extraction-service.ts:230-234 keys parent extraction replays by intakeItemId and attempt; question-extraction-models.ts:117-122 demands additional optional parent values. Keep the nested first-failure entry until the parent prerequisite chain is audited together.',
    },
    {
      model: '@happyvertical/smrt-education:LearningObjective',
      kind: 'optional-field',
      field: 'externalKey',
      error: 'Objective requires a key',
      reason:
        'packages/education/src/question-authoring-service.ts:778-781 resolves objective identity by tenant and externalKey; question-models.ts:96-97 also demands optional author and requestKey. Keep this first-failure entry pending coordinated audit of those remaining prerequisites; declaring externalKey alone does not make the minimal row pass.',
    },
    {
      model: '@happyvertical/smrt-education:LearningObjectiveRevision',
      kind: 'optional-field',
      field: 'objectiveId.externalKey',
      error: 'Objective requires a key',
      reason:
        'packages/education/src/question-authoring-service.ts:778-781 resolves the parent objective by externalKey; question-models.ts:96-97 demands further optional parent values. Keep the nested first-failure entry until the objective prerequisite chain is audited together.',
    },
    {
      model: '@happyvertical/smrt-education:Question',
      kind: 'optional-field',
      field: 'createdByUserId',
      error: 'Question requires an author',
      reason:
        'packages/education/src/question-models.ts:204 requires author attribution, but repository readers do not use createdByUserId for lookup, authorization or replay; :205 then demands optional requestKey. Keep the entry pending a decision on the author-attribution invariant and audit of the remaining guard; none of the five reasons clearly names attribution alone.',
    },
    {
      model: '@happyvertical/smrt-education:QuestionRevision',
      kind: 'optional-field',
      field: 'questionId.createdByUserId',
      error: 'Question requires an author',
      reason:
        'packages/education/src/question-models.ts:204 requires parent Question author attribution, with no downstream identity, authorization or replay use found; :205 also requires optional requestKey. Keep this nested entry pending the parent attribution decision and remaining-guard audit.',
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
        'packages/education/src/question-models.ts:451 loads lessonRevisionId under the tenant as provenance, but this plain text field has no relationship metadata for the minimal-row parent builder. Keep the entry pending a decision on representing or supplying that exact revision; removing the ownership check would weaken provenance.',
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
        'The Expense parent needs currency for per-currency totals and commitment/refund comparisons (ExpenseCollection.ts:346; Expense.ts:1198,1332); no requiredFor value describes a monetary unit. Required-parent path: sourceExpenseId.',
    },
    {
      model: '@happyvertical/smrt-expenses:ExpenseAllocationPortion',
      kind: 'optional-field',
      field: 'sourceExpenseId.currency',
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
      reason:
        'The Expense parent needs currency for per-currency totals and commitment/refund comparisons (ExpenseCollection.ts:346; Expense.ts:1198,1332); no requiredFor value describes a monetary unit. Required-parent path: sourceExpenseId.',
    },
    {
      model: '@happyvertical/smrt-expenses:ExpenseAllocationBilling',
      kind: 'optional-field',
      field: 'sourceExpenseId.currency',
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
      reason:
        'The Expense parent needs currency for per-currency totals and commitment/refund comparisons (ExpenseCollection.ts:346; Expense.ts:1198,1332); no requiredFor value describes a monetary unit. Required-parent path: sourceExpenseId.',
    },
    {
      model: '@happyvertical/smrt-expenses:ExpenseReceipt',
      kind: 'optional-field',
      field: 'expenseId.currency',
      error:
        "currency must be a three-letter ISO 4217 code (for example 'USD'), got ''.",
      reason:
        'The Expense parent needs currency for per-currency totals and commitment/refund comparisons (ExpenseCollection.ts:346; Expense.ts:1198,1332); no requiredFor value describes a monetary unit. Required-parent path: expenseId.',
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
        'JournalEntry.save loads and locks its parent journal before checking its account scope and nonzero debit/credit. Promoting journalId alone exposes the independent optional accountId failure; the combined parent/account/amount fixture contract remains undecided, with the original error retained.',
    },
    {
      model: '@happyvertical/smrt-manufacturing:ProductionRunCompletion',
      kind: 'optional-field',
      field: 'runId.targetQty',
      error: 'A production run needs a target quantity greater than zero.',
      reason:
        'The required runId parent cannot save with its real targetQty = 0 initializer (ProductionRun.validateBeforeSave); this is the parent planning-quantity exception, not a missing run identity. No reason value expresses that positive quantity.',
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
        'ProjectSpecification code requires actorType, actorId although registry metadata allows it empty/default; changing required/NOT NULL would change schema. ',
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
      model: '@happyvertical/smrt-timesheets:AttendanceSegment',
      kind: 'optional-field',
      field: 'punchId, workRefType, workRefId',
      error: 'Invalid attendance work segment.',
      reason:
        'Segments require a tenant-owned punch, matching parent profileId, and paired work identity; continueSegment reuses stored references. A single-field promotion does not express the parent-derived profile or resume contract. Retain this coupled-field exception pending a complete minimal fixture contract.',
    },
    {
      model: '@happyvertical/smrt-timesheets:AttendanceReplay',
      kind: 'optional-field',
      field: 'outcome',
      error: 'Invalid stored attendance replay outcome.',
      reason:
        'AttendanceReplay.getOutcome fails closed on a receipt lacking a clientId and exactly one success punchId or refusal error. The real JSON initializer {} is outside this audit; no field-level required flag expresses that outcome shape.',
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
