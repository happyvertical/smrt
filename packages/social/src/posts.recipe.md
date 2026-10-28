## Overview

Social is where you write what you want to put out on YouTube, X, Threads and
Bluesky. Each post is written for one connected account, with its text,
hashtags and an optional link, and can carry the date you plan to put it out.
Your app does the publishing; once a post is out, the platform's numbers for it
arrive here as post results.

## Tasks

### Connect an account

1. Open the connected accounts and choose **New**.
2. Give it a **{field:SocialAccount.name}** you will recognise, such as "Acme Corp on Bluesky".
3. Pick the **{field:SocialAccount.platform}** and type the **{field:SocialAccount.platformUsername}** you post under.
4. Add any **{field:SocialAccount.defaultHashtags}** you want on every post from this account.
5. Save. Signing in to the platform itself happens from your app, not in this form; the **{field:SocialAccount.status}** shows whether the account is connected.

### Write a post

1. Open the posts and choose **New**.
2. Pick the **{field:SocialPost.socialAccountId}** it is for.
3. Write the **{field:SocialPost.description}** and add any **{field:SocialPost.hashtags}**.
4. Give it a **{field:SocialPost.title}** if the platform shows one, and a **{field:SocialPost.linkUrl}** if you are sharing a page.
5. Save. It stays a draft until your app puts it out.

### Plan when a post goes out

1. Open the post and set **{field:SocialPost.scheduledAt}** to the date and time you want.
2. Save. The date is recorded on the post; your app publishes it when that time comes.

### See where a post stands

Open the post. Its **{field:SocialPost.status}** shows whether it is a draft,
waiting to go out, published or failed. Once it is out, **{field:SocialPost.publishedAt}**
and the **{field:SocialPost.platformUrl}** are filled in.

### Change or remove a post

1. Open the post and change what you need, then save.
2. To remove it, open the post and choose **Delete**.

### See how a post did

Post results are written by the platform sync, not by hand; you can only read
them here.

1. Open the post results.
2. Find the **{field:SocialPostAnalyticsSnapshot.socialPostId}** you are interested in and the **{field:SocialPostAnalyticsSnapshot.platform}** it ran on.
3. Each result shows the **{field:SocialPostAnalyticsSnapshot.analytics}** the platform reported and when they were **{field:SocialPostAnalyticsSnapshot.capturedAt}**, so the newest one is the latest count.

### Stop using an account

1. Open the account and untick **{field:SocialAccount.isActive}**, then save. Its posts stay, but nothing new goes out from it.
2. To remove it entirely, open the account and choose **Delete**.
