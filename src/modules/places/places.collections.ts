import { ObjectId } from 'mongodb';

import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { CAMPUS_PLACES } from './places.catalog.js';
import { PLACE_CATEGORIES, PLACE_MAX_PHOTOS } from './places.types.js';

export const placesCollections: CollectionSpec[] = [
  {
    name: 'places',
    validator: {
      $jsonSchema: bson.object(
        {
          name: bson.string({ minLength: 2, maxLength: 60 }),
          category: bson.enumOf(PLACE_CATEGORIES),
          description: bson.string({ maxLength: 600 }),
          area: bson.string({ maxLength: 80 }),
          location: bson.object({ lat: { bsonType: ['double', 'int'], minimum: -90, maximum: 90 }, lng: { bsonType: ['double', 'int'], minimum: -180, maximum: 180 } }, ['lat', 'lng']),
          icon: bson.string({ maxLength: 40 }),
          photos: bson.array(bson.object({ url: bson.string({ maxLength: 500 }) }, ['url', 'mediaId']), { maxItems: PLACE_MAX_PHOTOS }),
          active: bson.bool,
        },
        ['name', 'category', 'description', 'area', 'campus', 'location', 'hours', 'icon', 'photos', 'active', 'sortOrder', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [{ key: { active: 1, sortOrder: 1 }, options: { name: 'listing' } }],
  },
];

/**
 * The campus places, once per database (staging, production, a new developer's): added when missing, by name. It
 * never runs again, so a place the team deletes or renames in the app stays as they left it.
 */
export const placesMigrations: DataMigration[] = [
  {
    id: '2026-11-05-campus-places',
    description: 'Campus places from OpenStreetMap, added once (by name)',
    async up(db) {
      const places = db.collection('places');
      const existing = new Set((await places.find({}, { projection: { name: 1 } }).toArray()).map((p) => p.name as string));
      const now = new Date();
      const missing = CAMPUS_PLACES.map((p, i) => ({ p, i })).filter(({ p }) => !existing.has(p.name));
      if (!missing.length) return;
      await places.insertMany(
        missing.map(({ p, i }) => ({
          _id: new ObjectId(), name: p.name, category: p.category, description: p.description, area: p.area, campus: p.campus, location: p.location, hours: p.hours, icon: p.icon,
          photos: p.photoUrls.map((url) => ({ url, mediaId: null })), active: true, sortOrder: i, createdAt: now, updatedAt: now,
        })),
      );
    },
  },
];
