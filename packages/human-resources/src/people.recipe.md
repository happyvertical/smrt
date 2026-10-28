## Overview

People is where you keep a record of who works for you. Each person has an
employment record with their role, their worker type and whether they are
currently active, plus the dates they started and, if they left, finished.
You can also list the qualifications your work needs, such as first aid, and
record who holds each one and when it runs out.

## Tasks

### Add a person who works for you

1. Open the list of people and choose **New**.
2. Pick the **{field:Employment.profileId}**.
3. Give them an **{field:Employment.employeeNumber}**, your own reference for them.
4. Fill in their **{field:Employment.position}** and **{field:Employment.workerType}**.
5. Save. They now show in your list of people.

### Record that someone has left

1. Open the person from the list.
2. Set the **{field:Employment.status}** to show they no longer work for you.
3. Record their **{field:EmploymentTerm.endedOn}** and the **{field:EmploymentTerm.endReason}**.
4. Save. Their history stays on file.

### Set up a qualification

1. Open the list of qualifications and choose **New**.
2. Type the **{field:Qualification.name}**, for example "First aid".
3. Say who gives it out in **{field:Qualification.issuingBody}**.
4. Tick **{field:Qualification.expires}** if it has to be renewed, and set **{field:Qualification.validityMonths}** to how long it lasts.
5. Save.

### Record who holds a qualification

1. Open the held qualifications and choose **New**.
2. Pick the **{field:HeldQualification.qualificationId}** and the **{field:HeldQualification.profileId}** who holds it.
3. Enter the date it was **{field:HeldQualification.issuedOn}** and when it **{field:HeldQualification.expiresOn}**.
4. Add the **{field:HeldQualification.certificateNumber}** from the certificate.
5. Save. You can now see who needs to renew before the date.
