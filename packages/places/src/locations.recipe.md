## Overview

Places is where you keep the sites, buildings, rooms and storage zones your
work happens in. Each place has a name, a type and, when it is somewhere real,
an address. A place can sit inside a larger one, so a room belongs to a
building and a shelf to a room, and you can follow that chain either way. A
place does not have to be on a map: a storage zone or a work area with no
address is fine.

## Tasks

### Add a place

1. Open the list of places and choose **New**.
2. Type the **{field:Place.name}**, for example "Main warehouse".
3. Pick its **{field:Place.typeId}**, such as building or room. Add a type first if the one you need is missing.
4. Fill in the address: the **{field:Place.streetNumber}**, **{field:Place.streetName}**, **{field:Place.city}**, **{field:Place.region}**, **{field:Place.country}** and **{field:Place.postalCode}**. Leave these empty for a place that is not on a map.
5. Save. When your app searches a map for a place, it can add the place for you with the address filled in from the map provider.

### Put a place inside another

1. Open the place and choose to edit it.
2. In **{field:Place.parentId}**, pick the larger place it belongs to, such as the building a room is in.
3. Save. The place now shows up under the one you chose.

### Change or remove a place

1. Open the place and choose to edit it.
2. Change the **{field:Place.name}**, **{field:Place.description}** or address, then save.
3. To remove a place you no longer use, open it and choose to delete it. Move anything inside it first.

### Add a place type

1. Open the list of place types and choose **New**.
2. Type the **{field:PlaceType.name}**, for example "Room".
3. Add a **{field:PlaceType.description}** so others know when to use it.
4. Save. The type can now be picked when you add a place.
