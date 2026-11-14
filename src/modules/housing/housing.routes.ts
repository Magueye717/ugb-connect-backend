import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, Nullable, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import type { HousingService } from './housing.service.js';
import { HOUSING_FOR, HOUSING_KINDS } from './housing.types.js';

const AdView = Type.Object({
  id: Type.String(),
  kind: Type.String({ description: HOUSING_KINDS.join(' | ') }),
  by: Type.String({ description: 'The author, masked: "Moussa S."' }),
  initials: Type.String(),
  village: Nullable(Type.String()),
  room: Nullable(Type.String()),
  wants: Type.Array(Type.String()),
  area: Nullable(Type.String()),
  from: Nullable(Type.String()),
  to: Nullable(Type.String()),
  rent: Nullable(Type.Number()),
  places: Nullable(Type.Number()),
  for: Type.String({ description: HOUSING_FOR.join(' | ') }),
  note: Nullable(Type.String()),
  state: Type.String({ description: 'open | closed | hidden' }),
  createdAt: Type.String(),
  expiresAt: Type.String(),
  mine: Type.Boolean(),
  match: Type.Boolean({ description: 'Swaps: one of my swap ads fits this one (each has what the other wants).' }),
  myContactId: Nullable(Type.String({ description: 'My conversation with its author (GET /housing/contacts/:id).' })),
  contactIds: Type.Array(Type.String(), { description: 'Mine: the conversations opened about it (housing_contact chats), for their unread badges.' }),
});
const AdDetail = Type.Object({ ...AdView.properties, conversations: Type.Array(Type.Object({ contactId: Type.String(), with: Type.String(), createdAt: Type.String() }), { description: 'Mine only.' }) });
const ContactView = Type.Object({ id: Type.String(), conversationId: Nullable(Type.String({ description: 'Use the /conversations endpoints.' })), with: Type.String(), ad: AdView });

type Deps = { service: HousingService; audit: AuditApi; requireStudent: preHandlerHookHandler; requireAdmin: preHandlerHookHandler };

export function registerHousingRoutes(root: FastifyInstance, { service, audit, requireStudent, requireAdmin }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['housing'];
  const student = { preHandler: [requireAuth, requireStudent] };
  const trace = (req: FastifyRequest, action: string, id: string) => audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type: 'housing_ad', id }, requestId: req.id });

  app.get('/housing/ads', { ...student, schema: { tags, description: 'Open ads (room swaps, hosting, roommates), newest first, and mine.', response: { 200: Type.Object({ items: Type.Array(AdView) }) } } }, async (req) => ({
    items: await service.list(me(req)),
  }));

  app.get('/housing/ads/:id', { ...student, schema: { tags, params: IdParams, response: { 200: AdDetail } } }, async (req) => service.detail(toObjectId(req.params.id), me(req)));

  app.post(
    '/housing/ads',
    {
      ...student,
      schema: {
        tags,
        description: 'Publish an ad. swap: village, room, wants · host_offer: village or area · roommate: area or village · host_need: anything. Online two months (hosting: until the day after `to`, if sooner).',
        body: Type.Object(
          {
            kind: Type.Enum(HOUSING_KINDS),
            village: Type.Optional(Nullable(Type.String({ maxLength: 30 }))),
            room: Type.Optional(Nullable(Type.String({ maxLength: 12 }))),
            wants: Type.Optional(Type.Array(Type.String({ maxLength: 30 }), { maxItems: 17 })),
            area: Type.Optional(Nullable(Type.String({ maxLength: 60 }))),
            from: Type.Optional(Nullable(Type.String({ format: 'date-time' }))),
            to: Type.Optional(Nullable(Type.String({ format: 'date-time' }))),
            rent: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 1_000_000 }))),
            places: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 10 }))),
            for: Type.Optional(Type.Enum(HOUSING_FOR)),
            note: Type.Optional(Nullable(Type.String({ maxLength: 300 }))),
          },
          { additionalProperties: false },
        ),
        response: { 201: AdDetail },
      },
    },
    async (req, reply) => {
      const doc = await service.create(me(req), req.body);
      await trace(req, 'housing.publish', doc._id.toHexString());
      return reply.status(201).send(await service.detail(doc._id, me(req)));
    },
  );

  app.post('/housing/ads/:id/close', { ...student, schema: { tags, params: IdParams, description: '« Trouvé ! »: off the board, its chats read-only. The author only.', response: { 200: AdDetail } } }, async (req) => {
    await service.close(me(req), toObjectId(req.params.id));
    return service.detail(toObjectId(req.params.id), me(req));
  });

  app.post('/housing/ads/:id/report', { ...student, schema: { tags, params: IdParams, description: 'Several reports take it off the board until the team looks.' } }, async (req, reply) => {
    await service.report(me(req), toObjectId(req.params.id));
    await trace(req, 'housing.report', req.params.id);
    return reply.status(204).send();
  });

  // ---- The team: reported ads (« Signaler l’annonce ») -----------------------------------------------------------

  const staff = { preHandler: [requireAuth, requireAdmin] };
  const ReportedAd = Type.Object({
    id: Type.String(), kind: Type.String({ description: HOUSING_KINDS.join(' | ') }), by: Type.String(), village: Nullable(Type.String()), room: Nullable(Type.String()),
    area: Nullable(Type.String()), note: Nullable(Type.String()), state: Type.String({ description: 'open | hidden (hidden: off the board after several reports)' }),
    reports: Type.Integer(), createdAt: Type.String(), updatedAt: Type.String(),
  });
  app.get('/admin/housing/reports', { ...staff, schema: { tags: ['admin'], description: 'Reported housing ads waiting for the team, most reported first.', response: { 200: Type.Object({ items: Type.Array(ReportedAd) }) } } }, async () => ({
    items: (await service.reported()).map((a) => ({
      id: a._id.toHexString(), kind: a.kind, by: a.author.name, village: a.village, room: a.room, area: a.area, note: a.note, state: a.state,
      reports: a.reports.length, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
    })),
  }));
  app.post('/admin/housing/ads/:id/keep', { ...staff, schema: { tags: ['admin'], params: IdParams, description: 'Nothing wrong: back on the board, reports cleared.' } }, async (req, reply) => {
    await service.keepReported(toObjectId(req.params.id));
    await trace(req, 'housing.report_dismissed', req.params.id);
    return reply.status(204).send();
  });
  app.post('/admin/housing/ads/:id/remove', { ...staff, schema: { tags: ['admin'], params: IdParams, description: 'Taken down: off the board, chats closed, the author told.' } }, async (req, reply) => {
    await service.removeReported(toObjectId(req.params.id));
    await trace(req, 'housing.removed', req.params.id);
    return reply.status(204).send();
  });

  app.post('/housing/ads/:id/contact', { ...student, schema: { tags, params: IdParams, description: 'Write to the author: one private chat per ad and person (never the phone number).', response: { 200: ContactView } } }, async (req) => {
    const c = await service.contact(me(req), toObjectId(req.params.id));
    return service.contactView(c._id, me(req));
  });

  app.get('/housing/contacts/:id', { ...student, schema: { tags, params: IdParams, response: { 200: ContactView } } }, async (req) => service.contactView(toObjectId(req.params.id), me(req)));
}
