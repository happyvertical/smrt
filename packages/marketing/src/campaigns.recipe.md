## Overview

Campaigns is where you plan a push to bring in customers: a sale, a launch, a
seasonal promotion. Each campaign has a budget, start and end dates and a
status that shows where it stands, from draft through active to completed. A
campaign runs on one or more channels, such as an ad group, a social post, an
email or an event, each with its share of the budget. Results come back from
the channels' reporting, period by period, so you can see what each campaign
and channel brought in for what it cost.

## Tasks

### Plan a campaign

1. Open the list of campaigns and choose **New**.
2. Type the **{field:Campaign.name}**, for example "Spring widget sale".
3. Say what it is for in **{field:Campaign.objective}**, such as awareness or new leads.
4. Set when it **{field:Campaign.startAt}** and when it **{field:Campaign.endAt}**. The end cannot be before the start.
5. Enter the **{field:Campaign.budgetCents}** as a whole number of cents, so $500 is 50000, and check the **{field:Campaign.currency}**.
6. Save. A new campaign starts as a draft.

### See where a campaign stands

1. Open the list of campaigns.
2. The **{field:Campaign.status}** shows whether each one is still a draft, scheduled, active, paused, completed or archived. It moves forward as the campaign is scheduled, run and wrapped up; you do not set it by hand.
3. Open a campaign to change its name, dates or budget while it is still being planned.

### Add a channel to a campaign

1. Open the list of channels and choose **New**.
2. Pick the **{field:CampaignChannel.campaignId}** it belongs to.
3. Choose the **{field:CampaignChannel.channelKind}**, such as an ad group, a social post, a message, content or an event.
4. Type the **{field:CampaignChannel.channelRef}** the channel goes by, so its results can be matched to it later.
5. Enter its **{field:CampaignChannel.allocatedBudgetCents}** as a whole number of cents.
6. If the channel runs on different dates from the campaign, set when it **{field:CampaignChannel.startAt}** and **{field:CampaignChannel.endAt}**.
7. Save. You can edit a channel later, or remove one that will not run.

### Read the results

Results arrive from the channels' reporting; nobody types them in. Each one
covers a period for one campaign, or for one channel within it. A result is
never changed once it is in: a correction arrives as a new result for the same
period.

1. Open the list of results.
2. Find the **{field:CampaignMetricSnapshot.campaignId}** you are interested in. A result with no **{field:CampaignMetricSnapshot.campaignChannelId}** covers the whole campaign.
3. Check the period, **{field:CampaignMetricSnapshot.periodStart}** to **{field:CampaignMetricSnapshot.periodEnd}**.
4. Compare the **{field:CampaignMetricSnapshot.spendCents}** with the **{field:CampaignMetricSnapshot.clicks}**, **{field:CampaignMetricSnapshot.leads}** and **{field:CampaignMetricSnapshot.conversions}** it brought in, and the **{field:CampaignMetricSnapshot.revenueCents}** where the channel reports it.
5. The **{field:CampaignMetricSnapshot.source}** says which channel's reporting sent the result.
