import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ObjectId } from 'mongodb';
import { Type } from 'typebox';

import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import { errors } from '../../platform/http/errors.js';
import { IdParams, Nullable, ObjectIdString, PhoneInput, toObjectId } from '../../platform/http/schemas.js';
import { CAMPUSES } from '../accounts/index.js';
import type { AuditApi } from '../audit/index.js';
import type { OrganizationsApi, OrgRole } from '../organizations/index.js';
import { PaymentView, paymentView } from '../payments/index.js';
import type { BusinessRef, CommerceService } from './commerce.service.js';
import { BUSINESS_KINDS, DELIVERY_ZONE_LABELS, DELIVERY_ZONES, EDITOR_MAX_ITEM_PHOTOS, ITEM_SECTIONS, MAX_ITEM_PHOTOS, MAX_SPECIALTIES, ORDER_MODES, ORDER_PAYMENT_LABELS, ORDER_PAYMENT_METHODS, SALES_MAX_DAYS, SPECIALTIES, type BusinessDoc, type BusinessKind } from './commerce.types.js';

// Null first: the validator would otherwise coerce null to 0 ("free delivery") through the integer branch.
const Fee = Nullable(Type.Integer({ minimum: 0, maximum: 5000 }));
const Hhmm = Type.String({ pattern: '^\\d{2}:\\d{2}$' });
const ServiceSchema = Type.Object({ start: Hhmm, end: Hhmm }, { additionalProperties: false });
const Location = Type.Object({ lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }) }, { additionalProperties: false });

const ItemView = Type.Object({
  id: Type.String(),
  section: Type.String({ description: ITEM_SECTIONS.join(' | ') }),
  category: Nullable(Type.String({ description: 'Shops: groups the articles ("Fournitures").' })),
  name: Type.String(),
  detail: Type.String(),
  price: Type.Number(),
  photo: Nullable(Type.String({ description: 'The cover: the first of `photos`.' })),
  photos: Type.Array(Type.String(), { description: 'Every picture, the cover first.' }),
  photoIds: Type.Array(Type.String(), { description: 'The same pictures, to send back in `photoIds` when editing.' }),
  stock: Nullable(Type.Number({ description: 'Shops: units left; null: not counted.' })),
  soldOut: Type.Boolean(),
  available: Type.Boolean(),
  orderable: Type.Boolean({ description: 'False: for information only (a service done on the spot), never in an order.' }),
  likes: Type.Integer({ description: 'Students who like it.' }),
  liked: Type.Boolean({ description: 'The caller likes it (always false in the business’s own catalog).' }),
  createdAt: Type.String({ description: 'When it was added: the market lists the newest first.' }),
  interested: Type.Boolean({ description: 'Done on the spot (not orderable): the caller said « Intéressé ».' }),
});
const BusinessView = Type.Object({
  id: Type.String(),
  orgId: Type.String(),
  kind: Type.String({ description: BUSINESS_KINDS.join(' | ') }),
  name: Type.String(),
  specialties: Type.Array(Type.String()),
  specialty: Type.String({ description: 'The specialties joined: "Sénégalais · Grillades".' }),
  description: Type.String(),
  photo: Nullable(Type.String()),
  location: Nullable(Type.Object({ lat: Type.Number(), lng: Type.Number() })),
  address: Type.String(),
  campus: Nullable(Type.String()),
  campusLabel: Nullable(Type.String()),
  phone: Type.String(),
  services: Type.Array(Type.Object({ start: Type.String(), end: Type.String() })),
  hours: Type.String({ description: '"12h-15h · 19h-22h"' }),
  open: Type.Boolean({ description: 'Takes orders now (within its hours and not paused).' }),
  statusLabel: Type.String({ description: '"Ouvert · jusqu’à 15h", "Fermé · ouvre à 19h", "Commandes en pause"' }),
  deliveryFees: Type.Object({ campus1: Nullable(Type.Number()), campus2: Nullable(Type.Number()), outside: Nullable(Type.Number()) }, { description: 'FCFA per zone, 0: free; null: no delivery there.' }),
  deliveryFee: Nullable(Type.Number({ description: 'The lowest delivery price; null: pickup only.' })),
  acceptingOrders: Type.Boolean(),
  rating: Nullable(Type.Number({ description: 'Average stars of its orders (1 decimal); null: not rated yet.' })),
  ratingCount: Type.Number(),
  paymentMethods: Type.Array(Type.Object({ value: Type.String(), label: Type.String() }), { description: 'How students may pay: cash (at delivery or the counter), wave, orange_money.' }),
  active: Type.Boolean(),
  byStudent: Type.Boolean({ description: 'A student’s own shop.' }),
  onlinePayments: Type.Boolean({ description: 'May take Wave and Orange Money. A student’s shop: false until the team has verified it (cash only).' }),
  itemLikes: Type.Boolean({ description: 'Its items can be liked (shops: yes; restaurants: no heart).' }),
});
// What the owner and Référencement see: the public view, plus where each provider's money goes (never shown to students).
const OwnBusinessView = Type.Object({ ...BusinessView.properties, payoutNumbers: Type.Object({ wave: Nullable(Type.String()), orange_money: Nullable(Type.String()) }) });
const ListedBusiness = Type.Object({ ...BusinessView.properties, highlights: Type.Array(ItemView), minPrice: Nullable(Type.Number()), itemsCount: Type.Number(), itemNames: Type.Array(Type.String(), { description: 'Every available item: for searching.' }) });
const BusinessDetail = Type.Object({
  ...BusinessView.properties,
  items: Type.Array(ItemView),
  viewer: Type.Object(
    { member: Type.Boolean({ description: 'Its owner or team: they cannot order here.' }), canEdit: Type.Boolean({ description: 'Owner or manager: may edit the catalog (/org/:orgId/:space/catalog).' }) },
    { description: 'The caller, for this business.' },
  ),
});
const OrderView = Type.Object({
  id: Type.String(),
  code: Type.String({ description: 'Said at the counter: "C7KQ2M".' }),
  status: Type.String({ description: 'pending_payment | placed | accepted | ready | completed | refused | cancelled | expired' }),
  business: Type.Object({ id: Type.String(), kind: Type.String(), name: Type.String(), phone: Type.String(), photo: Nullable(Type.String()), address: Type.String() }),
  lines: Type.Array(Type.Object({ itemId: Type.String(), name: Type.String(), price: Type.Number(), qty: Type.Number(), photo: Type.Union([Type.String(), Type.Null()]) })),
  subtotal: Type.Number(),
  deliveryFee: Type.Number(),
  zone: Nullable(Type.String({ description: DELIVERY_ZONES.join(' | ') })),
  zoneLabel: Nullable(Type.String()),
  total: Type.Number(),
  mode: Type.String({ description: ORDER_MODES.join(' | ') }),
  address: Nullable(Type.String()),
  note: Nullable(Type.String()),
  refusal: Nullable(Type.String()),
  refunded: Type.Boolean(),
  method: Type.String({ description: 'cash | wave | orange_money' }),
  methodLabel: Type.String(),
  history: Type.Array(Type.Object({ status: Type.String(), at: Type.String() })),
  createdAt: Type.String(),
  payment: Nullable(Type.Object({ reference: Type.String(), checkoutUrl: Nullable(Type.String()) }, { description: 'Being paid: reopen the checkout.' })),
  customer: Nullable(Type.Object({ name: Type.String(), phone: Type.String() }, { description: 'Business only: who ordered.' })),
});
const ProfileBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
    specialties: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { minItems: 1, maxItems: MAX_SPECIALTIES, description: 'From GET /reference/commerce, 1 to 4.' })),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    photoId: Type.Optional(Nullable(ObjectIdString)),
    location: Type.Optional(Nullable(Location)),
    address: Type.Optional(Type.String({ maxLength: 80 })),
    campus: Type.Optional(Nullable(Type.Enum(CAMPUSES))),
    phone: Type.Optional(Type.String({ maxLength: 20 })),
    services: Type.Optional(Type.Array(ServiceSchema, { minItems: 1, maxItems: 4 })),
    deliveryFees: Type.Optional(Type.Object({ campus1: Fee, campus2: Fee, outside: Fee }, { additionalProperties: false })),
    acceptingOrders: Type.Optional(Type.Boolean()),
    paymentMethods: Type.Optional(Type.Array(Type.Enum(ORDER_PAYMENT_METHODS), { minItems: 1, maxItems: ORDER_PAYMENT_METHODS.length })),
    payoutNumbers: Type.Optional(
      Type.Object(
        { wave: Type.Optional(Nullable(Type.String({ maxLength: 20 }))), orange_money: Type.Optional(Nullable(Type.String({ maxLength: 20 }))) },
        { additionalProperties: false, description: 'Where each provider pays out (required for each one accepted, else 400). Null: back to the organization’s number.' },
      ),
    ),
  },
  { additionalProperties: false },
);
const ItemFields = {
  section: Type.Enum(ITEM_SECTIONS),
  category: Type.Optional(Nullable(Type.String({ maxLength: 30 }))),
  name: Type.String({ minLength: 2, maxLength: 50 }),
  detail: Type.Optional(Type.String({ maxLength: 120 })),
  price: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  photoIds: Type.Optional(Type.Array(ObjectIdString, { maxItems: MAX_ITEM_PHOTOS, description: `Uploads (purpose business), the cover first; up to ${MAX_ITEM_PHOTOS} (Référencement: ${EDITOR_MAX_ITEM_PHOTOS}). [] removes them all.` })),
  // Older apps: one picture (same as photoIds: [id], or [] for null).
  photoId: Type.Optional(Nullable(ObjectIdString)),
  stock: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 100_000 }))),
  available: Type.Optional(Type.Boolean()),
  orderable: Type.Optional(Type.Boolean({ description: 'Default true. False: shown for information only (printing, on the spot), no stock, never in an order.' })),
  sortOrder: Type.Optional(Type.Number()),
};
// Référencement's routes (/admin/businesses/…): the same fields, more photos per article.
const EditorItemFields = { ...ItemFields, photoIds: Type.Optional(Type.Array(ObjectIdString, { maxItems: EDITOR_MAX_ITEM_PHOTOS, description: `Uploads (purpose business), the cover first; up to ${EDITOR_MAX_ITEM_PHOTOS}. [] removes them all.` })) };
// A business's own routes name its space: /org/:orgId/restaurant/… or /org/:orgId/shop/… (one entity may run both).
const OrgParams = Type.Object({ orgId: ObjectIdString, space: Type.Enum(BUSINESS_KINDS) }, { additionalProperties: false });
const OrgItemParams = Type.Object({ orgId: ObjectIdString, space: Type.Enum(BUSINESS_KINDS), itemId: ObjectIdString }, { additionalProperties: false });
const OrgOrderParams = Type.Object({ orgId: ObjectIdString, space: Type.Enum(BUSINESS_KINDS), id: ObjectIdString }, { additionalProperties: false });
const refOf = (p: { orgId: string; space: BusinessKind }): BusinessRef => ({ orgId: toObjectId(p.orgId), kind: p.space });

type Deps = {
  service: CommerceService;
  audit: AuditApi;
  requireOrgRole: (roles: OrgRole[], space?: 'param') => preHandlerHookHandler;
  roleIn: OrganizationsApi['roleIn'];
  requireAdmin: preHandlerHookHandler;
  /** Restaurant editors add restaurants, shop editors shops (admins both). */
  editsKind: (userId: ObjectId, kind: BusinessKind) => Promise<boolean>;
};
const baseUrlOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

export function registerCommerceRoutes(root: FastifyInstance, { service, audit, requireOrgRole, roleIn, requireAdmin, editsKind }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  const me = (req: FastifyRequest) => toObjectId(actorOf(req).userId);
  const tags = ['commerce'];
  const managers = { preHandler: [requireAuth, requireOrgRole(['owner', 'manager'], 'param')] };
  const team = { preHandler: [requireAuth, requireOrgRole(['owner', 'manager', 'staff'], 'param')] };
  const trace = (req: FastifyRequest, action: string, type: string, id: string, metadata?: Record<string, unknown>) =>
    audit.record({ actor: { type: 'user', id: actorOf(req).userId }, action, target: { type, id }, requestId: req.id, ...(metadata ? { metadata } : {}) });
  const view = (b: BusinessDoc) => service.publicView(b);
  const ownView = async (b: BusinessDoc) => ({ ...view(b), payoutNumbers: await service.payoutNumbers(b) });

  // The lists the app's pickers show (specialties, delivery zones): one source, here.
  app.get(
    '/reference/commerce',
    { schema: { tags, response: { 200: Type.Object({ specialties: Type.Object({ restaurant: Type.Array(Type.String()), shop: Type.Array(Type.String()) }), maxSpecialties: Type.Integer(), maxItemPhotos: Type.Integer({ description: 'Photos per article, the cover included.' }), editorMaxItemPhotos: Type.Integer({ description: 'The same for Référencement (its own routes).' }), paymentMethods: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })), zones: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })) }) } } },
    async () => ({ specialties: { restaurant: [...SPECIALTIES.restaurant], shop: [...SPECIALTIES.shop] }, maxSpecialties: MAX_SPECIALTIES, maxItemPhotos: MAX_ITEM_PHOTOS, editorMaxItemPhotos: EDITOR_MAX_ITEM_PHOTOS, paymentMethods: ORDER_PAYMENT_METHODS.map((m) => ({ value: m, label: ORDER_PAYMENT_LABELS[m] })), zones: DELIVERY_ZONES.map((z) => ({ value: z, label: DELIVERY_ZONE_LABELS[z] })) }),
  );

  // ---- Students -------------------------------------------------------------------------------------------------

  app.get(
    '/businesses',
    { preHandler: requireAuth, schema: { tags, description: 'Private restaurants or shops, open first, with a few of their items.', querystring: Type.Object({ kind: Type.Enum(BUSINESS_KINDS) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(ListedBusiness) }) } } },
    async (req) => ({ items: await service.list(req.query.kind, me(req)) }),
  );

  app.get(
    '/market',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        description: 'The market: every available article of every shop (or every dish of every restaurant), with its business, to browse and search across them.',
        querystring: Type.Object({ kind: Type.Enum(BUSINESS_KINDS) }, { additionalProperties: false }),
        response: { 200: Type.Object({ businesses: Type.Array(BusinessView), items: Type.Array(Type.Object({ ...ItemView.properties, businessId: Type.String() })) }) },
      },
    },
    async (req) => service.market(req.query.kind, me(req)),
  );

  app.get('/businesses/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: BusinessDetail } } }, async (req) => {
    const d = await service.detail(toObjectId(req.params.id), me(req));
    const roles = await roleIn(toObjectId(d.orgId), me(req), ['owner', 'manager', 'staff'], d.kind);
    return { ...d, viewer: { member: !!roles, canEdit: !!roles?.some((r) => r === 'owner' || r === 'manager') } };
  });

  // A heart on an article or a dish: PUT likes it, DELETE takes the like back. Both idempotent.
  const LikeResult = Type.Object({ liked: Type.Boolean(), likes: Type.Integer({ description: 'Its count now.' }) });
  app.put(
    '/items/:id/like',
    { preHandler: requireAuth, schema: { tags, params: IdParams, description: 'Like a shop’s article (its own team cannot: OWN_BUSINESS; a restaurant’s dish: NOT_LIKEABLE).', response: { 200: LikeResult } } },
    async (req) => service.like(me(req), toObjectId(req.params.id), true),
  );
  app.delete(
    '/items/:id/like',
    { preHandler: requireAuth, schema: { tags, params: IdParams, description: 'No longer like it.', response: { 200: LikeResult } } },
    async (req) => service.like(me(req), toObjectId(req.params.id), false),
  );

  // « Intéressé » on an article done on the spot: PUT tells the shop (once), DELETE takes it back.
  const InterestResult = Type.Object({ interested: Type.Boolean() });
  app.put(
    '/items/:id/interest',
    { preHandler: requireAuth, schema: { tags, params: IdParams, description: 'Not orderable (done on the spot): the shop’s team is told who, with their phone (ORDERABLE: add it to the basket instead).', response: { 200: InterestResult } } },
    async (req) => service.interest(me(req), toObjectId(req.params.id), true),
  );
  app.delete('/items/:id/interest', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: InterestResult } } }, async (req) =>
    service.interest(me(req), toObjectId(req.params.id), false),
  );

  app.post(
    '/businesses/:id/orders',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        params: IdParams,
        description: 'One order. Wave / Orange Money: paid now, the business is notified once paid. Cash (if the business accepts it): sent to the business at once, paid at delivery or at the counter (no payment).',
        body: Type.Object(
          {
            lines: Type.Array(Type.Object({ itemId: ObjectIdString, qty: Type.Integer({ minimum: 0, maximum: 20 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
            mode: Type.Enum(ORDER_MODES),
            zone: Type.Optional(Nullable(Type.Enum(DELIVERY_ZONES))),
            address: Type.Optional(Nullable(Type.String({ maxLength: 120 }))),
            note: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
            method: Type.Enum(ORDER_PAYMENT_METHODS),
            returnUrl: Type.Optional(Type.String({ maxLength: 300 })),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ order: OrderView, payment: Nullable(PaymentView) }) },
      },
    },
    async (req, reply) => {
      const { order, payment } = await service.place(me(req), toObjectId(req.params.id), req.body, baseUrlOf(req));
      return reply.status(201).send({ order: await service.mineOne(me(req), order._id), payment: payment ? paymentView(payment) : null });
    },
  );

  app.post(
    '/me/shop',
    {
      preHandler: requireAuth,
      schema: {
        tags,
        description: 'A student opens their own shop (products or services): they get its space (catalog, orders, team); its articles show in the market.',
        body: Type.Object(
          {
            name: Type.String({ minLength: 2, maxLength: 60 }), specialties: Type.Array(Type.String({ maxLength: 40 }), { minItems: 1, maxItems: MAX_SPECIALTIES, description: 'From GET /reference/commerce, 1 to 4.' }), description: Type.Optional(Type.String({ maxLength: 500 })), photoId: Type.Optional(Nullable(ObjectIdString)),
            paymentMethods: Type.Optional(Type.Array(Type.Enum(ORDER_PAYMENT_METHODS), { minItems: 1, maxItems: ORDER_PAYMENT_METHODS.length, description: 'Default ["cash"]. Wave and Orange Money: refused (ONLINE_PAYMENTS_LOCKED) until the team verifies the shop.' })),
          },
          { additionalProperties: false },
        ),
        response: { 201: BusinessView },
      },
    },
    async (req, reply) => {
      const b = await service.openStudentShop(me(req), req.body);
      await trace(req, 'business.student_open', 'business', b._id.toHexString());
      return reply.status(201).send(view(b));
    },
  );

  app.get('/me/orders', { preHandler: requireAuth, schema: { tags, response: { 200: Type.Object({ items: Type.Array(OrderView) }) } } }, async (req) => ({ items: await service.mine(me(req)) }));
  app.get('/me/orders/:id', { preHandler: requireAuth, schema: { tags, params: IdParams, response: { 200: OrderView } } }, async (req) => service.mineOne(me(req), toObjectId(req.params.id)));
  app.post('/me/orders/:id/cancel', { preHandler: requireAuth, schema: { tags, params: IdParams, description: 'Before the business accepts it: refunded.', response: { 200: OrderView } } }, async (req) => {
    await service.cancel(me(req), toObjectId(req.params.id));
    return service.mineOne(me(req), toObjectId(req.params.id));
  });

  // ---- The business's own space (members: /org/:orgId/members, owner) ----------------------------------------------

  app.get(
    '/org/:orgId/:space/interests',
    {
      ...team,
      schema: {
        tags,
        params: OrgParams,
        description: 'Who said « Intéressé » lately (30 days), newest first: to call them back.',
        response: { 200: Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), at: Type.String(), item: Type.Object({ id: Type.String(), name: Type.String() }), student: Type.Object({ name: Type.String(), phone: Type.String() }) })) }) },
      },
    },
    async (req) => ({ items: await service.interestsOf(refOf(req.params)) }),
  );

  app.get('/org/:orgId/:space/business', { ...team, schema: { tags, params: OrgParams, response: { 200: OwnBusinessView } } }, async (req) => ownView(await service.ofOrg(refOf(req.params))));

  // Pausing orders is the managers' call too; the rest of the profile is the owner's only.
  app.patch('/org/:orgId/:space/business', { ...managers, schema: { tags, params: OrgParams, description: 'Picture, GPS point, address, hours, delivery prices: the owner. Pause orders: owner or managers.', body: ProfileBody, response: { 200: OwnBusinessView } } }, async (req) => {
    const onlyPause = Object.keys(req.body).every((k) => k === 'acceptingOrders');
    if (!onlyPause && !(await roleIn(toObjectId(req.params.orgId), me(req), ['owner'], req.params.space))?.includes('owner')) throw errors.forbidden('Seul le propriétaire modifie les informations du commerce.');
    const b = await service.update(refOf(req.params), me(req), req.body);
    await trace(req, 'business.update', 'business', b._id.toHexString(), { fields: Object.keys(req.body) });
    return ownView(b);
  });

  app.get('/org/:orgId/:space/catalog', { ...team, schema: { tags, params: OrgParams, response: { 200: Type.Object({ items: Type.Array(ItemView) }) } } }, async (req) => {
    const b = await service.ofOrg(refOf(req.params));
    return { items: (await service.catalog(b._id)).map((i) => service.itemView(i)) };
  });

  app.post('/org/:orgId/:space/catalog', { ...managers, schema: { tags, params: OrgParams, description: 'Restaurants: menu or drink. Shops: article (with stock).', body: Type.Object(ItemFields, { additionalProperties: false }), response: { 201: ItemView } } }, async (req, reply) => {
    const item = await service.addItem(refOf(req.params), me(req), req.body);
    return reply.status(201).send(service.itemView(item));
  });

  app.patch(
    '/org/:orgId/:space/catalog/:itemId',
    { ...team, schema: { tags, params: OrgItemParams, description: 'Staff may only switch availability (sold out today).', body: Type.Partial(Type.Object(ItemFields, { additionalProperties: false })), response: { 200: ItemView } } },
    async (req) => {
      const onlyAvailability = Object.keys(req.body).every((k) => k === 'available');
      if (!onlyAvailability && !(await roleIn(toObjectId(req.params.orgId), me(req), ['owner', 'manager'], req.params.space))) throw errors.forbidden('Seuls le propriétaire et les gérants modifient le catalogue.');
      return service.itemView(await service.updateItem(refOf(req.params), me(req), toObjectId(req.params.itemId), req.body));
    },
  );

  app.delete('/org/:orgId/:space/catalog/:itemId', { ...managers, schema: { tags, params: OrgItemParams } }, async (req, reply) => {
    await service.removeItem(refOf(req.params), toObjectId(req.params.itemId));
    return reply.status(204).send();
  });

  app.get(
    '/org/:orgId/:space/orders',
    { ...team, schema: { tags, params: OrgParams, querystring: Type.Object({ scope: Type.Optional(Type.Enum(['active', 'done'] as const)) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(OrderView) }) } } },
    async (req) => ({ items: await service.queue(refOf(req.params), req.query.scope ?? 'active') }),
  );

  const Day = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD, Dakar time.' });
  const Money = Type.Integer({ description: 'FCFA' });
  app.get(
    '/org/:orgId/:space/sales',
    {
      ...managers,
      schema: {
        tags,
        params: OrgParams,
        description: `« Mes ventes » (owners and managers): completed orders placed from \`from\` to \`to\` (both included, ${SALES_MAX_DAYS} days at most). Refused, cancelled and in-progress orders are counted apart, not in the money.`,
        querystring: Type.Object({ from: Day, to: Day }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            from: Type.String(),
            to: Type.String(),
            revenue: Money,
            orders: Type.Integer(),
            average: Money,
            methods: Type.Array(Type.Object({ method: Type.String(), label: Type.String(), amount: Money, orders: Type.Integer() })),
            owed: Type.Integer({ description: 'Wave / Orange Money sales not yet received on the owner’s number.' }),
            days: Type.Array(Type.Object({ date: Type.String(), revenue: Money, orders: Type.Integer() })),
            top: Type.Array(Type.Object({ itemId: Type.String(), name: Type.String(), qty: Type.Integer(), revenue: Money })),
            inProgress: Type.Integer(),
            refused: Type.Integer(),
            cancelled: Type.Integer(),
          }),
        },
      },
    },
    async (req) => service.sales(refOf(req.params), req.query.from, req.query.to),
  );

  app.post(
    '/org/:orgId/:space/orders/handover',
    {
      ...team,
      schema: {
        tags,
        params: OrgParams,
        description: 'At the counter: the order code the student gives (typed, or their QR scanned). Completes an order being prepared or ready.',
        body: Type.Object({ code: Type.String({ minLength: 3, maxLength: 24 }) }, { additionalProperties: false }),
        response: { 200: OrderView },
      },
    },
    async (req) => {
      const o = await service.handover(refOf(req.params), req.body.code, me(req));
      await trace(req, 'order.handover', 'order', o._id.toHexString());
      return service.businessOrder(refOf(req.params), o._id);
    },
  );

  app.get('/org/:orgId/:space/orders/:id', { ...team, schema: { tags, params: OrgOrderParams, response: { 200: OrderView } } }, async (req) => service.businessOrder(refOf(req.params), toObjectId(req.params.id)));

  for (const [path, to] of [['accept', 'accepted'], ['ready', 'ready'], ['complete', 'completed']] as const) {
    app.post(`/org/:orgId/:space/orders/:id/${path}`, { ...team, schema: { tags, params: OrgOrderParams, response: { 200: OrderView } } }, async (req) => {
      const params = req.params as { orgId: string; space: BusinessKind; id: string };
      await service.advance(refOf(params), toObjectId(params.id), me(req), to);
      await trace(req, `order.${path}`, 'order', params.id);
      return service.businessOrder(refOf(params), toObjectId(params.id));
    });
  }

  app.post(
    '/org/:orgId/:space/orders/:id/refuse',
    { ...team, schema: { tags, params: OrgOrderParams, description: 'A placed order only: the student is refunded and told why.', body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 200 }) }, { additionalProperties: false }), response: { 200: OrderView } } },
    async (req) => {
      await service.refuse(refOf(req.params), toObjectId(req.params.id), me(req), req.body.reason);
      await trace(req, 'order.refuse', 'order', req.params.id, { reason: req.body.reason });
      return service.businessOrder(refOf(req.params), toObjectId(req.params.id));
    },
  );

  // ---- Admins -----------------------------------------------------------------------------------------------------

  const admin = { preHandler: [requireAuth, requireAdmin] };
  const mayEdit = async (req: FastifyRequest, kind: BusinessKind) => {
    if (!(await editsKind(me(req), kind))) throw errors.forbidden(kind === 'restaurant' ? 'Réservé aux responsables des restaurants.' : 'Réservé aux responsables des boutiques.');
  };
  app.get('/admin/businesses', { ...admin, schema: { tags: ['admin'], description: 'The kinds the caller edits.', response: { 200: Type.Object({ items: Type.Array(BusinessView) }) } } }, async (req) => {
    const kinds = (await Promise.all(BUSINESS_KINDS.map(async (k) => ((await editsKind(me(req), k)) ? k : null)))).filter(Boolean);
    return { items: (await service.listAll()).filter((b) => kinds.includes(b.kind)).map(view) };
  });

  app.post(
    '/admin/businesses/owner-lookup',
    {
      ...admin,
      schema: {
        tags: ['admin'],
        description: 'Before adding: the account of this number, and the entities it owns (the businesses each runs). Its entity is picked instead of a new one.',
        body: Type.Object({ phone: PhoneInput }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            account: Nullable(Type.Object({ firstName: Type.String(), lastName: Type.String() })),
            entities: Type.Array(
              Type.Object({
                orgId: Type.String(), name: Type.String(), personal: Type.Boolean(), organizer: Type.Boolean({ description: 'It organizes caravans or events.' }), kinds: Type.Array(Type.String()),
                businesses: Type.Array(Type.Object({ id: Type.String(), kind: Type.String(), name: Type.String() })),
              }),
            ),
          }),
        },
      },
    },
    async (req) => service.ownerLookup(req.body.phone),
  );

  app.post(
    '/admin/businesses',
    {
      ...admin,
      schema: {
        tags: ['admin'],
        description: 'Creates a restaurant or a shop: its organization, its owner (account created for a new number) and its profile. The owner then adds their team.',
        body: Type.Object(
          {
            ...ProfileBody.properties,
            kind: Type.Enum(BUSINESS_KINDS),
            name: Type.String({ minLength: 2, maxLength: 60 }),
            specialties: Type.Array(Type.String({ maxLength: 40 }), { minItems: 1, maxItems: MAX_SPECIALTIES, description: 'From GET /reference/commerce, 1 to 4.' }),
            orgId: Type.Optional(ObjectIdString),
            owner: Type.Optional(
              Type.Object({ phone: Type.String({ maxLength: 20 }), firstName: Type.String({ minLength: 2, maxLength: 40 }), lastName: Type.String({ minLength: 2, maxLength: 40 }), password: Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 201: BusinessView },
      },
    },
    async (req, reply) => {
      await mayEdit(req, req.body.kind);
      const { orgId, ...rest } = req.body;
      const b = await service.create({ ...rest, ...(orgId ? { orgId: toObjectId(orgId) } : {}) }, me(req));
      await trace(req, 'business.create', 'business', b._id.toHexString(), { kind: b.kind });
      return reply.status(201).send(view(b));
    },
  );

  // Référencement: the editors of a kind keep its businesses' profiles and catalogs up to date (with the owner, or
  // before the owner takes over). Same rules as the owner's routes, by business id.
  const editable = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const b = await service.byId(toObjectId(req.params.id));
    await mayEdit(req, b.kind);
    return { b, ref: { orgId: b.orgId, kind: b.kind } satisfies BusinessRef };
  };
  const AdminItemParams = Type.Object({ id: ObjectIdString, itemId: ObjectIdString }, { additionalProperties: false });

  app.get('/admin/businesses/:id', { ...admin, schema: { tags: ['admin'], params: IdParams, response: { 200: OwnBusinessView } } }, async (req) => ownView((await editable(req)).b));

  app.patch(
    '/admin/businesses/:id',
    {
      ...admin,
      schema: {
        tags: ['admin'],
        params: IdParams,
        description: 'The whole profile (name, picture, place, hours, delivery prices), hide or show it again, and open Wave / Orange Money once the team has verified who runs it (`onlinePayments`).',
        body: Type.Object({ ...ProfileBody.properties, active: Type.Optional(Type.Boolean()), onlinePayments: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
        response: { 200: OwnBusinessView },
      },
    },
    async (req) => {
      const { ref, b: before } = await editable(req);
      const { active, onlinePayments, ...profile } = req.body;
      // First: the methods sent with it are checked against the new permission.
      if (onlinePayments !== undefined) await service.setOnlinePayments(before._id, onlinePayments);
      let b = Object.keys(profile).length ? await service.update(ref, me(req), profile) : await service.ofOrg(ref);
      if (active !== undefined) b = await service.setActive(b._id, active);
      await trace(req, 'business.update', 'business', b._id.toHexString(), { fields: Object.keys(req.body), by: 'editor' });
      return ownView(b);
    },
  );

  app.get('/admin/businesses/:id/catalog', { ...admin, schema: { tags: ['admin'], params: IdParams, response: { 200: Type.Object({ items: Type.Array(ItemView) }) } } }, async (req) => {
    const { b } = await editable(req);
    return { items: (await service.catalog(b._id)).map((i) => service.itemView(i)) };
  });

  app.post(
    '/admin/businesses/:id/catalog',
    { ...admin, schema: { tags: ['admin'], params: IdParams, description: 'Restaurants: menu or drink. Shops: article (with stock).', body: Type.Object(EditorItemFields, { additionalProperties: false }), response: { 201: ItemView } } },
    async (req, reply) => {
      const { ref } = await editable(req);
      const item = await service.addItem(ref, me(req), req.body, EDITOR_MAX_ITEM_PHOTOS);
      await trace(req, 'catalog.add', 'catalog_item', item._id.toHexString(), { by: 'editor' });
      return reply.status(201).send(service.itemView(item));
    },
  );

  app.patch(
    '/admin/businesses/:id/catalog/:itemId',
    { ...admin, schema: { tags: ['admin'], params: AdminItemParams, body: Type.Partial(Type.Object(EditorItemFields, { additionalProperties: false })), response: { 200: ItemView } } },
    async (req) => {
      const { ref } = await editable(req);
      return service.itemView(await service.updateItem(ref, me(req), toObjectId(req.params.itemId), req.body, EDITOR_MAX_ITEM_PHOTOS));
    },
  );

  app.delete('/admin/businesses/:id/catalog/:itemId', { ...admin, schema: { tags: ['admin'], params: AdminItemParams } }, async (req, reply) => {
    const { ref } = await editable(req);
    await service.removeItem(ref, toObjectId(req.params.itemId));
    await trace(req, 'catalog.remove', 'catalog_item', req.params.itemId, { by: 'editor' });
    return reply.status(204).send();
  });
}
