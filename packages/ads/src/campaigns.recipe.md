## Overview

Ads is where you run advertising on your own site. An ad campaign sets the
dates, the budget and the priority tier; the ads inside it are the pictures
people actually see, each with a link. When a campaign has more than one ad,
the app shares the showings between them by weight, so you can try two
versions and see which gets more clicks.

Ad sizes and priority tiers are shared lists. Set them up once; every campaign
picks from them. When more than one campaign could show in the same place, the
tier decides which is tried first.

The app counts every showing and click as it serves the ads. Those counts are
refreshed on the ad a little later; you read them, you do not type them.

## Tasks

### Add an ad size

1. Open the ad sizes and choose **New**.
2. Type the **{field:AdFormat.name}**, for example "Leaderboard".
3. Enter the **{field:AdFormat.width}** and **{field:AdFormat.height}**.
4. Pick the **{field:AdFormat.formatType}**: a picture, a piece written to look like your own content, or a video.
5. Save. The usual sizes are 728 by 90, 300 by 250 and 320 by 50.

### Set up the priority tiers

1. Open the priority tiers and choose **New**.
2. Type the **{field:AdDeliveryTier.name}**, for example "Sponsorship", "Standard" or "House".
3. Set the **{field:AdDeliveryTier.priority}**: 1 is tried first, then 2, then 3.
4. Pick **{field:AdDeliveryTier.pricingModel}** to say how ads in this tier are charged.
5. Save. A "House" tier with the last priority is a good place for your own ads, so something always shows.

### Start an ad campaign

1. Open the ad campaigns and choose **New**.
2. Type the **{field:AdGroup.name}**, for example "Summer sale".
3. Pick the **{field:AdGroup.tierId}** it runs in.
4. Set when it **{field:AdGroup.startDate}** and **{field:AdGroup.endDate}**.
5. Enter the **{field:AdGroup.dailyBudget}** and the **{field:AdGroup.totalBudget}**. The app does not stop a campaign at its budget by itself; keep an eye on the counts.
6. Leave the **{field:AdGroup.status}** as draft until the ads are ready, then set it to active.
7. Save.

### Add an ad to a campaign

1. Open the ads and choose **New**.
2. Type the **{field:AdVariation.name}**, for example "Version A, blue button".
3. Pick the **{field:AdVariation.groupId}** it belongs to and the **{field:AdVariation.formatId}** it is made for.
4. Choose the **{field:AdVariation.assetId}** people will see.
5. Enter the web address it should **{field:AdVariation.clickUrl}** when someone taps it.
6. Write a few **{field:AdVariation.altText}** for people who cannot see the picture.
7. Set the **{field:AdVariation.weight}**. An ad with weight 2 shows twice as often as one with weight 1 in the same campaign.
8. Set the **{field:AdVariation.status}** to active when it is ready to show.
9. Save.

### Pause or finish a campaign

1. Open the ad campaign.
2. Change the **{field:AdGroup.status}** to paused to stop it for now, or to completed when it is over.
3. Save. The ads in it stop showing straight away.

### See which ad is doing better

1. Open the ads and find the ads in one campaign.
2. Compare the **{field:AdVariation.impressions}** and **{field:AdVariation.clicks}** of each. These are counted by the app as it serves the ads and refreshed a little later.
3. Give the better ad a higher **{field:AdVariation.weight}**, or pause the weaker one by changing its **{field:AdVariation.status}**.
