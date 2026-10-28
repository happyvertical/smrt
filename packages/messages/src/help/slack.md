## Overview

Slack shows the messages from the workspaces your application is connected to,
in one place beside your email. Each message keeps the channel it was posted
in, the thread it belongs to, the reactions people added and whether it was
edited, so you can catch up on a conversation without opening Slack.

## Tasks

Workspaces are connected by your application administrator on the server.
Messages arrive from those connected workspaces; here you read them and see
where each one stands.

### Find a message in a channel

1. Open Slack messages.
2. Look at the **{field:SlackMessage.channelName}** to find the channel you want.
3. Open a message to read the **{field:SlackMessage.body}** and see who it is from.

### Follow a thread

1. Open a message that is part of a conversation.
2. Use its **{field:SlackMessage.threadId}** to find the other messages in the same thread.
3. Read them oldest first; the **{field:SlackMessage.reactions}** show how people responded.

### See whether a message was changed

1. Open the message.
2. Check **{field:SlackMessage.isEdited}** to see whether it was edited after it was posted.

### Draft a message

1. Open Slack messages and choose **New**.
2. Type the **{field:SlackMessage.channelName}** it is for and the **{field:SlackMessage.body}**.
3. Save. This records the draft; your application sends it through the connected workspace, and the **{field:SlackMessage.sendStatus}** shows where it stands.

### See which workspaces are connected

1. Open Slack workspaces.
2. Look at the **{field:SlackAccount.workspaceName}** and whether it is **{field:SlackAccount.isActive}**.
3. Check **{field:SlackAccount.lastSyncAt}** to see when messages were last collected. Connecting or changing a workspace is done by your application administrator, not here.
