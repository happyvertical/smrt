# Function: checkSchedulingConflict()

> **checkSchedulingConflict**(`event1Start`, `event1End`, `event2Start`, `event2End`): `boolean`

Defined in: [events/src/utils.ts:83](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/events/src/utils.ts#L83)

Check if events have scheduling conflict

## Parameters

### event1Start

`Date`

First event start

### event1End

First event end

`Date` | `null`

### event2Start

`Date`

Second event start

### event2End

Second event end

`Date` | `null`

## Returns

`boolean`

True if events overlap
