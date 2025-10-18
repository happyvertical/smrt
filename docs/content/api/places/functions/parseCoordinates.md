# Function: parseCoordinates()

> **parseCoordinates**(`coordString`): \{ `lat`: `number`; `lng`: `number`; \} \| `null`

Defined in: places/src/utils.ts:145

Parse coordinate string to lat/lng

Supports formats:
- "lat, lng"
- "lat,lng"
- "lat lng"

## Parameters

### coordString

`string`

Coordinate string

## Returns

\{ `lat`: `number`; `lng`: `number`; \} \| `null`

Object with lat and lng, or null if invalid
