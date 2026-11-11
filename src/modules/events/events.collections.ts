import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { BOOKING_STATUSES, EVENT_CATEGORIES, EVENT_STATUSES } from './events.types.js';
import { TICKET_PAYMENT_METHODS } from '../ticketing/index.js';

const ticketType = bson.object(
  {
    typeId: bson.string({ pattern: '^[0-9A-Z]{4,8}$' }),
    name: bson.string({ minLength: 2, maxLength: 40 }),
    description: bson.nullable(bson.string({ maxLength: 120 })),
    price: bson.int({ minimum: 0, maximum: 1_000_000 }),
    capacity: bson.int({ minimum: 1, maximum: 50_000 }),
    remaining: bson.int({ minimum: 0 }),
  },
  ['typeId', 'name', 'description', 'price', 'capacity', 'remaining'],
);

export const eventsCollections: CollectionSpec[] = [
  {
    name: 'events',
    validator: {
      $jsonSchema: bson.object(
        {
          code: bson.string({ pattern: '^EV[0-9A-Z]{5,8}$' }),
          orgId: bson.objectId,
          title: bson.string({ minLength: 3, maxLength: 80 }),
          category: bson.enumOf(EVENT_CATEGORIES),
          description: bson.string({ maxLength: 3000 }),
          images: bson.array(bson.imageRef, { minItems: 1, maxItems: 8 }),
          startsAt: bson.date,
          endsAt: bson.date,
          salesCloseAt: bson.date,
          ticketTypes: bson.array(ticketType, { minItems: 1, maxItems: 6 }),
          maxPerStudent: bson.int({ minimum: 1, maximum: 20 }),
          paymentMethods: bson.array(bson.enumOf(TICKET_PAYMENT_METHODS), { minItems: 1 }),
          status: bson.enumOf(EVENT_STATUSES),
        },
        ['code', 'orgId', 'title', 'category', 'description', 'images', 'venue', 'startsAt', 'endsAt', 'salesCloseAt', 'ticketTypes', 'maxPerStudent', 'status', 'review', 'reviewLog', 'createdBy', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { code: 1 }, options: { name: 'code_unique', unique: true } },
      { key: { status: 1, startsAt: 1 }, options: { name: 'listing' } },
      { key: { orgId: 1, startsAt: -1 }, options: { name: 'org_recent' } },
      // The admins' queue of students' events.
      { key: { status: 1, updatedAt: 1 }, options: { name: 'review_queue' } },
    ],
  },
  {
    name: 'eventBookings',
    validator: {
      $jsonSchema: bson.object(
        {
          eventId: bson.objectId,
          userId: bson.objectId,
          total: bson.int({ minimum: 0 }),
          method: bson.enumOf(TICKET_PAYMENT_METHODS),
          status: bson.enumOf(BOOKING_STATUSES),
          units: bson.array(bson.object({ unitId: bson.objectId, typeId: bson.string(), status: bson.enumOf(BOOKING_STATUSES) }, ['unitId', 'typeId', 'name', 'price', 'status', 'ticketId']), { minItems: 1, maxItems: 20 }),
        },
        ['eventId', 'userId', 'units', 'total', 'method', 'status', 'holdExpiresAt', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      // A ticket's source: issued once.
      { key: { 'units.unitId': 1 }, options: { name: 'unit_unique', unique: true } },
      { key: { userId: 1, eventId: 1 }, options: { name: 'user_event' } },
      { key: { status: 1, holdExpiresAt: 1 }, options: { name: 'hold_expiry' } },
      { key: { requestCode: 1 }, options: { name: 'request_code', sparse: true } },
      // One ticket of a request, by its own code.
      { key: { 'units.requestCode': 1 }, options: { name: 'unit_request_code', sparse: true } },
    ],
  },
];

export const eventsMigrations: DataMigration[] = [
  {
    id: '2026-11-02-events-review',
    description: 'Events get review (null) and reviewLog ([]): students’ events go through the admins.',
    async up(db) {
      await db.collection('events').updateMany({ review: { $exists: false } }, { $set: { review: null, reviewLog: [] } });
    },
  },
  {
    id: '2026-11-03-events-publication',
    description: 'Events get audience (the whole university) and publication (null): students pay to publish, for the students they choose.',
    async up(db) {
      await db.collection('events').updateMany({ audience: { $exists: false } }, { $set: { audience: { campuses: [], ufrs: [], regions: [], villages: [] }, publication: null } });
    },
  },
];
