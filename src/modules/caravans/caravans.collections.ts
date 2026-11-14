import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { PAYMENT_METHODS } from '../payments/index.js';
import { TICKET_PAYMENT_METHODS } from '../ticketing/index.js';
import { VEHICLE_MODELS } from './vehicle-models.js';
import { BOOKING_STATUSES, DEFAULT_MAX_SEATS_PER_STUDENT, DEPARTURE_STATUSES, DIRECTIONS, MAX_SEATS_PER_STUDENT } from './caravans.types.js';

const stop = bson.object({ stopId: bson.string({ minLength: 1, maxLength: 20 }), place: bson.string({ minLength: 2, maxLength: 80 }), at: bson.date }, ['stopId', 'place', 'at']);

export const caravansCollections: CollectionSpec[] = [
  {
    name: 'vehicle_models',
    validator: {
      $jsonSchema: bson.object(
        { key: bson.string({ minLength: 2, maxLength: 30 }), label: bson.string({ minLength: 2, maxLength: 60 }), kind: bson.enumOf(['bus', 'minibus']), capacity: bson.int({ minimum: 4, maximum: 90 }), layout: bson.array(bson.array({})), sortOrder: bson.int() },
        ['key', 'label', 'kind', 'capacity', 'layout', 'sortOrder', 'createdAt'],
      ),
    },
    indexes: [{ key: { key: 1 }, options: { name: 'key_unique', unique: true } }],
  },
  {
    name: 'vehicles',
    validator: {
      $jsonSchema: bson.object(
        {
          orgId: bson.objectId,
          label: bson.string({ minLength: 2, maxLength: 60 }),
          plate: bson.nullable(bson.string({ pattern: '^[A-Z0-9-]{4,15}$' })),
          airConditioned: bson.bool,
          capacity: bson.int({ minimum: 4, maximum: 90 }),
          seatsPerRow: bson.int({ minimum: 2, maximum: 6 }),
          blockedSeats: bson.array(bson.int({ minimum: 1 })),
          status: bson.enumOf(['active', 'retired']),
        },
        ['orgId', 'label', 'plate', 'airConditioned', 'capacity', 'seatsPerRow', 'blockedSeats', 'status', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      // A plate is optional: unique only among vehicles that have one.
      { key: { plate: 1 }, options: { name: 'plate_unique_when_set', unique: true, partialFilterExpression: { plate: { $type: 'string' } } } },
      { key: { orgId: 1, status: 1 }, options: { name: 'org_status' } },
    ],
  },
  {
    name: 'departures',
    validator: {
      $jsonSchema: bson.object(
        {
          code: bson.string({ pattern: '^[A-Z0-9]{5,10}$' }),
          orgId: bson.objectId,
          vehicleId: bson.objectId,
          direction: bson.enumOf(DIRECTIONS),
          from: bson.string({ minLength: 2, maxLength: 40 }),
          to: bson.string({ minLength: 2, maxLength: 40 }),
          pickups: bson.array(stop, { minItems: 1, maxItems: 15 }),
          dropoffs: bson.array(stop, { minItems: 1, maxItems: 15 }),
          departureAt: bson.date,
          price: bson.int({ minimum: 100, maximum: 100_000 }),
          maxSeatsPerStudent: bson.int({ minimum: 1, maximum: MAX_SEATS_PER_STUDENT }),
          paymentMethods: bson.array(bson.enumOf(TICKET_PAYMENT_METHODS), { minItems: 1 }),
          minPassengers: bson.int({ minimum: 0 }),
          confirmBy: bson.date,
          bookingClosesAt: bson.date,
          status: bson.enumOf(DEPARTURE_STATUSES),
          seatsTaken: bson.int({ minimum: 0 }),
          seatsConfirmed: bson.int({ minimum: 0 }),
        },
        ['code', 'orgId', 'vehicleId', 'vehicle', 'direction', 'from', 'to', 'pickups', 'dropoffs', 'departureAt', 'price', 'maxSeatsPerStudent', 'minPassengers', 'confirmBy', 'bookingClosesAt', 'status', 'seatsTaken', 'seatsConfirmed', 'stopsLeft', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { code: 1 }, options: { name: 'code_unique', unique: true } },
      { key: { status: 1, direction: 1, departureAt: 1 }, options: { name: 'listing' } },
      { key: { orgId: 1, departureAt: -1 }, options: { name: 'org_recent' } },
      { key: { status: 1, confirmBy: 1 }, options: { name: 'confirm_deadline' } },
    ],
  },
  {
    name: 'bookings',
    validator: {
      $jsonSchema: bson.object(
        {
          departureId: bson.objectId,
          userId: bson.objectId,
          orderId: bson.objectId,
          slot: bson.int({ minimum: 1, maximum: MAX_SEATS_PER_STUDENT }),
          passenger: bson.nullable(bson.object({ name: bson.string({ minLength: 2, maxLength: 60 }), phone: bson.string({ pattern: '^\\+221[0-9]{9}$' }) }, ['name', 'phone'])),
          forSelf: bson.bool,
          seat: bson.int({ minimum: 1 }),
          pickupStopId: bson.string(),
          dropoffStopId: bson.string(),
          price: bson.int({ minimum: 0 }),
          method: bson.enumOf(TICKET_PAYMENT_METHODS),
          status: bson.enumOf(BOOKING_STATUSES),
          seatActive: bson.bool,
          countsForLimit: bson.bool,
          holdExpiresAt: bson.date,
        },
        ['departureId', 'userId', 'orderId', 'slot', 'passenger', 'forSelf', 'seat', 'pickupStopId', 'dropoffStopId', 'price', 'method', 'status', 'seatActive', 'countsForLimit', 'holdExpiresAt', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { requestCode: 1 }, options: { name: 'request_code', sparse: true } },
      { key: { seatCode: 1 }, options: { name: 'seat_code', sparse: true } },
      // Two students can never hold the same seat, whatever the timing.
      { key: { departureId: 1, seat: 1 }, options: { name: 'departure_seat_active_unique', unique: true, partialFilterExpression: { seatActive: true } } },
      // At most maxSeatsPerStudent purchases per student per departure (slots 1..max), still counted after giving a
      // ticket away. Two purchases at the same moment can't take the same slot.
      { key: { departureId: 1, userId: 1, slot: 1 }, options: { name: 'departure_user_slot_unique', unique: true, partialFilterExpression: { countsForLimit: true } } },
      // One seat for yourself being paid at a time (a confirmed one is a ticket: ticketing's index takes over).
      { key: { departureId: 1, userId: 1 }, options: { name: 'departure_user_self_held_unique', unique: true, partialFilterExpression: { status: 'held', forSelf: true } } },
      { key: { orderId: 1 }, options: { name: 'order' } },
      { key: { userId: 1, createdAt: -1 }, options: { name: 'user_recent' } },
      { key: { status: 1, holdExpiresAt: 1 }, options: { name: 'hold_expiry' } },
    ],
  },
];

export const caravansMigrations: DataMigration[] = [
  {
    id: '2026-11-13-retire-demo-bus-64',
    description: 'The demo « Bus 64 places » (seed plates) leave the vehicle lists: the catalog replaces them. Past and planned trips keep their snapshot.',
    async up(db) {
      await db.collection('vehicles').updateMany(
        { label: 'Bus 64 places', plate: { $in: ['DK-4821-BF', 'DK-5502-BF', 'DK-7710-AZ'] }, status: 'active' },
        { $set: { status: 'retired', updatedAt: new Date() } },
      );
    },
  },
  {
    id: '2026-11-13-vehicle-models',
    description: 'The vehicle catalog (buses 45, 49, 53, 57 places; Cheikhou Cherif 14 and 15 places), each with its seat plan: added when missing.',
    async up(db) {
      const now = new Date();
      for (const m of VEHICLE_MODELS) {
        await db.collection('vehicle_models').updateOne({ key: m.key }, { $setOnInsert: { ...m, createdAt: now } }, { upsert: true });
      }
    },
  },
  {
    id: '2026-11-05-vehicles-air-conditioning',
    description: 'Vehicles say if they are air-conditioned (no for the existing ones, vehicle and departure snapshots); the plate becomes optional (unique when set).',
    async up(db) {
      await db.collection('vehicles').updateMany({ airConditioned: { $exists: false } }, { $set: { airConditioned: false } });
      await db.collection('departures').updateMany({ 'vehicle.airConditioned': { $exists: false } }, { $set: { 'vehicle.airConditioned': false } });
      const indexes = await db.collection('vehicles').indexes();
      if (indexes.some((ix) => ix.name === 'plate_unique')) await db.collection('vehicles').dropIndex('plate_unique');
    },
  },
  {
    id: '2026-11-04-departures-payment-methods',
    description: 'Departures accept the providers chosen by the organizer: every provider for the existing ones.',
    async up(db) {
      await db.collection('departures').updateMany({ paymentMethods: { $exists: false } }, { $set: { paymentMethods: [...PAYMENT_METHODS] } });
    },
  },
  {
    id: '2026-11-01-caravans-seats-per-student',
    description: 'Departures get maxSeatsPerStudent (2); bookings get orderId (= _id), slot 1, passenger null, forSelf; the one-purchase index is replaced by slots.',
    async up(db) {
      await db.collection('departures').updateMany({ maxSeatsPerStudent: { $exists: false } }, { $set: { maxSeatsPerStudent: DEFAULT_MAX_SEATS_PER_STUDENT } });
      await db.collection('bookings').updateMany({ orderId: { $exists: false } }, [{ $set: { orderId: '$_id', slot: 1, passenger: null, forSelf: true } }]);
      const indexes = await db.collection('bookings').indexes();
      if (indexes.some((ix) => ix.name === 'departure_user_limit_unique')) await db.collection('bookings').dropIndex('departure_user_limit_unique');
    },
  },
];
