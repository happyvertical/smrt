## Overview

Invoicing bills your customers and records what they pay. An invoice lists its
line items; a payment can be spread across one or more invoices.

## Tasks

### Send an invoice

1. Create a new invoice.
2. Pick the **{field:customerId}** and add the line items.
3. Check the **{field:totalAmount}** and set the **{field:dueDate}**.
4. Set **{field:status}** to sent once it goes out.

### Record a payment

1. Create a new payment.
2. Pick the **{field:customerId}**, then enter the **{field:Payment.amount}** and the
   **{field:method}** used.
3. Set **{field:Payment.status}** to completed once the money has arrived.
4. Apply it to the invoices it settles; each one shows what is still owed.
