## Overview

Shipping tracks how an order gets to the customer. Each shipment belongs to an
order and lists which line items are in it, so an order can go out in parts.

## Tasks

### Ship an order

1. Open **Shipments** and choose **New**.
2. Pick the order in **{field:contractId}** and choose the
   **{field:fulfillmentType}**.
3. Enter the **{field:carrier}** and **{field:trackingNumber}**.
4. List the items and quantities in the shipment.
5. Set **{field:status}** to shipped and record **{field:shippedAt}**.

### Confirm delivery

1. Open the shipment and set **{field:status}** to delivered.
2. Record **{field:deliveredAt}**.
