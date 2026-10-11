## Overview

Roles and permissions control tenant access. Denies take precedence, and role changes should be reviewed before they are applied.

## Tasks

- Create a role and assign only the permissions required for its work.
- Add a member to the correct tenant through {field:Membership.tenantId} and assign a role through {field:Membership.roleId}.
- Use a resource grant only when a record needs a reviewed exception to its ordinary role rules.
