## Overview

Form customization lets you decide what the forms in your app ask for. For any
field you can change the name people see, the hint beside it, the value a new
record starts with, where it sits on the form, and whether it is always shown,
tucked under "advanced", or hidden. You can also lock a field so that people
cannot change it for themselves.

Changes layer. The app starts with sensible settings, your organization can
change them for everyone in it, and each person can then adjust their own view
unless you locked the field. Resetting a field removes your change and brings
back whatever sits underneath.

## Tasks

### Change what a field is called

1. Open **Form defaults** from your settings and find the form you want.
2. Choose the field and type a new **{field:label}**.
3. Save. The new name appears on the form.

### Give people a hint

1. Choose the field in **Form defaults**.
2. Write the **{field:help}**, one short sentence that says what to enter.
3. Save. The hint now shows beside the field.

### Pre-fill a value

1. Choose the field in **Form defaults**.
2. Enter the **{field:defaultValue}** a new record should start with.
3. Save. People can still type over it unless the field is locked.

### Tidy a long form

1. Choose a field that most people never need.
2. Set its **{field:visibility}** to advanced to tuck it away, or to hidden to
   remove it.
3. Save. A field that must always be filled in stays shown unless it also has a
   default value.

### Put fields in a better order

1. Choose a field.
2. Set its **{field:displayOrder}**. Lower numbers come first.
3. Save, then check the form.

### Keep everyone on the same setting

1. Choose the field in **Form defaults**.
2. Turn on **{field:locked}**.
3. Save. People can no longer change that field for themselves.

### Undo a change

Choose **Reset** on a field to remove your change. Settings from the layers
below, such as the app's own, come back. Resetting asks you to confirm first.

### Review suggestions

When enough people fill in the same value, or keep opening the same advanced
field, the app suggests a change. Open the suggestions list in **Form defaults**
and accept or dismiss each one. Nothing changes until you accept.
