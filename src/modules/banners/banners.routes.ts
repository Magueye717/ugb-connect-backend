import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { IdParams, Nullable, ObjectIdString, toObjectId } from '../../platform/http/schemas.js';
import type { AuditApi } from '../audit/index.js';
import { PAYMENT_METHODS, PaymentView, paymentView } from '../payments/index.js';
import type { BannersService } from './banners.service.js';
import { BANNER_KINDS, BANNER_STATUSES, CTA_TARGETS, type BannerDoc, type BannerPackageDoc } from './banners.types.js';


/**
 * An event's banner without its own picture shows the event's cover if the organizer chose one, otherwise one of its
 * pictures at random (a different one from one refresh to the next).
 */
function coverOf(b: BannerDoc, event: { images: string[]; fixedCover: boolean } | null) {
  if (b.kind !== 'event' || b.ownImage || !event?.images.length) return b.image.url;
  return event.fixedCover ? event.images[0]! : event.images[Math.floor(Math.random() * event.images.length)]!;
}
const Cta = Type.Object(
  {
    label: Type.String({ minLength: 2, maxLength: 16, description: '"Voir", "Commander", "J’en profite"' }),
    target: Type.Enum(CTA_TARGETS, { description: 'app: a screen of the app ("/resto/r2"); url: https link; whatsapp / phone: a Senegalese number' }),
    value: Type.String({ maxLength: 300 }),
  },
  { additionalProperties: false },
);
const PackageView = Type.Object({ code: Type.String(), name: Type.String(), days: Type.Number(), price: Type.Number(), active: Type.Boolean() });
const EventSummary = Type.Object({ id: Type.String(), title: Type.String(), startsAt: Type.String(), venue: Type.String(), categoryLabel: Type.String(), priceLabel: Type.String({ description: '"Dès 2 000 FCFA" or "Gratuit"' }) });
const LiveView = Type.Object({
  id: Type.String(),
  kind: Type.String({ description: 'ad | event' }),
  title: Type.String(),
  description: Type.String(),
  image: Type.String(),
  cta: Nullable(Cta),
  event: Nullable(EventSummary),
});
const BannerView = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  status: Type.String({ description: BANNER_STATUSES.join(' | ') }),
  title: Type.String(),
  description: Type.String(),
  image: Type.String(),
  cta: Nullable(Cta),
  eventId: Nullable(Type.String()),
  packageName: Type.String(),
  days: Type.Number(),
  price: Type.Number(),
  startsAt: Type.String(),
  endsAt: Type.String(),
  reviewReason: Nullable(Type.String({ description: 'Why it was refused or withdrawn.' })),
  refunded: Type.Boolean(),
  payment: Nullable(Type.Object({ reference: Type.String(), checkoutUrl: Nullable(Type.String()) })),
});

type Deps = { service: BannersService; audit: AuditApi; requireEditor: preHandlerHookHandler; requireAdmin: preHandlerHookHandler; checkoutOf: (paymentId: BannerDoc['paymentId']) => Promise<{ reference: string; checkoutUrl: string | null } | null> };
const baseUrlOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;
const packageView = (p: BannerPackageDoc) => ({ code: p.code, name: p.name, days: p.days, price: p.price, active: p.active });

export function registerBannersRoutes(root: FastifyInstance, { service, audit, requireEditor, requireAdmin, checkoutOf }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['banners'];
  const editor = { preHandler: [requireAuth, requireEditor] };
  const trace = (req: FastifyRequest, action: string, id: string, metadata?: Record<string, unknown>) =>
    audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type: 'banner', id }, requestId: req.id, ...(metadata ? { metadata } : {}) });
  const packages = new Map<string, string>();
  const view = async (b: BannerDoc) => {
    if (!packages.has(b.packageCode)) for (const p of await service.listPackages(true)) packages.set(p.code, p.name);
    return {
      id: b._id.toHexString(), kind: b.kind, status: b.status, title: b.title, description: b.description, image: b.image.url, cta: b.cta, eventId: b.eventId?.toHexString() ?? null,
      packageName: packages.get(b.packageCode) ?? b.packageCode, days: b.days, price: b.price, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(),
      reviewReason: b.review?.reason ?? null, refunded: !!b.refundPayoutId, payment: b.status === 'pending_payment' ? await checkoutOf(b.paymentId) : null,
    };
  };

  // The home carousel.
  app.get('/banners', { preHandler: requireAuth, schema: { tags, response: { 200: Type.Object({ items: Type.Array(LiveView) }) } } }, async () => ({
    items: (await service.live()).map(({ b, event }) => ({
      id: b._id.toHexString(), kind: b.kind, title: b.title, description: b.description, image: coverOf(b, event), cta: b.cta,
      event: event ? { id: event.id, title: event.title, startsAt: event.startsAt, venue: event.venue, categoryLabel: event.categoryLabel, priceLabel: event.priceLabel } : null,
    })),
  }));

  app.get('/banner-packages', { preHandler: requireAuth, schema: { tags, response: { 200: Type.Object({ items: Type.Array(PackageView) }) } } }, async () => ({
    items: (await service.listPackages()).map(packageView),
  }));

  app.post(
    '/banners',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        description: 'Ads: anyone. Events: an owner or manager of the organization, for one of its published events. Paid, then reviewed by the communication team (refunded if refused).',
        body: Type.Object(
          {
            kind: Type.Enum(BANNER_KINDS),
            orgId: Type.Optional(ObjectIdString),
            eventId: Type.Optional(ObjectIdString),
            title: Type.Optional(Type.String({ maxLength: 40, description: 'Required for an ad; an event banner defaults to the event’s title.' })),
            description: Type.Optional(Type.String({ maxLength: 90 })),
            imageId: Type.Optional(ObjectIdString),
            cta: Type.Optional(Nullable(Cta)),
            packageCode: Type.String({ maxLength: 30 }),
            startsOn: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day shown (Dakar), from today.' }),
            method: Type.Enum(PAYMENT_METHODS),
            returnUrl: Type.Optional(Type.String({ maxLength: 300 })),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ banner: BannerView, payment: PaymentView }) },
      },
    },
    async (req, reply) => {
      const { banner, payment } = await service.create(me(req), req.body, baseUrlOf(req));
      return reply.status(201).send({ banner: await view(banner), payment: paymentView(payment) });
    },
  );

  app.get('/me/banners', { preHandler: requireAuth, schema: { tags, response: { 200: Type.Object({ items: Type.Array(BannerView) }) } } }, async (req) => ({
    items: await Promise.all((await service.mine(me(req))).map(view)),
  }));

  app.delete('/me/banners/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, description: 'Off my list once settled (refused, cancelled, withdrawn, ended). Waiting: cancel first; showing: not yet.' } }, async (req, reply) => {
    await service.remove(me(req), toObjectId(req.params.id));
    return reply.status(204).send();
  });

  app.post('/me/banners/:id/cancel', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: BannerView } } }, async (req) => view(await service.cancel(me(req), toObjectId(req.params.id))));

  // ---- Communication team ----------------------------------------------------------------------------------------

  app.get(
    '/admin/banners',
    { ...editor, schema: { tags, querystring: Type.Object({ status: Type.Optional(Type.Enum(BANNER_STATUSES)) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(BannerView) }) } } },
    async (req) => ({ items: await Promise.all((await service.listForReview(req.query.status)).map(view)) }),
  );

  app.post('/admin/banners/:id/approve', { ...editor, schema: { tags, params: IdParams, response: { 200: BannerView } } }, async (req) => {
    const b = await service.approve(toObjectId(req.params.id), me(req));
    await trace(req, 'banner.approve', req.params.id);
    return view(b);
  });

  const Reason = Type.Object({ reason: Type.String({ minLength: 3, maxLength: 200 }) }, { additionalProperties: false });
  app.post('/admin/banners/:id/reject', { ...editor, schema: { tags, params: IdParams, body: Reason, response: { 200: BannerView } } }, async (req) => {
    const b = await service.reject(toObjectId(req.params.id), me(req), req.body.reason);
    await trace(req, 'banner.reject', req.params.id, { reason: req.body.reason });
    return view(b);
  });

  app.post('/admin/banners/:id/withdraw', { ...editor, schema: { tags, params: IdParams, body: Reason, response: { 200: BannerView } } }, async (req) => {
    const b = await service.withdraw(toObjectId(req.params.id), me(req), req.body.reason);
    await trace(req, 'banner.withdraw', req.params.id, { reason: req.body.reason });
    return view(b);
  });

  // ---- Prices (admins) -------------------------------------------------------------------------------------------

  app.get('/admin/banner-packages', { preHandler: [requireAuth, requireAdmin], schema: { tags, response: { 200: Type.Object({ items: Type.Array(PackageView) }) } } }, async () => ({
    items: (await service.listPackages(true)).map(packageView),
  }));

  app.put(
    '/admin/banner-packages/:code',
    {
      preHandler: [requireAuth, requireAdmin],
      schema: {
        tags,
        params: Type.Object({ code: Type.String({ pattern: '^[a-z0-9-]{2,30}$' }) }, { additionalProperties: false }),
        body: Type.Object({ name: Type.String({ minLength: 2, maxLength: 40 }), days: Type.Integer({ minimum: 1, maximum: 60 }), price: Type.Integer({ minimum: 100, maximum: 1_000_000 }), active: Type.Boolean(), sortOrder: Type.Optional(Type.Integer()) }, { additionalProperties: false }),
        response: { 200: PackageView },
      },
    },
    async (req) => {
      packages.clear();
      const p = await service.putPackage(req.params.code, req.body);
      await audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action: 'banner_package.put', target: { type: 'banner_package', id: p.code }, requestId: req.id, metadata: { price: p.price, days: p.days, active: p.active } });
      return packageView(p);
    },
  );
}
