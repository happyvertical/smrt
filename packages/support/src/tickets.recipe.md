## Overview

Support keeps every request for help from a customer in one place. Each request
is a ticket with a number, a subject, who asked, who is handling it and where
it stands, from new to resolved. Messages back and forth stay on the ticket, so
anyone on the team can pick it up and see what was said.

## Tasks

### Log a request for help

1. Open the list of tickets and choose **New**.
2. Write a short **{field:SupportCase.subject}** the customer would recognise.
3. Describe the problem in the **{field:SupportCase.description}**.
4. Pick the **{field:SupportCase.clientProfileId}** who asked.
5. Save. The ticket gets its number and starts as new.

### Hand a ticket to someone

1. Open the ticket and choose Edit.
2. Pick who it is **{field:SupportCase.assignedSpecialistId}**.
3. Set the **{field:SupportCase.priority}** so urgent requests come first.
4. Save. The person sees it in their list.

### Reply and keep the history

1. Open the list of messages and choose **New**.
2. Pick the **{field:SupportInteraction.caseId}** the message belongs to.
3. Write the **{field:SupportInteraction.body}**.
4. Save. The message stays on the ticket for the next person.

### Close a ticket

Change the **{field:SupportCase.status}** to resolved once the customer has what
they need. If they write back, move it back to in progress and carry on.

### Add someone to the support team

1. Open the support team and choose **New**.
2. Type the person's **{field:SupportSpecialist.displayName}**.
3. Save. They can now be given tickets.
