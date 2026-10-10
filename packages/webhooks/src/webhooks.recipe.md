## Overview

Send signed event notifications to an external HTTPS endpoint. Administrators
can pause subscriptions and inspect delivery attempts. This integration requires
a server and a running background worker.

## Tasks

- Add a subscription with a public HTTPS endpoint, signing secret, and event/model filters.
- Disable a subscription to cancel unsent deliveries.
- Inspect the delivery log, then retry failed deliveries after correcting their endpoint.
- Ask the endpoint owner to verify signatures and deduplicate delivery IDs.
