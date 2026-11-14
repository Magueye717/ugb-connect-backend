import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { HOUSING_FOR, HOUSING_KINDS, HOUSING_STATES } from './housing.types.js';

export const housingCollections: CollectionSpec[] = [
  {
    name: 'housingAds',
    validator: {
      $jsonSchema: bson.object(
        {
          kind: bson.enumOf(HOUSING_KINDS),
          authorId: bson.objectId,
          village: bson.nullable(bson.string({ maxLength: 30 })),
          room: bson.nullable(bson.string({ maxLength: 12 })),
          wants: bson.array(bson.string({ maxLength: 30 }), { maxItems: 17 }),
          area: bson.nullable(bson.string({ maxLength: 60 })),
          rent: bson.nullable(bson.int({ minimum: 0, maximum: 1_000_000 })),
          places: bson.nullable(bson.int({ minimum: 1, maximum: 10 })),
          for: bson.enumOf(HOUSING_FOR),
          note: bson.nullable(bson.string({ maxLength: 300 })),
          state: bson.enumOf(HOUSING_STATES),
        },
        ['kind', 'authorId', 'author', 'village', 'room', 'wants', 'area', 'from', 'to', 'rent', 'places', 'for', 'note', 'state', 'reports', 'expiresAt', 'closedAt', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { state: 1, expiresAt: 1, createdAt: -1 }, options: { name: 'board' } },
      { key: { authorId: 1, createdAt: -1 }, options: { name: 'author' } },
    ],
  },
  {
    name: 'housingContacts',
    validator: { $jsonSchema: bson.object({ adId: bson.objectId, authorId: bson.objectId, otherId: bson.objectId }, ['adId', 'authorId', 'otherId', 'createdAt']) },
    indexes: [
      // One conversation per ad and person.
      { key: { adId: 1, otherId: 1 }, options: { name: 'ad_other_unique', unique: true } },
      { key: { otherId: 1 }, options: { name: 'other' } },
    ],
  },
];
