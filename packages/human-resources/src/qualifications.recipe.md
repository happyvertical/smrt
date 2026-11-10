## Overview

Qualifications is where you list the certificates, licences and training your
work needs, such as first aid, and record who holds each one and when it runs
out. It builds on Employees, so switch that on first.

Only people using the app can see these records. They are kept closed to
assistants and other automated tools on purpose, so an agent cannot read them.

## Tasks

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
5. Set the **{field:HeldQualification.status}** to show whether it is still valid.
6. Save. You can now see who needs to renew before the date.
