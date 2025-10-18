# Function: parseCoordinates()

> **parseCoordinates**(`coordString`): \{ `lat`: `number`; `lng`: `number`; \} \| `null`

Defined in: [places/src/utils.ts:145](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/places/src/utils.ts#L145)

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
