## Overview

The ingestion inbox is where an authenticated reviewer finds incoming material
that needs attention. It keeps the original material and its related evidence
together, so a reviewer can understand what arrived before choosing a next
step.

## Tasks

### Check items that need attention

1. Open the ingestion inbox in an application that has configured an
   authenticated review host.
2. Choose an item to inspect its evidence and current review state.
3. Open the item in Ingestion review when it has a proposed action.

### Keep uncertain material for review

1. Leave material in the inbox when there is not enough information to decide.
2. Return after the application has new information or a reviewer can make a
   decision.
3. Do not treat an inbox item as permission to change another record.

## Preview status

This recipe describes a preview workflow. The published evaluation did not meet
quality gates and did not establish safety, so automation remains disabled. It
does not configure a source, provider, generic record route, or automatic
action. Applications continue to use the scoped callbacks described in the
ingestion review documentation.
