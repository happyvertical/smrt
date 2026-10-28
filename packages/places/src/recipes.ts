/**
 * Declared recipes for smrt-places (#4409): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Place } from './models/Place';
import { PlaceType } from './models/PlaceType';

/**
 * Places: the buildings, rooms, zones and sites where work happens, one
 * inside another. `PlaceAsset` (the picture join) is closed to every surface
 * and stays out of the recipe.
 */
export class PlacesLocationsRecipe extends SmrtRecipe {
  static id = 'places.locations';
  static help = './locations.recipe.md';
  static label = 'Places';
  static summary =
    'Keep a list of the places your work happens, such as sites, buildings, rooms and storage zones, one inside another.';
  static synonyms = [
    'places',
    'locations',
    'sites',
    'buildings',
    'rooms',
    'addresses',
    'warehouses',
  ];
  static section = {
    id: 'places',
    label: 'Locations',
    icon: 'home',
    description: 'The places your work happens.',
  };
  static models = [Place, PlaceType];
  static nav = [
    {
      label: 'Places',
      model: Place,
      icon: 'home',
      description:
        'Every site, building, room and zone, with its address and what it is inside.',
      noun: 'place',
    },
    {
      label: 'Place types',
      model: PlaceType,
      icon: 'tag',
      description: 'The kinds of place you keep, such as building or room.',
      noun: 'place type',
    },
  ];
  static options = {
    Place: {
      fields: {
        name: { order: 1 },
        typeId: { label: 'Type', order: 2 },
        parentId: {
          label: 'Inside',
          help: 'The larger place this one is part of, such as the building a room is in.',
          order: 3,
        },
        description: { order: 4 },
        streetNumber: { label: 'Street number', order: 5 },
        streetName: { label: 'Street name', order: 6 },
        city: { order: 7 },
        region: { order: 8 },
        country: { order: 9 },
        postalCode: { label: 'Postal code', order: 10 },
        latitude: { visibility: 'advanced' },
        longitude: { visibility: 'advanced' },
        countryCode: { label: 'Country code', visibility: 'advanced' },
        timezone: { label: 'Time zone', visibility: 'advanced' },
        externalId: { label: 'Map reference', visibility: 'advanced' },
        source: { label: 'Map provider', visibility: 'advanced' },
        metadata: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
        createdAt: { visibility: 'hidden' },
        updatedAt: { visibility: 'hidden' },
      },
    },
    PlaceType: {
      fields: {
        name: { order: 1 },
        description: { order: 2 },
        createdAt: { visibility: 'hidden' },
        updatedAt: { visibility: 'hidden' },
      },
    },
  } as const;
}
