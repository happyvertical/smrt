## Overview

Subscriptions is where you sell plans that renew. A plan says what it costs,
how often it bills and whether it is free, a fixed price or pay what you can.
A subscription joins a subscriber to a plan and shows where it stands, from
trial to active to cancelled. Every time you change a plan's terms, the
earlier terms are kept as a plan version, so a subscriber who already paid for
a period keeps what they paid for until it renews. Charges show what each
subscriber used and what it cost them.

All amounts are whole numbers of cents, with no decimal point.

## Tasks

### Set up a plan

1. Open the plans and choose **New**.
2. Type the **{field:SubscriptionPlan.name}** customers will see and a short **{field:SubscriptionPlan.planKey}** such as "starter".
3. Choose **{field:SubscriptionPlan.pricingMode}**: free, a fixed price, or pay what you can. This cannot change once the plan is saved; make a new plan instead.
4. For a fixed price, enter the **{field:SubscriptionPlan.priceAmount}** in cents and the **{field:SubscriptionPlan.currency}**.
5. Set how often it bills in **{field:SubscriptionPlan.billingInterval}**.
6. Set the **{field:SubscriptionPlan.status}** to active when it is ready to sell.
7. Save.

### Change a plan's price or terms

1. Open the plan and edit the **{field:SubscriptionPlan.priceAmount}**, **{field:SubscriptionPlan.billingInterval}** or **{field:SubscriptionPlan.status}**.
2. Save. The new terms apply to new subscribers and to existing ones from their next renewal; a period already paid for keeps its old terms.

### Retire a plan

1. Open the plan and set its **{field:SubscriptionPlan.status}** to archived.
2. Save. No one new can subscribe to it; existing subscribers keep going until they cancel.

### Subscribe someone to a plan

1. Open the subscriptions and choose **New**.
2. Pick the **{field:TenantSubscription.planId}**.
3. Enter the day it **{field:TenantSubscription.startedAt}** and, if there is a free trial, when the **{field:TenantSubscription.trialEndsAt}**.
4. Save. The **{field:TenantSubscription.status}** shows where the subscription stands once it has been paid for.

### See where a subscription stands

1. Open the subscriptions and find the one you want.
2. The **{field:TenantSubscription.status}** shows whether it is still incomplete, on trial, active, past due, unpaid or cancelled.
3. **{field:TenantSubscription.currentPeriodStart}** and **{field:TenantSubscription.currentPeriodEnd}** show the period that has been paid for.

### Cancel a subscription

1. Open the subscription.
2. Tick **{field:TenantSubscription.cancelAtPeriodEnd}** so it runs out when the current period ends instead of renewing.
3. Save.

### Look up the terms a subscriber was sold

Plan versions are written automatically whenever a plan is saved with changed
terms; you cannot add or edit them here.

1. Open the plan versions and find the **{field:SubscriptionPlanVersion.planId}** you are interested in.
2. Each row shows the **{field:SubscriptionPlanVersion.version}** and the date it was **{field:SubscriptionPlanVersion.effectiveFrom}**.
3. Read the **{field:SubscriptionPlanVersion.priceAmount}**, **{field:SubscriptionPlanVersion.currency}** and **{field:SubscriptionPlanVersion.billingInterval}** that applied under it.

### See what a subscriber was charged

Charges are created by the usage and billing service as usage is recorded;
you cannot add or edit them here.

1. Open the charges.
2. Each row shows **{field:ClientCharge.metricKey}**, **{field:ClientCharge.quantity}** and the **{field:ClientCharge.amount}** in cents.
3. The **{field:ClientCharge.status}** shows whether the charge is still a draft, approved or adjusted.
