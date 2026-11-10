## Overview

Employees is where you keep a record of who works for you. Each person has an
employment record with their role, their worker type and whether they are
currently active, plus the dates they started and, if they left, finished.

Only people using the app can see these records. They are kept closed to
assistants and other automated tools on purpose, so an agent cannot read them.

## Tasks

### Add an employee

1. Open the list of employees and choose **New**.
2. Pick the **{field:Employment.profileId}**.
3. Give them an **{field:Employment.employeeNumber}**, your own reference for them.
4. Fill in their **{field:Employment.position}** and **{field:Employment.workerType}**.
5. Save. They now show in your list of employees.

### Record that someone has left

1. Open the person from the list.
2. Set the **{field:Employment.status}** to show they no longer work for you.
3. Record their **{field:EmploymentTerm.endedOn}** and the **{field:EmploymentTerm.endReason}**.
4. Save. Their history stays on file.
