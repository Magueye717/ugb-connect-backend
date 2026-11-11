import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, Nullable, ObjectIdString, PhoneInput, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import type { OrgRole } from '../organizations/index.js';
import { PAYMENT_METHODS, PaymentView, paymentView, PayoutView, payoutView } from '../payments/index.js';
import { TICKET_PAYMENT_METHODS } from '../ticketing/index.js';
import type { CaravansService } from './caravans.service.js';
import { DEFAULT_MAX_SEATS_PER_STUDENT, DIRECTIONS, MAX_SEATS_PER_STUDENT } from './caravans.types.js';

const StopView = Type.Object({ stopId: Type.String(), place: Type.String(), at: Type.String() });
const Organizer = Type.Object({ id: Type.String(), slug: Type.String(), name: Type.String(), category: Type.String(), level: Type.String(), rating: Nullable(Type.Number()), trips: Type.Number(), logoUrl: Nullable(Type.String()) });

const Base = {
  id: Type.String(),
  code: Type.String(),
  status: Type.String({ description: 'draft | published | confirmed | cancelled | departed | completed' }),
  organizer: Organizer,
  direction: Type.String(),
  from: Type.String(),
  to: Type.String(),
  departureAt: Type.String(),
  pickups: Type.Array(StopView),
  dropoffs: Type.Array(StopView),
  price: Type.Number(),
  maxSeatsPerStudent: Type.Number({ description: 'Seats one student can buy here: their own + companions (2 by default).' }),
  paymentMethods: Type.Array(Type.String(), { description: 'The providers accepted for this trip.' }),
  totalSeats: Type.Number(),
  seatsFree: Type.Number(),
  seatsBooked: Type.Number({ description: 'Paid seats: what the minimum is measured on.' }),
  minPassengers: Type.Number(),
  confirmBy: Type.String(),
  confirmed: Type.Boolean(),
  bookingOpen: Type.Boolean(),
};

const DepartureView = Type.Object({
  ...Base,
  vehicle: Type.Object({ label: Type.String(), airConditioned: Type.Boolean(), plate: Nullable(Type.String({ description: 'Shown to ticket holders only (when the organizer gave one).' })) }),
  myTicketId: Nullable(Type.String()),
  purchasedHere: Type.Boolean({ description: 'I bought here and gave my own ticket away.' }),
  mySeatsLeft: Type.Number({ description: 'Seats I can still buy here (purchases count even once transferred).' }),
  myBooking: Nullable(
    Type.Object({
      id: Type.String(),
      seat: Type.Number(),
      holdExpiresAt: Type.String(),
      seats: Type.Array(Type.Object({ id: Type.String(), seat: Type.Number(), price: Type.Number(), code: Nullable(Type.String({ description: 'This seat’s own request code (UGBREQ:…): paid and validated on its own.' })), passenger: Nullable(Type.Object({ name: Type.String(), phone: Type.String() })) })),
      payment: Nullable(Type.Object({ reference: Type.String(), checkoutUrl: Nullable(Type.String()) })),
      awaitingValidation: Type.Boolean({ description: 'A request: to pay the organizer in cash, who then validates it (before holdExpiresAt).' }),
      organizer: Nullable(Type.Object({ name: Type.String(), phone: Type.String() }, { description: 'Who to pay and call about the request.' })),
      code: Nullable(Type.String({ description: 'The request’s code, shown as a QR code (UGBREQ:…) for the organizer to scan when paid.' })),
      total: Type.Number(),
    }),
  ),
});

const OrgDepartureView = Type.Object({
  ...Base,
  vehicle: Type.Object({ label: Type.String(), plate: Nullable(Type.String()), airConditioned: Type.Boolean() }),
  vehicleId: Type.String({ description: 'To edit a draft.' }),
  bookedStopIds: Type.Array(Type.String(), { description: 'Stops someone boards or gets off at: they stay.' }),
  bookingClosesAt: Type.String(),
  stopsLeft: Type.Array(Type.Object({ stopId: Type.String(), at: Type.String() })),
  counts: Type.Object({ booked: Type.Number({ description: 'Valid tickets (seats).' }), buyers: Type.Number({ description: 'Students who bought them.' }), admitted: Type.Number() }),
  cancellation: Nullable(Type.Object({ at: Type.String(), reason: Type.String() })),
  claim: Nullable(
    Type.Object(
      { amount: Type.Number(), payout: Nullable(Type.Object({ id: Type.String(), status: Type.String(), amount: Type.Number() })) },
      { description: 'After departure: what the owner can collect (valid tickets + late-cancellation fees), and the payout once asked for.' },
    ),
  ),
});

const ManifestView = Type.Object({
  departure: OrgDepartureView,
  passengers: Type.Array(
    Type.Object({
      ticketId: Type.String(), code: Type.String(), seat: Nullable(Type.Number()), name: Type.String(), phone: Type.String(),
      pickupStopId: Type.String(), dropoffStopId: Type.String(), admitted: Type.Boolean(), admittedAt: Nullable(Type.String()), transferred: Type.Boolean(),
      companionOf: Nullable(Type.String({ description: 'Companion ticket: the student who booked it. Check an ID, not a student card.' })),
      purchaser: Type.Object({ id: Type.String(), name: Type.String() }, { description: 'Seats with the same purchaser are shown together.' }),
      groupSize: Type.Number({ description: 'Valid tickets bought by this purchaser on the departure.' }),
    }),
  ),
});

const BookingView = Type.Object({
  id: Type.String(),
  departureId: Type.String(),
  status: Type.String({ description: 'held | confirmed | cancelled | expired' }),
  seat: Type.Number({ description: 'The first seat of the order (the student’s own if they bought one).' }),
  holdExpiresAt: Type.String(),
  ticketId: Nullable(Type.String()),
  seats: Type.Array(
    Type.Object({
      seat: Type.Number(),
      passenger: Nullable(Type.Object({ name: Type.String(), phone: Type.String() })),
      status: Type.String(),
      ticketId: Nullable(Type.String()),
    }),
    { description: 'Every seat paid with this booking’s payment.' },
  ),
  payment: Nullable(Type.Object({ reference: Type.String(), status: Type.String(), amount: Type.Number(), checkoutUrl: Nullable(Type.String()) })),
});

const StopInput = Type.Object({ place: Type.String({ minLength: 2, maxLength: 80 }), at: Type.String({ format: 'date-time' }) }, { additionalProperties: false });
const DepartureInput = Type.Object(
  {
    vehicleId: ObjectIdString,
    direction: Type.Enum(DIRECTIONS),
    from: Type.String({ minLength: 2, maxLength: 40 }),
    to: Type.String({ minLength: 2, maxLength: 40 }),
    pickups: Type.Array(StopInput, { minItems: 1, maxItems: 15 }),
    dropoffs: Type.Array(StopInput, { minItems: 1, maxItems: 15 }),
    price: Type.Integer({ minimum: 100, maximum: 100_000 }),
    maxSeatsPerStudent: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEATS_PER_STUDENT, description: 'Seats one student can buy (own + companions). Default 2.' })),
    paymentMethods: Type.Optional(
      Type.Array(Type.Enum(TICKET_PAYMENT_METHODS), { minItems: 1, maxItems: TICKET_PAYMENT_METHODS.length, description: 'Wave, Orange Money and/or cash (paid at boarding). Default: Wave and Orange Money.' }),
    ),
    minPassengers: Type.Integer({ minimum: 0, maximum: 90 }),
    confirmBy: Type.Optional(Type.String({ format: 'date-time', description: 'Default: 24 h before departure.' })),
    bookingClosesAt: Type.Optional(Type.String({ format: 'date-time', description: 'Default: 30 min before departure.' })),
  },
  { additionalProperties: false },
);
const VehicleView = Type.Object({ id: Type.String(), label: Type.String(), plate: Nullable(Type.String()), airConditioned: Type.Boolean(), capacity: Type.Number(), seatsPerRow: Type.Number(), blockedSeats: Type.Array(Type.Number()) });

const OrgParams = Type.Object({ orgId: ObjectIdString }, { additionalProperties: false });
const OrgDepParams = Type.Object({ orgId: ObjectIdString, id: ObjectIdString }, { additionalProperties: false });

type Deps = {
  service: CaravansService;
  audit: AuditApi;
  requireStudent: preHandlerHookHandler;
  requireOrgRole: (roles: OrgRole[], space?: 'organizer') => preHandlerHookHandler;
};

const baseUrlOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export function registerCaravansRoutes(root: FastifyInstance, { service, audit, requireStudent, requireOrgRole }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const student = { preHandler: [requireAuth, requireStudent] };
  const tags = ['caravans'];
  const org = (roles: OrgRole[]) => ({ preHandler: [requireAuth, requireOrgRole(roles, 'organizer')] });
  const crew: OrgRole[] = ['owner', 'manager', 'scanner'];
  const managers: OrgRole[] = ['owner', 'manager'];
  const orgTags = ['organizer'];

  // ---- Student ---------------------------------------------------------------------------------------------------

  app.get(
    '/caravans/departures',
    {
      ...student,
      schema: { tags, querystring: Type.Object({ direction: Type.Optional(Type.Enum(DIRECTIONS)) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(DepartureView) }) } },
    },
    async (req) => ({ items: await service.list(me(req), req.query.direction) }),
  );

  app.get('/caravans/departures/:id', { ...student, schema: { tags, params: IdParams, response: { 200: DepartureView } } }, async (req) => {
    const [view] = await service.views([await service.get(toObjectId(req.params.id))], me(req));
    return view!;
  });

  app.get(
    '/caravans/departures/:id/seats',
    {
      ...student,
      schema: {
        tags,
        params: IdParams,
        response: { 200: Type.Object({ capacity: Type.Number(), seatsPerRow: Type.Number(), firstRowSeats: Type.Number({ description: 'Seats of the first row, on the right; then full rows. Numbered from the front.' }), blocked: Type.Array(Type.Number()), taken: Type.Array(Type.Number()), suggested: Nullable(Type.Number()) }) },
      },
    },
    async (req) => service.seatMap(toObjectId(req.params.id)),
  );

  app.post(
    '/caravans/departures/:id/bookings',
    {
      ...student,
      schema: {
        tags,
        params: IdParams,
        body: Type.Object(
          {
            seat: Type.Optional(Type.Integer({ minimum: 1, description: 'One seat for myself. Omit to let the server pick ("Choisis pour moi"). Ignored when `seats` is sent.' })),
            seats: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    seat: Type.Optional(Type.Integer({ minimum: 1, description: 'Omit to let the server pick.' })),
                    passenger: Type.Optional(
                      Type.Object(
                        { name: Type.String({ minLength: 2, maxLength: 60 }), phone: PhoneInput },
                        { additionalProperties: false, description: 'A companion (no account needed). Omit for my own seat (one at most).' },
                      ),
                    ),
                    pickupStopId: Type.Optional(Type.String({ maxLength: 20, description: 'A companion boarding elsewhere (default: the booking’s).' })),
                    dropoffStopId: Type.Optional(Type.String({ maxLength: 20, description: 'A companion getting off elsewhere (default: the booking’s).' })),
                  },
                  { additionalProperties: false },
                ),
                { minItems: 1, maxItems: MAX_SEATS_PER_STUDENT, description: 'Several seats paid at once: mine and/or companions’, up to maxSeatsPerStudent.' },
              ),
            ),
            pickupStopId: Type.String({ maxLength: 20 }),
            dropoffStopId: Type.String({ maxLength: 20 }),
            method: Type.Optional(Type.Enum(TICKET_PAYMENT_METHODS, { description: 'Ignored: seats are paid to the organizer in cash, who then validates the request.' })),
            returnUrl: Type.Optional(Type.String({ maxLength: 300 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ booking: BookingView, payment: Nullable(PaymentView) }), 201: Type.Object({ booking: BookingView, payment: Nullable(PaymentView) }) },
      },
    },
    async (req, reply) => {
      const { booking, payment, replay } = await service.book(me(req), toObjectId(req.params.id), req.body, baseUrlOf(req));
      return reply.status(replay ? 200 : 201).send({ booking: await service.booking(me(req), booking._id), payment: payment ? paymentView(payment) : null });
    },
  );

  app.get('/caravans/bookings/:id', { ...student, schema: { tags, params: IdParams, response: { 200: BookingView } } }, async (req) =>
    service.booking(me(req), toObjectId(req.params.id)),
  );

  app.delete('/caravans/bookings/:id', { ...student, schema: { tags, params: IdParams } }, async (req, reply) => {
    await service.release(me(req), toObjectId(req.params.id));
    return reply.status(204).send();
  });

  // ---- Organizer: the day of the trip ----------------------------------------------------------------------------

  app.get(
    '/org/:orgId/departures',
    {
      ...org(crew),
      schema: {
        tags: orgTags,
        params: OrgParams,
        querystring: Type.Object({ scope: Type.Optional(Type.Enum(['upcoming', 'past'] as const)) }, { additionalProperties: false }),
        response: { 200: Type.Object({ items: Type.Array(OrgDepartureView) }) },
      },
    },
    async (req) => ({ items: await service.activities(toObjectId(req.params.orgId), req.query.scope ?? 'upcoming') }),
  );

  app.get('/org/:orgId/departures/:id', { ...org(crew), schema: { tags: orgTags, params: OrgDepParams, response: { 200: OrgDepartureView } } }, async (req) =>
    service.orgDeparture(toObjectId(req.params.orgId), toObjectId(req.params.id)),
  );

  app.get(
    '/org/:orgId/departures/:id/manifest',
    {
      ...org(crew),
      schema: {
        tags: orgTags,
        params: OrgDepParams,
        response: { 200: ManifestView },
      },
    },
    async (req) => {
      const res = await service.manifest(toObjectId(req.params.orgId), toObjectId(req.params.id));
      // Names and phone numbers: every read is traced.
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'manifest.view', target: { type: 'departure', id: req.params.id }, requestId: req.id });
      return res;
    },
  );

  // Before leaving town: what the scanner needs to work without network (list, ticket versions, public key).
  app.get(
    '/org/:orgId/departures/:id/offline-pack',
    {
      ...org(crew),
      schema: {
        tags: orgTags,
        params: OrgDepParams,
        response: {
          200: Type.Object({
            generatedAt: Type.String(),
            key: Type.Object({ kid: Type.String(), alg: Type.String(), x: Type.String({ description: 'Ed25519 public key (base64url) that checks ticket QR signatures.' }) }),
            versions: Type.Record(Type.String(), Type.Number(), { description: 'ticketId → current QR version (older ones were transferred away).' }),
            codes: Type.Record(Type.String(), Type.String(), { description: 'typed code → ticketId' }),
            cash: Type.Record(Type.String(), Type.Number(), { description: 'ticketId → FCFA still to collect in cash at boarding.' }),
            manifest: ManifestView,
          }),
        },
      },
    },
    async (req) => {
      const pack = await service.offlinePack(toObjectId(req.params.orgId), toObjectId(req.params.id));
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'manifest.offline_pack', target: { type: 'departure', id: req.params.id }, requestId: req.id });
      return pack;
    },
  );

  app.post(
    '/org/:orgId/departures/:id/stops/:stopId/leave',
    {
      ...org(crew),
      schema: {
        tags: orgTags,
        params: Type.Object({ orgId: ObjectIdString, id: ObjectIdString, stopId: Type.String({ maxLength: 20 }) }, { additionalProperties: false }),
        // No body when online; { leftAt } when sent later by a phone that was offline.
        body: Type.Optional(Nullable(Type.Object({ leftAt: Type.Optional(Type.String({ format: 'date-time', description: 'Left offline: when (sent once the network is back).' })) }, { additionalProperties: false }))),
        response: { 200: Type.Object({ absent: Type.Array(Type.Object({ ticketId: Type.String(), seat: Nullable(Type.Number()) })) }) },
      },
    },
    async (req) => service.leaveStop(toObjectId(req.params.orgId), toObjectId(req.params.id), req.params.stopId, me(req), req.body?.leftAt ? new Date(req.body.leftAt) : undefined),
  );

  app.post(
    '/org/:orgId/departures/:id/claim',
    { ...org(['owner']), schema: { tags: orgTags, params: OrgDepParams, body: Type.Object({ method: Type.Enum(PAYMENT_METHODS) }, { additionalProperties: false }), response: { 200: PayoutView } } },
    async (req) => {
      const payout = await service.claim(toObjectId(req.params.orgId), toObjectId(req.params.id), me(req), req.body.method);
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'departure.claim', target: { type: 'departure', id: req.params.id }, requestId: req.id, metadata: { amount: payout.amount } });
      return payoutView(payout);
    },
  );

  // ---- Organizer: vehicles and departures (created from the organizer space of the app) -----------------------

  const vehicleView = (v: { _id: { toHexString(): string }; label: string; plate: string | null; airConditioned: boolean; capacity: number; seatsPerRow: number; blockedSeats: number[] }) => ({
    id: v._id.toHexString(), label: v.label, plate: v.plate, airConditioned: v.airConditioned, capacity: v.capacity, seatsPerRow: v.seatsPerRow, blockedSeats: v.blockedSeats,
  });

  const Limits = Type.Object(
    { maxSeatsPerStudent: Type.Number(), defaultSeatsPerStudent: Type.Number() },
    { description: 'What the departure form allows: seats one student can buy (own + companions).' },
  );
  app.get(
    '/org/:orgId/vehicles',
    { ...org(managers), schema: { tags: orgTags, params: OrgParams, response: { 200: Type.Object({ items: Type.Array(VehicleView), limits: Limits }) } } },
    async (req) => ({
      items: (await service.listVehicles(toObjectId(req.params.orgId))).map(vehicleView),
      limits: { maxSeatsPerStudent: MAX_SEATS_PER_STUDENT, defaultSeatsPerStudent: DEFAULT_MAX_SEATS_PER_STUDENT },
    }),
  );

  app.post(
    '/org/:orgId/vehicles',
    {
      ...org(['owner']),
      schema: {
        tags: orgTags,
        params: OrgParams,
        body: Type.Object(
          {
            label: Type.String({ minLength: 2, maxLength: 60 }),
            plate: Type.Optional(Nullable(Type.String({ minLength: 4, maxLength: 15, pattern: '^[A-Za-z0-9 -]+$', description: 'Optional.' }))),
            airConditioned: Type.Optional(Type.Boolean({ description: 'Shown to students ("Climatisé"). Default false.' })),
            capacity: Type.Integer({ minimum: 4, maximum: 90 }),
            seatsPerRow: Type.Optional(Type.Integer({ minimum: 2, maximum: 6, description: '4 (default): 2 + aisle + 2. 5: with the folding middle seat (« versailler »).' })),
            blockedSeats: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 20 })),
          },
          { additionalProperties: false },
        ),
        response: { 201: VehicleView },
      },
    },
    async (req, reply) => reply.status(201).send(vehicleView(await service.createVehicle(toObjectId(req.params.orgId), req.body))),
  );

  const OrgVehicleParams = Type.Object({ orgId: ObjectIdString, id: ObjectIdString }, { additionalProperties: false });
  app.put(
    '/org/:orgId/vehicles/:id',
    {
      ...org(['owner']),
      schema: {
        tags: orgTags,
        params: OrgVehicleParams,
        body: Type.Object(
          {
            label: Type.String({ minLength: 2, maxLength: 60 }),
            capacity: Type.Integer({ minimum: 4, maximum: 90 }),
            airConditioned: Type.Boolean(),
            seatsPerRow: Type.Optional(Type.Integer({ minimum: 2, maximum: 6, description: '4: 2 + aisle + 2. 5: with the folding middle seat (« versailler »).' })),
          },
          { additionalProperties: false, description: 'Drafts take the change; published departures keep the vehicle they were sold with.' },
        ),
        response: { 200: VehicleView },
      },
    },
    async (req) => vehicleView(await service.updateVehicle(toObjectId(req.params.orgId), toObjectId(req.params.id), req.body)),
  );

  app.delete('/org/:orgId/vehicles/:id', { ...org(['owner']), schema: { tags: orgTags, params: OrgVehicleParams } }, async (req, reply) => {
    await service.retireVehicle(toObjectId(req.params.orgId), toObjectId(req.params.id));
    await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'vehicle.retire', target: { type: 'vehicle', id: req.params.id }, requestId: req.id });
    return reply.status(204).send();
  });

  const orgView = async (orgId: string, id: { toHexString(): string }) => service.orgDeparture(toObjectId(orgId), toObjectId(id.toHexString()));

  app.post('/org/:orgId/departures', { ...org(managers), schema: { tags: orgTags, params: OrgParams, body: DepartureInput, response: { 201: OrgDepartureView } } }, async (req, reply) => {
    const d = await service.createDeparture(toObjectId(req.params.orgId), req.body);
    return reply.status(201).send(await orgView(req.params.orgId, d._id));
  });

  app.put('/org/:orgId/departures/:id', { ...org(managers), schema: { tags: orgTags, params: OrgDepParams, body: DepartureInput, response: { 200: OrgDepartureView } } }, async (req) => {
    const d = await service.updateDeparture(toObjectId(req.params.orgId), toObjectId(req.params.id), req.body);
    return orgView(req.params.orgId, d._id);
  });

  app.patch(
    '/org/:orgId/departures/:id',
    {
      ...org(managers),
      schema: {
        tags: orgTags,
        params: OrgDepParams,
        description: 'Published, before the bus leaves: add stops, remove the ones nobody booked (never the departure), or a vehicle with as many seats or more.',
        body: Type.Object(
          {
            pickups: Type.Optional(Type.Array(StopInput, { maxItems: 14, description: 'New pickups only (after the departure).' })),
            dropoffs: Type.Optional(Type.Array(StopInput, { maxItems: 14, description: 'New drop-offs only.' })),
            vehicleId: Type.Optional(ObjectIdString),
            remove: Type.Optional(Type.Array(Type.String({ maxLength: 20 }), { maxItems: 30, description: 'stopIds to remove: only those not in bookedStopIds.' })),
          },
          { additionalProperties: false },
        ),
        response: { 200: OrgDepartureView },
      },
    },
    async (req) => {
      const d = await service.extendDeparture(toObjectId(req.params.orgId), toObjectId(req.params.id), req.body);
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'departure.extend', target: { type: 'departure', id: req.params.id }, requestId: req.id, metadata: { pickups: req.body.pickups?.length ?? 0, dropoffs: req.body.dropoffs?.length ?? 0, removed: req.body.remove ?? [], vehicle: !!req.body.vehicleId } });
      return orgView(req.params.orgId, d._id);
    },
  );

  app.post('/org/:orgId/departures/:id/publish', { ...org(managers), schema: { tags: orgTags, params: OrgDepParams, response: { 200: OrgDepartureView } } }, async (req) => {
    const d = await service.publish(toObjectId(req.params.orgId), toObjectId(req.params.id));
    await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'departure.publish', target: { type: 'departure', id: req.params.id }, requestId: req.id });
    return orgView(req.params.orgId, d._id);
  });

  app.post(
    '/org/:orgId/departures/:id/cancel',
    {
      ...org(managers),
      schema: { tags: orgTags, params: OrgDepParams, body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 200 }) }, { additionalProperties: false }), response: { 200: Type.Object({ refunded: Type.Number() }) } },
    },
    async (req) => {
      const res = await service.cancelDeparture(toObjectId(req.params.orgId), toObjectId(req.params.id), 'organizer', req.body.reason);
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'departure.cancel', target: { type: 'departure', id: req.params.id }, requestId: req.id, metadata: { reason: req.body.reason, ...res } });
      return res;
    },
  );

  // ---- Requests: the student pays the organizer in cash, the organizer validates (within 24 h) ---------------------

  const RequestView = Type.Object({
    id: Type.String({ description: 'The order: its seats waiting are validated all together, or some (bookingIds); refused together.' }), status: Type.String(), total: Type.Number(), expiresAt: Type.String(), createdAt: Type.String(),
    student: Nullable(Type.Object({ name: Type.String(), phone: Type.String() })),
    seats: Type.Array(Type.Object({ id: Type.String(), seat: Type.Number(), price: Type.Number(), code: Nullable(Type.String()), passenger: Nullable(Type.String()), pickup: Type.String(), dropoff: Type.String() })),
  });
  // No body (validate all), or the ones paid.
  const ValidateBody = Nullable(Type.Object({ bookingIds: Type.Optional(Type.Array(ObjectIdString, { minItems: 1, maxItems: 20 })) }, { additionalProperties: false }));
  const RequestParams = Type.Object({ orgId: ObjectIdString, orderId: ObjectIdString }, { additionalProperties: false });
  const trace = (req: FastifyRequest<{ Params: { orderId: string } }>, action: string) =>
    audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type: 'caravan_order', id: req.params.orderId }, requestId: req.id });

  app.get('/org/:orgId/departures/:id/requests', { ...org(crew), schema: { tags: orgTags, params: OrgDepParams, response: { 200: Type.Object({ items: Type.Array(RequestView) }) } } }, async (req) => ({
    items: await service.requests(toObjectId(req.params.orgId), toObjectId(req.params.id)),
  }));
  app.get(
    '/org/:orgId/departures/requests/by-code/:code',
    { ...org(crew), schema: { tags: orgTags, params: Type.Object({ orgId: ObjectIdString, code: Type.String({ maxLength: 40 }) }), response: { 200: Type.Object({ request: Nullable(Type.Object({ ...RequestView.properties, title: Type.String(), matched: Nullable(Type.String({ description: 'The seat whose own code was given; null: the whole request’s code.' })) })) }) } } },
    async (req) => ({ request: await service.requestByCode(toObjectId(req.params.orgId), req.params.code) }),
  );
  app.post('/org/:orgId/departures/requests/:orderId/validate', { ...org(crew), schema: { tags: orgTags, params: RequestParams, body: ValidateBody, description: 'Cash received: the seats’ tickets are issued, valid and scannable. `bookingIds`: only those seats; all waiting otherwise.', response: { 200: RequestView } } }, async (req) => {
    const res = await service.validateRequest(toObjectId(req.params.orgId), toObjectId(req.params.orderId), req.body?.bookingIds);
    await trace(req, 'caravan.request_validated');
    return res;
  });
  app.post(
    '/org/:orgId/departures/requests/:orderId/refuse',
    { ...org(crew), schema: { tags: orgTags, params: RequestParams, body: Type.Object({ reason: Type.Optional(Nullable(Type.String({ maxLength: 200 }))) }, { additionalProperties: false }) } },
    async (req, reply) => {
      await service.refuseRequest(toObjectId(req.params.orgId), toObjectId(req.params.orderId), req.body.reason ?? null);
      await trace(req, 'caravan.request_refused');
      return reply.status(204).send();
    },
  );
}
