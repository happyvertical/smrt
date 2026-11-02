## Overview

Articles is where you write and publish. Each article starts as a draft, can
be checked before it goes out, and is published when you are ready. Every time
an article is published or corrected, a version is saved so nothing is lost.
Fixes made after publication are recorded as corrections readers can see, and
pieces sent in by readers or outside writers wait as contributions until your
team has looked at them.

## Tasks

### Write a draft

1. Open the articles and choose **New**.
2. Type the **{field:Content.title}** and a **{field:Content.name}** to find it by.
3. Leave the **{field:Content.type}** as article.
4. Write the **{field:Content.body}** and a short **{field:Content.description}**.
5. Add the **{field:Content.author}**, a **{field:Content.category}** and any **{field:Content.tags}**.
6. Save. The **{field:Content.status}** starts as draft, so nobody outside your team sees it yet.

### Publish an article

1. Open the article and set the **{field:Content.publish_date}**.
2. Change the **{field:Content.status}** to published and save.
3. If the article still has checks outstanding, the save is refused and tells you what is missing; look at its reviews, fix what they raise and try again.

### See how an article was checked

Reviews are made by the checks your publication runs on an article, not by
hand. Open the reviews to read them.

1. Find the **{field:ContentReview.contentId}** you want and the **{field:ContentReview.kind}** of check.
2. The **{field:ContentReview.status}** shows the outcome, and the **{field:ContentReview.summary}** says what was found.

### Read an article's history

Versions are saved for you each time an article is published or corrected,
and when someone saves one on purpose. Open the versions to read them.

1. Find the **{field:ContentVersion.contentId}** and look down the **{field:ContentVersion.version}** numbers.
2. The **{field:ContentVersion.kind}** says why each one was saved and the **{field:ContentVersion.summary}** what changed.
3. Open a version to see the **{field:ContentVersion.title}** and **{field:ContentVersion.status}** as they were when the version was saved.

### Issue a correction

1. Open the corrections and choose **New**.
2. Pick the **{field:ContentCorrection.contentId}** and the **{field:ContentCorrection.correctionType}** of mistake.
3. Put the old wording in **{field:ContentCorrection.incorrectText}** and the new wording in **{field:ContentCorrection.correctedText}**.
4. Write a **{field:ContentCorrection.summary}** for your team and a **{field:ContentCorrection.publicNote}** for readers.
5. Save. The **{field:ContentCorrection.status}** shows whether the correction is still a draft, has been published or was retracted.

### Look at what readers sent in

Contributions arrive through your website or by email, not by hand in the
app. Here you read them and leave notes for your team.

1. Open the contributions and look at the **{field:ContentContribution.title}**, who it is **{field:ContentContribution.contributorName}** and the **{field:ContentContribution.channel}**.
2. Open one to read the **{field:ContentContribution.body}**.
3. Add your thoughts in **{field:ContentContribution.editorNotes}** and save.
4. The **{field:ContentContribution.status}** shows where it stands, from submitted to approved, rejected or published.
