import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { errors } from '../../platform/http/errors.js';
import { IdParams, Nullable, ObjectIdString, toObjectId } from '../../platform/http/schemas.js';
import { CAMPUSES, REGIONS, UFR_CODES, VILLAGES } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { OrgRole } from '../organizations/index.js';
import { PAYMENT_METHODS, PaymentView, paymentView, PayoutView, payoutView } from '../payments/index.js';
import type { EventsService } from './events.service.js';
import { EVENT_CATEGORIES, PUBLICATION_FEE } from './events.types.js';
import { TICKET_PAYMENT_METHODS } from '../ticketing/index.js';

const Organizer = Type.Object({ id: Type.String(), slug: Type.String(), name: Type.String(), category: Type.String(), level: Type.String(), rating: Nullable(Type.Number()), trips: Type.Number(), logoUrl: Nullable(Type.String()) });
const Base = {
  id: Type.String(),
  code: Type.String(),
  status: Type.String({ description: 'draft | pending_review | changes_requested | rejected | approved (to pay and publish) | published | cancelled | completed' }),
  organizer: Organizer,
  title: Type.String(),
  category: Type.String({ description: EVENT_CATEGORIES.join(' | ') }),
  categoryLabel: Type.String(),
  description: Type.String(),
  images: Type.Array(Type.String(), { description: 'Image URLs, the first is the cover (the app slides them).' }),
  venue: Type.Object({ name: Type.String(), address: Nullable(Type.String()) }),
  startsAt: Type.String(),
  endsAt: Type.String(),
  salesCloseAt: Type.String(),
  salesOpen: Type.Boolean(),
  minPrice: Type.Number({ description: '0: free.' }),
  maxPerStudent: Type.Number(),
  paymentMethods: Type.Array(Type.String({ description: 'wave | orange_money | cash' }), { description: 'How students may pay for this event.' }),
  cancellation: Nullable(Type.Object({ at: Type.String(), reason: Type.String() })),
  review: Nullable(Type.Object({ message: Type.String(), at: Type.String() }, { description: 'Student’s event: what the admins asked to correct, or why it was refused.' })),
};
const EventView = Type.Object({
  ...Base,
  ticketTypes: Type.Array(Type.Object({ typeId: Type.String(), name: Type.String(), description: Nullable(Type.String()), price: Type.Number(), remaining: Type.Number(), soldOut: Type.Boolean() })),
  myTickets: Type.Array(Type.String(), { description: 'My ticket ids for this event.' }),
  myTicketsLeft: Type.Number({ description: 'Tickets I can still buy (maxPerStudent, all orders together).' }),
  organizedByMe: Type.Boolean({ description: 'I am on the organizing team: I may only order for friends (forFriends), otherwise 422 OWN_EVENT.' }),
  myBooking: Nullable(Type.Object({ id: Type.String(), total: Type.Number(), holdExpiresAt: Type.String(), payment: Nullable(Type.Object({ reference: Type.String(), checkoutUrl: Nullable(Type.String()) })) })),
});
const OrgEventView = Type.Object({
  ...Base,
  ticketTypes: Type.Array(Type.Object({ typeId: Type.String(), name: Type.String(), description: Nullable(Type.String()), price: Type.Number(), capacity: Type.Number(), sold: Type.Number(), remaining: Type.Number(), soldOut: Type.Boolean() })),
  counts: Type.Object({ booked: Type.Number(), buyers: Type.Number(), admitted: Type.Number() }),
  claim: Nullable(Type.Object({ amount: Type.Number(), payout: Nullable(Type.Object({ id: Type.String(), status: Type.String(), amount: Type.Number() })) })),
  reviewLog: Type.Array(Type.Object({ at: Type.String(), action: Type.String({ description: 'submitted | approved | changes_requested | rejected' }), message: Nullable(Type.String()) })),  imageIds: Type.Array(Type.String(), { description: 'Same order as images: send them back when editing.' }),
  fixedCover: Type.Boolean({ description: 'The first picture is the chosen cover; otherwise the banner picks one at random.' }),
  audience: Type.Object({ campuses: Type.Array(Type.String()), ufrs: Type.Array(Type.String()), regions: Type.Array(Type.String()), villages: Type.Array(Type.String()) }, { description: 'Who sees it on the home screen; all empty: the whole university.' }),
  publicationFee: Type.Object({ perPlace: Type.Number(), minimum: Type.Number() }, { description: 'Students’ events: the publication costs perPlace × places, at least minimum.' }),
  publication: Nullable(Type.Object({ places: Type.Number(), fee: Type.Number(), paid: Type.Boolean(), payment: Nullable(Type.Object({ reference: Type.String(), checkoutUrl: Nullable(Type.String()) }, { description: 'Being paid: reopen the checkout.' })) })),
});
const AudienceInput = Type.Object(
  {
    campuses: Type.Array(Type.Enum(CAMPUSES), { maxItems: 2 }),
    ufrs: Type.Array(Type.Enum(UFR_CODES), { maxItems: 10 }),
    regions: Type.Array(Type.Enum(REGIONS), { maxItems: 20 }),
    villages: Type.Array(Type.Enum([...VILLAGES.campus1, ...VILLAGES.campus2]), { maxItems: 20 }),
  },
  { additionalProperties: false, description: 'Each non-empty list narrows: Campus 1 + UFR SAT = SAT students living on Campus 1. All empty: the whole university.' },
);
const PublicationInput = Type.Object(
  {
    audience: AudienceInput,
    places: Type.Array(Type.Object({ typeId: Type.String({ maxLength: 8 }), capacity: Type.Integer({ minimum: 1, maximum: 50_000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 6, description: 'Places on sale per ticket type: the fee is counted on them.' }),
    description: Type.Optional(Type.String({ maxLength: 3000 })),
    imageIds: Type.Optional(Type.Array(ObjectIdString, { minItems: 1, maxItems: 8 })),
    fixedCover: Type.Optional(Type.Boolean()),
    address: Type.Optional(Nullable(Type.String({ maxLength: 160 }))),
    maxPerStudent: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    method: Type.Enum(PAYMENT_METHODS),
    returnUrl: Type.Optional(Type.String({ maxLength: 300 })),
  },
  { additionalProperties: false },
);
const BookingView = Type.Object({
  id: Type.String(),
  eventId: Type.String(),
  status: Type.String({ description: 'held | confirmed | cancelled | expired' }),
  total: Type.Number(),
  holdExpiresAt: Type.String(),
  tickets: Type.Array(Type.Object({ typeId: Type.String(), name: Type.String(), price: Type.Number(), status: Type.String(), ticketId: Nullable(Type.String()) })),
  payment: Nullable(Type.Object({ reference: Type.String(), status: Type.String(), checkoutUrl: Nullable(Type.String()) })),
});
const EventInput = Type.Object(
  {
    title: Type.String({ minLength: 3, maxLength: 80 }),
    category: Type.Enum(EVENT_CATEGORIES),
    description: Type.String({ maxLength: 3000 }),
    imageIds: Type.Array(ObjectIdString, { minItems: 1, maxItems: 8, description: 'Uploaded with POST /media/images?purpose=event; the first is the cover.' }),
    fixedCover: Type.Optional(Type.Boolean({ description: 'true: the first picture is always the cover. false (default): the banner shows one of the pictures at random.' })),
    venue: Type.Object({ name: Type.String({ minLength: 2, maxLength: 80 }), address: Type.Optional(Nullable(Type.String({ maxLength: 160 }))) }, { additionalProperties: false }),
    startsAt: Type.String({ format: 'date-time' }),
    endsAt: Type.String({ format: 'date-time' }),
    salesCloseAt: Type.Optional(Type.String({ format: 'date-time', description: 'Default: the start.' })),
    ticketTypes: Type.Array(
      Type.Object(
        { name: Type.String({ minLength: 2, maxLength: 40 }), description: Type.Optional(Nullable(Type.String({ maxLength: 120 }))), price: Type.Integer({ minimum: 0, maximum: 1_000_000, description: '0: free.' }), capacity: Type.Integer({ minimum: 1, maximum: 50_000 }) },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 6 },
    ),
    maxPerStudent: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Tickets per student, all orders together. Default 4.' })),
    paymentMethods: Type.Optional(
      Type.Array(Type.Enum(TICKET_PAYMENT_METHODS), { minItems: 1, maxItems: TICKET_PAYMENT_METHODS.length, description: 'Wave, Orange Money and/or cash (paid at the door). Default: Wave and Orange Money.' }),
    ),
  },
  { additionalProperties: false },
);
const PhotosInput = Type.Object(
  {
    imageIds: Type.Array(ObjectIdString, { minItems: 1, maxItems: 8, description: 'Some of the event’s own pictures, in the new order (the first is the cover).' }),
    fixedCover: Type.Boolean({ description: 'The first picture is the cover of its banners; otherwise one at random.' }),
  },
  { additionalProperties: false },
);
const OrgParams = Type.Object({ orgId: ObjectIdString }, { additionalProperties: false });
const OrgEventParams = Type.Object({ orgId: ObjectIdString, id: ObjectIdString }, { additionalProperties: false });

type Deps = { service: EventsService; audit: AuditApi; requireOrgRole: (roles: OrgRole[], space?: 'organizer') => preHandlerHookHandler; requireStudent: preHandlerHookHandler; requireAdmin: preHandlerHookHandler };
const baseUrlOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export function registerEventsRoutes(root: FastifyInstance, { service, audit, requireOrgRole, requireStudent, requireAdmin }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['events'];
  const org = (roles: OrgRole[]) => ({ preHandler: [requireAuth, requireOrgRole(roles, 'organizer')] });
  const managers: OrgRole[] = ['owner', 'manager'];
  const crew: OrgRole[] = ['owner', 'manager', 'scanner'];
  const trace = (req: FastifyRequest, action: string, id: string, metadata?: Record<string, unknown>) =>
    audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type: 'event', id }, requestId: req.id, ...(metadata ? { metadata } : {}) });

  // ---- Everyone signed in ----------------------------------------------------------------------------------------

  app.get('/events', { preHandler: requireAuth, schema: { tags, response: { 200: Type.Object({ items: Type.Array(EventView) }) } } }, async (req) => ({ items: await service.list(me(req)) }));

  app.get('/events/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: EventView } } }, async (req) => (await service.views([await service.get(toObjectId(req.params.id))], me(req)))[0]!);

  app.post(
    '/events/:id/bookings',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        params: IdParams,
        body: Type.Object(
          {
            items: Type.Array(Type.Object({ typeId: Type.String({ maxLength: 8 }), qty: Type.Integer({ minimum: 0, maximum: 20 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 6 }),
            method: Type.Enum(TICKET_PAYMENT_METHODS, { description: 'One the event accepts. cash: the tickets are issued at once, paid at the door (payment is null).' }),
            forFriends: Type.Optional(Type.Boolean({ description: 'Its organizing team orders only so (otherwise 422 OWN_EVENT): every ticket is one to give, none is theirs.' })),
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

  app.get('/events/bookings/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: BookingView } } }, async (req) => service.booking(me(req), toObjectId(req.params.id)));

  app.delete('/events/bookings/:id', { preHandler: requireAuth, schema: { tags, params: IdParams } }, async (req, reply) => {
    await service.release(me(req), toObjectId(req.params.id));
    return reply.status(204).send();
  });

  // ---- Students organizing their own events (reviewed by the admins) ---------------------------------------------

  const student = { preHandler: [requireAuth, requireStudent] };
  const myOrg = async (req: FastifyRequest, create = false) => {
    const orgId = await service.personalOrgOf(me(req), create);
    if (!orgId) throw errors.notFound('Événement introuvable.');
    return orgId;
  };

  app.get('/me/events', { ...student, schema: { tags, response: { 200: Type.Object({ items: Type.Array(OrgEventView) }) } } }, async (req) => {
    const orgId = await service.personalOrgOf(me(req), false);
    return { items: orgId ? await service.listForOrg(orgId) : [] };
  });

  app.get(
    '/me/events/publication-fee',
    { ...student, schema: { tags, description: 'What publishing will cost once approved: perPlace × places, at least minimum. Shown while creating the event.', response: { 200: Type.Object({ perPlace: Type.Number(), minimum: Type.Number() }) } } },
    async () => PUBLICATION_FEE,
  );

  app.get('/me/events/:id', { ...student, schema: { tags, params: IdParams, response: { 200: OrgEventView } } }, async (req) => service.orgEvent(await myOrg(req), toObjectId(req.params.id)));

  app.post('/me/events', { ...student, schema: { tags, description: 'A draft; submit it for the admins’ review.', body: EventInput, response: { 201: OrgEventView } } }, async (req, reply) => {
    const e = await service.create(await myOrg(req, true), me(req), req.body);
    await trace(req, 'event.create', e._id.toHexString(), { by: 'student' });
    return reply.status(201).send(await service.orgEvent(e.orgId, e._id));
  });

  app.put('/me/events/:id', { ...student, schema: { tags, params: IdParams, body: EventInput, response: { 200: OrgEventView } } }, async (req) => {
    const orgId = await myOrg(req);
    const e = await service.update(orgId, toObjectId(req.params.id), me(req), req.body);
    await trace(req, 'event.update', req.params.id, { by: 'student' });
    return service.orgEvent(orgId, e._id);
  });

  app.put(
    '/me/events/:id/photos',
    { ...student, schema: { tags, params: IdParams, description: 'A published event: reorder its pictures, pick the cover, take some off.', body: PhotosInput, response: { 200: OrgEventView } } },
    async (req) => {
      const orgId = await myOrg(req);
      const e = await service.updatePhotos(orgId, toObjectId(req.params.id), req.body);
      await trace(req, 'event.photos', req.params.id, { by: 'student', count: req.body.imageIds.length, fixedCover: req.body.fixedCover });
      return service.orgEvent(orgId, e._id);
    },
  );

  app.post('/me/events/:id/submit', { ...student, schema: { tags, params: IdParams, response: { 200: OrgEventView } } }, async (req) => {
    const orgId = await myOrg(req);
    const e = await service.publish(orgId, toObjectId(req.params.id), me(req));
    await trace(req, 'event.submit', req.params.id);
    return service.orgEvent(orgId, e._id);
  });

  app.post(
    '/me/events/:id/publish',
    {
      ...student,
      schema: {
        tags,
        params: IdParams,
        description: 'An approved event: who sees it, the places on sale, a few touch-ups; opens the payment (per place). Paid, it is published.',
        body: PublicationInput,
        response: { 200: Type.Object({ event: OrgEventView, payment: PaymentView }) },
      },
    },
    async (req) => {
      const orgId = await myOrg(req);
      const { event, payment } = await service.publishPaid(orgId, toObjectId(req.params.id), me(req), req.body, baseUrlOf(req));
      await trace(req, 'event.publication_payment', req.params.id, { fee: payment.amount });
      return { event: await service.orgEvent(orgId, event._id), payment: paymentView(payment) };
    },
  );

  app.post(
    '/me/events/:id/cancel',
    { ...student, schema: { tags, params: IdParams, body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 200 }) }, { additionalProperties: false }), response: { 200: Type.Object({ refunded: Type.Number() }) } } },
    async (req) => {
      const res = await service.cancel(await myOrg(req), toObjectId(req.params.id), req.body.reason);
      await trace(req, 'event.cancel', req.params.id, { reason: req.body.reason, ...res });
      return res;
    },
  );

  // ---- Admins: the review of students' events --------------------------------------------------------------------

  const admin = { preHandler: [requireAuth, requireAdmin] };
  app.get(
    '/admin/events',
    { ...admin, schema: { tags, querystring: Type.Object({ status: Type.Optional(Type.Enum(['pending_review', 'changes_requested', 'rejected'] as const)) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(OrgEventView) }) } } },
    async (req) => ({ items: await service.listForReview(req.query.status) }),
  );

  app.post('/admin/events/:id/approve', { ...admin, schema: { tags, params: IdParams, response: { 200: OrgEventView } } }, async (req) => {
    const e = await service.approve(toObjectId(req.params.id), me(req));
    await trace(req, 'event.approve', req.params.id);
    return service.orgEvent(e.orgId, e._id);
  });

  const Message = Type.Object({ message: Type.String({ minLength: 5, maxLength: 500, description: 'Sent to the student (notification) and shown on their event.' }) }, { additionalProperties: false });
  app.post('/admin/events/:id/request-changes', { ...admin, schema: { tags, params: IdParams, body: Message, response: { 200: OrgEventView } } }, async (req) => {
    const e = await service.requestChanges(toObjectId(req.params.id), me(req), req.body.message);
    await trace(req, 'event.request_changes', req.params.id, { message: req.body.message });
    return service.orgEvent(e.orgId, e._id);
  });

  app.post('/admin/events/:id/reject', { ...admin, schema: { tags, params: IdParams, body: Message, response: { 200: OrgEventView } } }, async (req) => {
    const e = await service.reject(toObjectId(req.params.id), me(req), req.body.message);
    await trace(req, 'event.reject', req.params.id, { message: req.body.message });
    return service.orgEvent(e.orgId, e._id);
  });

  // ---- Organizations verified for events (back office meanwhile; the app lists and scans) ------------------------

  app.get('/org/:orgId/events', { ...org(crew), schema: { tags, params: OrgParams, response: { 200: Type.Object({ items: Type.Array(OrgEventView) }) } } }, async (req) => ({
    items: await service.listForOrg(toObjectId(req.params.orgId)),
  }));

  app.get('/org/:orgId/events/:id', { ...org(crew), schema: { tags, params: OrgEventParams, response: { 200: OrgEventView } } }, async (req) =>
    service.orgEvent(toObjectId(req.params.orgId), toObjectId(req.params.id)),
  );

  app.post('/org/:orgId/events', { ...org(managers), schema: { tags, params: OrgParams, body: EventInput, response: { 201: OrgEventView } } }, async (req, reply) => {
    const e = await service.create(toObjectId(req.params.orgId), me(req), req.body);
    await trace(req, 'event.create', e._id.toHexString());
    return reply.status(201).send(await service.orgEvent(e.orgId, e._id));
  });

  app.put('/org/:orgId/events/:id', { ...org(managers), schema: { tags, params: OrgEventParams, body: EventInput, response: { 200: OrgEventView } } }, async (req) => {
    const e = await service.update(toObjectId(req.params.orgId), toObjectId(req.params.id), me(req), req.body);
    await trace(req, 'event.update', req.params.id);
    return service.orgEvent(e.orgId, e._id);
  });

  app.put(
    '/org/:orgId/events/:id/photos',
    { ...org(managers), schema: { tags, params: OrgEventParams, description: 'A published event: reorder its pictures, pick the cover, take some off.', body: PhotosInput, response: { 200: OrgEventView } } },
    async (req) => {
      const e = await service.updatePhotos(toObjectId(req.params.orgId), toObjectId(req.params.id), req.body);
      await trace(req, 'event.photos', req.params.id, { count: req.body.imageIds.length, fixedCover: req.body.fixedCover });
      return service.orgEvent(e.orgId, e._id);
    },
  );

  app.post('/org/:orgId/events/:id/publish', { ...org(managers), schema: { tags, params: OrgEventParams, response: { 200: OrgEventView } } }, async (req) => {
    const e = await service.publish(toObjectId(req.params.orgId), toObjectId(req.params.id));
    await trace(req, 'event.publish', req.params.id);
    return service.orgEvent(e.orgId, e._id);
  });

  app.post(
    '/org/:orgId/events/:id/cancel',
    { ...org(managers), schema: { tags, params: OrgEventParams, body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 200 }) }, { additionalProperties: false }), response: { 200: Type.Object({ refunded: Type.Number() }) } } },
    async (req) => {
      const res = await service.cancel(toObjectId(req.params.orgId), toObjectId(req.params.id), req.body.reason);
      await trace(req, 'event.cancel', req.params.id, { reason: req.body.reason, ...res });
      return res;
    },
  );

  app.get(
    '/org/:orgId/events/:id/attendees',
    {
      ...org(crew),
      schema: {
        tags,
        params: OrgEventParams,
        response: {
          200: Type.Object({
            event: OrgEventView,
            attendees: Type.Array(Type.Object({ ticketId: Type.String(), code: Type.String(), typeName: Type.String(), name: Type.String(), admitted: Type.Boolean(), admittedAt: Nullable(Type.String()) })),
          }),
        },
      },
    },
    async (req) => {
      const res = await service.attendees(toObjectId(req.params.orgId), toObjectId(req.params.id));
      await trace(req, 'event.attendees_view', req.params.id);
      return res;
    },
  );

  app.post(
    '/org/:orgId/events/:id/claim',
    { ...org(['owner']), schema: { tags, params: OrgEventParams, body: Type.Object({ method: Type.Enum(PAYMENT_METHODS) }, { additionalProperties: false }), response: { 200: PayoutView } } },
    async (req) => {
      const payout = await service.claim(toObjectId(req.params.orgId), toObjectId(req.params.id), me(req), req.body.method);
      await trace(req, 'event.claim', req.params.id, { amount: payout.amount });
      return payoutView(payout);
    },
  );
}
