## Overview

Inventory keeps count of how many of each product you have. Each count is a
stock level: an item, the place it is kept and how many are on hand. Stock can
sit in more than one place, and every change is recorded as a stock movement so
there is a trail.

## Tasks

### Count what you have

1. Create a stock level for the item and the place it is kept.
2. Set **{field:qty}** to how many you have on hand.
3. Set **{field:state}** if the stock is not available to sell, for example
   allocated or on quality hold.

### Correct a count

1. Find the stock level for the item.
2. Set **{field:qty}** to what you really have. Record why as a stock movement.

### Keep stock in more than one place

1. Add a location with a **{field:code}** and a **{field:name}**, and say what
   sort it is in **{field:kind}**.
2. Create stock levels against that location.
