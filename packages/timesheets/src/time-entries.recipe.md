## Overview

Time entries record who worked how long on what. Each entry names the person,
what they did and when, and moves from draft to submitted to approved.

## Tasks

### Record time

1. Create a new time entry.
2. Pick the **{field:participantProfileId}** who did the work.
3. Write a short **{field:description}** of what was done.
4. Enter when it **{field:startedAt}** and **{field:endedAt}**, or type the
   **{field:durationSeconds}** directly (3600 is one hour).

### Approve it

1. Set **{field:status}** to submitted when the entry is ready to check.
2. Set it to approved to lock it, or to rejected and give a
   **{field:rejectionReason}**. An approved entry never changes; correct it
   with a new entry.
