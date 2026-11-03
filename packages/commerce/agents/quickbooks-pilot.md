# QuickBooks invoice pilot (#4621)

The pilot is disabled by default. The trusted server host explicitly calls
`runQuickBooksPilot` with a sandbox-scoped deterministic fixture. Commerce
accepts no credentials or production mappings at this entry point. The
existing generic accounting APIs and manual QuickBooks invoicing remain
separate entry points.

1. The host records operator approval and customer acceptance of the exact
   quote version, including lines, discounts, tax, rounding and due terms.
   Prepare the issued Commerce invoice at
   `quickBooksPilotInvoiceId(tenantId, obligationId)` and associate the
   accepted version with its frozen `moneySnapshotId`. The host is responsible
   for proving authorization and the accepted quote-to-invoice correspondence.
   A quote revision does not create another obligation ID.
2. Pass that acceptance, the reviewed QuickBooks customer, Item and tax
   mapping, and a fixture scoped to the active tenant, realm and sandbox.
   `issue` reserves one frozen accounting create and verifies provider identity,
   currency, subtotal, discount, tax, total and due date before saving the
   binding. Exact money checks use integer minor units.
3. An authorized operator can use `link` with the ID of an already-issued
   QuickBooks invoice. The operator reviews the link against the accepted
   version, then Commerce verifies readback and records the same durable
   binding. A subsequent `issue` reads the bound invoice. An unresolved create
   requires `recover`, which accepts only a verified match for its persisted
   request ID and payload hash. Interrupted owners must first be stopped.
   Missing or ambiguous evidence leaves the original reservation in place.
4. Call `poll` to reconcile current invoice and complete linked transaction
   evidence. The fixture supplies the exact amount attributable to this
   invoice for each payment, credit application and refund. The result exposes
   those separate amounts alongside balance and void status. A balance of zero
   alone cannot prove payment. Inconsistent or incomplete readback throws and
   preserves the last successful projection. Read that projection and its
   observation time using `readFrozenAccountingSyncState`. Poll triggers carry
   no settlement data, so duplicate or out-of-order triggers read current
   evidence each time. The pilot projection is for reporting and does not post
   local accounting payments or mutate booking status.

The fixture reads during manual linking, recovery and polling run under the
same tenant and invoice locks as binding. Any later network implementation
needs a separately reviewed transport and concurrency policy.

## Provider capability matrix

| Capability | Primary evidence | Pilot disposition |
| --- | --- | --- |
| Canadian invoice payment | [Intuit Canada invoice payment](https://quickbooks.intuit.com/learn-support/en-ca/help-article/invoicing/take-process-payments-quickbooks-online/L2vHwwVmh_CA_en_CA) describes card, Apple Pay and bank payment. [Intuit Canada settings](https://quickbooks.intuit.com/learn-support/en-ca/help-article/invoicing/troubleshooting-canada-merchant-services-issues/L9jwTHfgx_CA_en_CA) describes merchant configuration and online delivery. | Merchant activation, methods, company region and payable delivery require authorized account evidence. |
| Invoice create and duplicate request | [Intuit error 600](https://static.developer.intuit.com/output_html/qbo/docs/develop/troubleshooting/error-codes.html) documents duplicate request IDs. The installed public accounting SDK prepares a payload hash and forwards the request ID. | Fixture verifies create and ambiguous recovery. A stable API lookup by request ID and hash is unverified. Customer, amount and time are investigation clues only. |
| Invoice options, hosted link and email | [Intuit invoice reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice) and [Intuit Canada hosted invoice](https://quickbooks.intuit.com/learn-support/en-ca/help-article/invoicing/pay-invoice-using-bank-payments/L8T7x9nDA_CA_en_CA). The installed SDK exposes invoice send. | The pilot does not call send. Prove that the company can issue a payable invoice before enabling email. SDK support for setting online payment flags or retrieving a hosted link is unverified. |
| Invoice and linked money | [Intuit Payment reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment) and [Intuit V3 LinkedTxn schema](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippphpdevkitv3/entities/files/IPPLinkedTxn.html). The installed public accounting SDK exposes invoice pull, invoice void, payments and credit operations. | Exact payment allocation, applied credits, attributed refunds and void readback are fixture evidence. Verify how the pilot company exposes the original invoice amounts after void and invoice attribution for refunds. Zero balance alone is insufficient. |
| Webhooks | [Intuit event configuration](https://static.developer.intuit.com/output_html/qbo/docs/develop/webhooks/configure-webhooks.html) and [ordering and delivery guidance](https://static.developer.intuit.com/output_html/qbo/docs/develop/webhooks/best-practices.html) describe company-scoped notifications, separate environment setup and missed or out-of-order delivery. | Polling is the baseline. A future verified notification can trigger a poll after routing by tenant, company and environment. |
| Sandbox credentials | [Intuit sandbox FAQs](https://static.developer.intuit.com/output_html/qbo/docs/develop/sandboxes/sandbox-faqs.html) require development credentials for sandbox and distinguish production credentials. | Deterministic fixtures only. No account or credential access, network requests, customer email, charges, voids or credits were used for validation. |

No SDK change is part of this pilot. Production remains gated on authorized
company verification, supported payment methods, payable delivery, exact
readback and reviewed business policies.
