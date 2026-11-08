import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { afterCommit, withTransaction } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import type { ImageRef } from '../../platform/media.js';
import { randomCode } from '../../platform/security/crypto.js';
import type { Limiter } from '../../platform/security/limiter.js';
import { CAMPUS_LABELS, type AccountsApi, type Campus } from '../accounts/index.js';
import type { MediaApi } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import { PAYOUT_PROVIDERS, type OrganizationsApi, type PayoutProvider } from '../organizations/index.js';
import type { PaymentMethod, PaymentsApi, PurposeHandler } from '../payments/index.js';
import { type BusinessDoc, type BusinessKind, type CatalogItemDoc, DEFAULT_PAYMENT_METHODS, type ItemLikeDoc, LIKEABLE_KINDS, DELIVERY_ZONE_LABELS, DELIVERY_ZONES, type DeliveryFees, type DeliveryZone, type ItemSection, MAX_ITEM_PHOTOS, MAX_SPECIALTIES, ONLINE_PAYMENT_METHODS, onlinePaymentsAllowed, ORDER_AUTO_COMPLETE_H, ORDER_PAY_WITHIN_MIN, ORDER_PAYMENT_LABELS, ORDER_PAYMENT_METHODS, type OrderDoc, type OrderLine, type OrderMode, type OrderPaymentMethod, type OrderStatus, SALES_MAX_DAYS, SALES_TOP_ITEMS, type Service, SPECIALTIES } from './commerce.types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const fcfa = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
const localPhone = (e164: string) => e164.replace(/^\+221/, '').replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
/** "13:00" → "13h", "19:30" → "19h30". */
const hourLabel = (hhmm: string) => hhmm.replace(/^0/, '').replace(':00', 'h').replace(':', 'h');
/** Where to see a new order (business space) and to follow mine (student). */
const BUSINESS_ORDER_URL = (id: ObjectId) => `/commande-recue/${id.toHexString()}`;
const MY_ORDER_URL = (id: ObjectId) => `/commande/${id.toHexString()}`;
/** Steps the business moves an order through, and from where. */
const NEXT: Partial<Record<OrderStatus, OrderStatus>> = { placed: 'accepted', accepted: 'ready', ready: 'completed' };

export type BusinessInput = {
  name?: string;
  paymentMethods?: OrderPaymentMethod[];
  specialties?: string[];
  description?: string;
  photoId?: string | null;
  location?: { lat: number; lng: number } | null;
  address?: string;
  campus?: Campus | null;
  phone?: string;
  services?: Service[];
  deliveryFees?: DeliveryFees;
  acceptingOrders?: boolean;
  /** Where each provider's money goes (null: back to the organization's number). Required for each one accepted. */
  payoutNumbers?: Partial<Record<PayoutProvider, string | null>>;
};

/** A business is found by its organization and its kind: one entity may run a restaurant and a shop. */
export type BusinessRef = { orgId: ObjectId; kind: BusinessKind };
const NO_DELIVERY: DeliveryFees = { campus1: null, campus2: null, outside: null };
const delivers = (f: DeliveryFees) => DELIVERY_ZONES.some((z) => f[z] !== null);

export type ItemInput = {
  section: ItemSection; category?: string | null; name: string; detail?: string; price: number;
  /** The cover first. `photoId`: older apps, one picture. */
  photoIds?: string[]; photoId?: string | null;
  stock?: number | null; available?: boolean; orderable?: boolean; sortOrder?: number;
};

/** The pictures asked for, `photoIds` or the older `photoId`; undefined: not changed. */
const requestedPhotos = (input: Partial<ItemInput>): string[] | undefined =>
  input.photoIds !== undefined ? [...new Set(input.photoIds)] : input.photoId !== undefined ? (input.photoId ? [input.photoId] : []) : undefined;

export class CommerceService {
  private readonly businesses: Collection<BusinessDoc>;
  private readonly items: Collection<CatalogItemDoc>;
  private readonly orders: Collection<OrderDoc>;
  private readonly likes: Collection<ItemLikeDoc>;
  private readonly interests: Collection<{ _id?: ObjectId; userId: ObjectId; itemId: ObjectId; businessId: ObjectId; createdAt: Date }>;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
    private readonly organizations: OrganizationsApi,
    private readonly payments: PaymentsApi,
    private readonly media: MediaApi,
    private readonly notifications: NotificationsApi,
    private readonly limiter: Limiter,
  ) {
    this.businesses = db.collection('businesses');
    this.items = db.collection('catalogItems');
    this.orders = db.collection('commerceOrders');
    this.likes = db.collection('itemLikes');
    this.interests = db.collection('itemInterests');
  }

  // ---- Admins: creating a restaurant or a shop --------------------------------------------------------------------

  /**
   * The organization (capability restaurant or shop, its payouts to the owner's number), its owner (an account is
   * created for a new number: they set their password with "mot de passe oublié") and its business profile.
   */
  /**
   * An admin adds a restaurant or a shop: to a new entity (with its owner, an account created for a new number), or
   * to an existing one (`orgId`: Khoulé & frère's restaurant gets a shop) whose owners then hold the new space too.
   */
  /** `by`: who adds it (an editor): the picture they uploaded is claimed by them. */
  async create(input: { kind: BusinessKind; name: string; specialties: string[]; orgId?: ObjectId; owner?: { phone: string; firstName: string; lastName: string; password?: string } } & BusinessInput, by?: ObjectId): Promise<BusinessDoc> {
    const specialties = this.checkSpecialties(input.kind, input.specialties)!;
    let orgId: ObjectId;
    let ownerPhone: string;
    if (input.orgId) {
      const same = await this.businesses.findOne({ orgId: input.orgId, kind: input.kind });
      if (same) throw errors.conflict('BUSINESS_EXISTS', `Cette entité a déjà ${input.kind === 'restaurant' ? 'un restaurant' : 'une boutique'} : ${same.name}. Modifie-le plutôt.`);
      const org = await this.organizations.addCapability(input.orgId, input.kind);
      orgId = org._id;
      ownerPhone = org.payoutAccount?.phone ?? '';
    } else {
      if (!input.owner) throw errors.validation('Indique le propriétaire.', { field: 'owner' });
      const phone = this.accounts.phoneOrThrow(input.owner.phone);
      // One account, one entity (one restaurant, one shop, one organizer at most): a number that already owns one
      // gets the business in it, never a second entity.
      const known = await this.accounts.findByPhone(phone);
      const owned = known ? await this.organizations.ownedBy(known._id) : [];
      if (owned.length) return this.create({ ...input, owner: undefined, orgId: owned[0]!.orgId }, by);
      const owner = known ?? (await this.accounts.createStaffUser({ phone, firstName: input.owner.firstName, lastName: input.owner.lastName, password: input.owner.password }));
      const slug = `${input.kind}-${input.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}-${randomCode(4).toLowerCase()}`;
      const org = await this.organizations.create({
        slug, name: input.name, category: input.kind === 'restaurant' ? 'Restaurant' : 'Boutique', capabilities: [input.kind], level: 'verifie', payoutPhone: owner.payoutAccount.phone,
      });
      await this.organizations.setOwner(org._id, phone, null);
      orgId = org._id;
      ownerPhone = owner.phone;
    }
    const now = this.clock.now();
    const doc: BusinessDoc = {
      _id: new ObjectId(), orgId, kind: input.kind, name: input.name.trim(), specialties, description: '', photo: null, location: null, address: '', campus: null,
      phone: ownerPhone ? localPhone(ownerPhone) : '', services: input.kind === 'restaurant' ? [{ start: '12:00', end: '15:00' }, { start: '19:00', end: '22:00' }] : [{ start: '08:00', end: '21:00' }],
      deliveryFees: NO_DELIVERY, paymentMethods: [...DEFAULT_PAYMENT_METHODS], acceptingOrders: true, active: true, createdAt: now, updatedAt: now,
    };
    await this.businesses.insertOne(doc);
    const claimer = by ?? (await this.organizations.members(orgId, input.kind)).find((m) => m.roles.includes('owner'))?.userId ?? new ObjectId();
    return this.update({ orgId, kind: input.kind }, claimer, input);
  }

  /**
   * A student opens their own shop (products or services): under their personal entity, they own it, orders are paid
   * to their number. It's a shop like the others: catalog, orders, team, and its articles in the market.
   */
  async openStudentShop(userId: ObjectId, input: { name: string; specialties: string[]; description?: string; photoId?: string | null; paymentMethods?: OrderPaymentMethod[] }) {
    const user = await this.accounts.findById(userId);
    if (!user) throw errors.notFound();
    if (!(await this.accounts.hasStudentProfile(userId))) throw errors.forbidden('Réservé aux étudiants.');
    // One account, one entity: a student who already owns one (their restaurant…) opens the shop in it.
    const orgId = (await this.organizations.ownedBy(userId))[0]?.orgId ?? (await this.organizations.personalOrg(user))!;
    if (await this.businesses.findOne({ orgId, kind: 'shop' })) throw errors.conflict('SHOP_EXISTS', 'Tu as déjà ta boutique : ouvre-la depuis « Mes espaces ».');
    const specialties = this.checkSpecialties('shop', input.specialties)!;
    // Cash only until the team has verified the shop (then Wave and Orange Money open).
    const paymentMethods = this.checkMethods(input.paymentMethods ?? ['cash'], { onlinePayments: false, byStudent: true });
    await this.organizations.addCapability(orgId, 'shop');
    const now = this.clock.now();
    await this.businesses.insertOne({
      _id: new ObjectId(), orgId, kind: 'shop', name: input.name.trim(), specialties, description: '', photo: null, location: null, address: '', campus: null,
      phone: localPhone(user.phone), services: [{ start: '08:00', end: '22:00' }], deliveryFees: NO_DELIVERY, paymentMethods, acceptingOrders: true, active: true, byStudent: true, onlinePayments: false, createdAt: now, updatedAt: now,
    });
    return this.update({ orgId, kind: 'shop' }, userId, { description: input.description ?? '', ...(input.photoId ? { photoId: input.photoId } : {}) });
  }

  /** One to MAX_SPECIALTIES, each from the kind's list (duplicates dropped). Undefined: unchanged. */
  private checkSpecialties(kind: BusinessKind, list: string[] | undefined) {
    if (list === undefined) return undefined;
    const clean = [...new Set(list.map((x) => x.trim()))];
    if (!clean.length || clean.length > MAX_SPECIALTIES) throw errors.validation(`Choisis de 1 à ${MAX_SPECIALTIES} spécialités.`, { field: 'specialties' });
    if (clean.some((x) => !SPECIALTIES[kind].includes(x))) throw errors.validation('Choisis les spécialités dans la liste.', { field: 'specialties' });
    return clean;
  }

  async byId(id: ObjectId) {
    const b = await this.businesses.findOne({ _id: id });
    if (!b) throw errors.notFound('Commerce introuvable.');
    return b;
  }

  /**
   * Référencement, before adding a restaurant or a shop: does this number have an account, and which entities does it
   * own, with the businesses each runs (a student's own shop too: "Magueye Gueye · MGG fashion").
   */
  async ownerLookup(phoneInput: string) {
    const user = await this.accounts.findByPhone(this.accounts.phoneOrThrow(phoneInput));
    if (!user || user.status === 'deleted') return { account: null, entities: [] };
    const owned = await this.organizations.ownedBy(user._id);
    const runs = owned.length ? await this.businesses.find({ orgId: { $in: owned.map((o) => o.orgId) } }, { projection: { orgId: 1, kind: 1, name: 1 } }).toArray() : [];
    // One entity per account: the first is the one (there is never more than one since this rule).
    return {
      account: { firstName: user.firstName, lastName: user.lastName },
      entities: owned.map((o) => {
        const mine = runs.filter((b) => b.orgId.equals(o.orgId));
        return {
          orgId: o.orgId.toHexString(), name: o.name, personal: o.personal, organizer: o.organizer, kinds: mine.map((b) => b.kind),
          businesses: mine.map((b) => ({ id: b._id.toHexString(), kind: b.kind, name: b.name })),
        };
      }),
    };
  }

  listAll() {
    return this.businesses.find({}).sort({ kind: 1, name: 1 }).toArray();
  }

  /** At least one, in the usual order; Wave and Orange Money only once the business may take them. */
  private checkMethods(asked: OrderPaymentMethod[], b: Pick<BusinessDoc, 'onlinePayments' | 'byStudent'>) {
    const methods = ORDER_PAYMENT_METHODS.filter((m) => asked.includes(m));
    if (!methods.length) throw errors.validation('Accepte au moins un moyen de paiement.', { field: 'paymentMethods' });
    if (!onlinePaymentsAllowed(b) && methods.some((m) => ONLINE_PAYMENT_METHODS.includes(m)))
      throw errors.rule('ONLINE_PAYMENTS_LOCKED', 'Wave et Orange Money s’ouvrent quand l’équipe UGB Connect a vérifié ta boutique : contacte-la. En attendant, les espèces.');
    return methods;
  }

  /**
   * The team (back office) opens or closes Wave and Orange Money for a business. Closed: those methods are taken
   * off, cash stays (added if it was the only way left).
   */
  async setOnlinePayments(id: ObjectId, allowed: boolean) {
    const b = await this.businesses.findOne({ _id: id });
    if (!b) throw errors.notFound('Commerce introuvable.');
    const offline = b.paymentMethods.filter((m) => !ONLINE_PAYMENT_METHODS.includes(m));
    const paymentMethods = allowed ? b.paymentMethods : offline.length ? offline : (['cash'] as OrderPaymentMethod[]);
    return (await this.businesses.findOneAndUpdate({ _id: id }, { $set: { onlinePayments: allowed, paymentMethods, updatedAt: this.clock.now() } }, { returnDocument: 'after' }))!;
  }

  async setActive(id: ObjectId, active: boolean) {
    const b = await this.businesses.findOneAndUpdate({ _id: id }, { $set: { active, updatedAt: this.clock.now() } }, { returnDocument: 'after' });
    if (!b) throw errors.notFound('Commerce introuvable.');
    return b;
  }

  // ---- Its own space: profile and catalog -------------------------------------------------------------------------

  async ofOrg(ref: BusinessRef) {
    const b = await this.businesses.findOne({ orgId: ref.orgId, kind: ref.kind });
    if (!b) throw errors.notFound('Commerce introuvable.');
    return b;
  }

  async update(ref: BusinessRef, by: ObjectId, input: BusinessInput) {
    const b = await this.ofOrg(ref);
    const specialties = this.checkSpecialties(b.kind, input.specialties);
    const set: Partial<BusinessDoc> = { updatedAt: this.clock.now() };
    if (input.name !== undefined) set.name = input.name.trim();
    if (specialties) set.specialties = specialties;
    if (input.description !== undefined) set.description = input.description.trim();
    if (input.photoId !== undefined) set.photo = input.photoId ? (await this.media.claim(by, [input.photoId]))[0]! : null;
    if (input.location !== undefined) set.location = input.location;
    if (input.address !== undefined) set.address = input.address.trim();
    if (input.campus !== undefined) set.campus = input.campus;
    if (input.phone !== undefined) set.phone = localPhone(this.accounts.phoneOrThrow(input.phone));
    if (input.services !== undefined) {
      const ok = input.services.every((s) => /^\d{2}:\d{2}$/.test(s.start) && /^\d{2}:\d{2}$/.test(s.end) && minutes(s.start) < minutes(s.end) && minutes(s.end) <= 24 * 60);
      if (!ok || !input.services.length) throw errors.validation('Horaires invalides : de 08:00 à 15:00 par exemple.', { field: 'services' });
      set.services = [...input.services].sort((a, b2) => minutes(a.start) - minutes(b2.start));
    }
    if (input.deliveryFees !== undefined) set.deliveryFees = { ...NO_DELIVERY, ...input.deliveryFees };
    if (input.acceptingOrders !== undefined) set.acceptingOrders = input.acceptingOrders;
    if (input.paymentMethods !== undefined) set.paymentMethods = this.checkMethods(input.paymentMethods, b);
    // Each provider accepted pays out to a number (its own, or the organization's): checked before anything is saved.
    if (input.payoutNumbers !== undefined || input.paymentMethods !== undefined) await this.checkPayoutNumbers(b.orgId, set.paymentMethods ?? b.paymentMethods, input.payoutNumbers);
    await this.businesses.updateOne({ _id: b._id }, { $set: set });
    // The previous photo leaves the storage once the new one is saved.
    if (set.photo !== undefined && !(set.photo && b.photo && set.photo.mediaId.equals(b.photo.mediaId))) await this.media.release([b.photo?.mediaId]);
    return (await this.businesses.findOne({ _id: b._id }))!;
  }

  /**
   * Wave and Orange Money, when accepted, each need a payout number. `numbers` sent: saved first (a number taken off
   * falls back to the organization's), then the rule is checked on what's stored.
   */
  private async checkPayoutNumbers(orgId: ObjectId, methods: OrderPaymentMethod[], numbers?: Partial<Record<PayoutProvider, string | null>>) {
    if (numbers) await this.organizations.setPayoutNumbers(orgId, numbers);
    const stored = await this.organizations.payoutNumbers(orgId);
    const missing = methods.filter((m): m is PayoutProvider => (PAYOUT_PROVIDERS as readonly string[]).includes(m) && !stored[m as PayoutProvider]);
    if (missing.length) {
      throw errors.validation(`Indique le numéro de versement ${missing[0] === 'wave' ? 'Wave' : 'Orange Money'} : c’est là que l’argent des commandes arrive.`, { field: `payoutNumbers.${missing[0]}` });
    }
  }

  /** The payout numbers, for the owner and Référencement only (never the students' view). */
  payoutNumbers(b: BusinessDoc) {
    return this.organizations.payoutNumbers(b.orgId);
  }

  /** Everything in the catalog, unavailable items included (the business's view). */
  catalog(businessId: ObjectId) {
    return this.items.find({ businessId, archivedAt: null }).sort({ section: 1, sortOrder: 1, createdAt: 1 }).toArray();
  }

  private checkSection(b: BusinessDoc, section: ItemSection) {
    const allowed: ItemSection[] = b.kind === 'restaurant' ? ['menu', 'drink'] : ['article'];
    if (!allowed.includes(section)) throw errors.validation(b.kind === 'restaurant' ? 'Un restaurant propose des menus et des boissons.' : 'Une boutique propose des articles.', { field: 'section' });
  }

  /** `maxPhotos`: the owners' limit, or Référencement's (EDITOR_MAX_ITEM_PHOTOS) from its own routes. */
  async addItem(ref: BusinessRef, by: ObjectId, input: ItemInput, maxPhotos = MAX_ITEM_PHOTOS) {
    const b = await this.ofOrg(ref);
    this.checkSection(b, input.section);
    const now = this.clock.now();
    const orderable = input.orderable ?? true;
    const doc: CatalogItemDoc = {
      _id: new ObjectId(), businessId: b._id, section: input.section, category: input.category?.trim() || null, name: input.name.trim(), detail: input.detail?.trim() ?? '', price: input.price,
      photos: await this.itemPhotos(by, requestedPhotos(input) ?? [], [], maxPhotos), stock: b.kind === 'shop' && orderable ? (input.stock ?? null) : null, available: input.available ?? true, orderable,
      likes: 0, sortOrder: input.sortOrder ?? now.getTime(), archivedAt: null, createdAt: now, updatedAt: now,
    };
    await this.items.insertOne(doc);
    return doc;
  }

  async updateItem(ref: BusinessRef, by: ObjectId, itemId: ObjectId, input: Partial<ItemInput>, maxPhotos = MAX_ITEM_PHOTOS) {
    const b = await this.ofOrg(ref);
    const item = await this.items.findOne({ _id: itemId, businessId: b._id, archivedAt: null });
    if (!item) throw errors.notFound('Article introuvable.');
    if (input.section) this.checkSection(b, input.section);
    const set: Partial<CatalogItemDoc> = { updatedAt: this.clock.now() };
    if (input.section !== undefined) set.section = input.section;
    if (input.category !== undefined) set.category = input.category?.trim() || null;
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.detail !== undefined) set.detail = input.detail.trim();
    if (input.price !== undefined) set.price = input.price;
    const photoIds = requestedPhotos(input);
    if (photoIds !== undefined) set.photos = await this.itemPhotos(by, photoIds, item.photos, maxPhotos);
    if (input.stock !== undefined && b.kind === 'shop') set.stock = input.stock;
    if (input.available !== undefined) set.available = input.available;
    if (input.orderable !== undefined) set.orderable = input.orderable;
    // For information only: nothing to count.
    if ((set.orderable ?? item.orderable) === false) set.stock = null;
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
    await this.items.updateOne({ _id: itemId }, { $set: set });
    // Pictures taken off the article leave the storage once the new set is saved.
    if (set.photos) await this.media.release(item.photos.filter((old) => !set.photos!.some((p) => p.mediaId.equals(old.mediaId))).map((p) => p.mediaId));
    return (await this.items.findOne({ _id: itemId }))!;
  }

  /** Out of the catalog; past orders keep their lines. */
  async removeItem(ref: BusinessRef, itemId: ObjectId) {
    const b = await this.ofOrg(ref);
    const res = await this.items.updateOne({ _id: itemId, businessId: b._id, archivedAt: null }, { $set: { archivedAt: this.clock.now() } });
    if (!res.matchedCount) throw errors.notFound('Article introuvable.');
  }

  // ---- Students: browsing ---------------------------------------------------------------------------------------------

  /** Open now: Dakar time is UTC, every day the same services. */
  status(b: Pick<BusinessDoc, 'services' | 'acceptingOrders'>) {
    const now = this.clock.now();
    const m = now.getUTCHours() * 60 + now.getUTCMinutes();
    const current = b.services.find((s) => m >= minutes(s.start) && m < minutes(s.end));
    const next = b.services.find((s) => m < minutes(s.start)) ?? b.services[0];
    const open = !!current && b.acceptingOrders;
    const label = !b.acceptingOrders
      ? 'Commandes en pause'
      : current
        ? `Ouvert · jusqu’à ${hourLabel(current.end)}`
        : next
          ? `Fermé · ${m < minutes(next.start) ? 'ouvre' : 'demain'} à ${hourLabel(next.start)}`
          : 'Fermé';
    return { open, label };
  }

  async list(kind: BusinessKind, viewer: ObjectId) {
    const docs = await this.businesses.find({ kind, active: true }).sort({ name: 1 }).toArray();
    const items = docs.length ? await this.items.find({ businessId: { $in: docs.map((d) => d._id) }, archivedAt: null, available: true }).sort({ sortOrder: 1 }).toArray() : [];
    const [liked, interested] = await Promise.all([this.likedBy(viewer, items), this.interestedBy(viewer, items)]);
    return docs
      .map((b) => {
        const mine = items.filter((i) => i.businessId.equals(b._id));
        return {
          ...this.publicView(b),
          highlights: mine.filter((i) => i.section !== 'drink').slice(0, 3).map((i) => this.itemView(i, liked, interested)),
          // « Dès 1 500 F »: the cheapest dish, never a drink (a 250 F water would say nothing about the meal). A shop has
          // no drinks section: all its articles count.
          minPrice: (() => {
            const dishes = mine.filter((i) => i.section !== 'drink');
            const priced = dishes.length ? dishes : mine;
            return priced.length ? Math.min(...priced.map((i) => i.price)) : null;
          })(),
          itemsCount: mine.length,
          // Searching "mafé" finds the restaurants that serve it.
          itemNames: mine.map((i) => i.name),
        };
      })
      .sort((a, b) => Number(b.open) - Number(a.open));
  }

  /**
   * The market: every available article of every open-or-not shop at once (one campus, a few hundred articles), each
   * with its shop, to browse and search across shops.
   */
  async market(kind: BusinessKind, viewer: ObjectId) {
    const docs = await this.businesses.find({ kind, active: true }).sort({ name: 1 }).toArray();
    const items = docs.length ? await this.items.find({ businessId: { $in: docs.map((d) => d._id) }, archivedAt: null, available: true }).sort({ sortOrder: 1 }).limit(1000).toArray() : [];
    const [liked, interested] = await Promise.all([this.likedBy(viewer, items), this.interestedBy(viewer, items)]);
    return {
      businesses: docs.map((b) => this.publicView(b)).sort((a, b) => Number(b.open) - Number(a.open)),
      items: items.map((i) => ({ ...this.itemView(i, liked, interested), businessId: i.businessId.toHexString() })),
    };
  }

  async detail(id: ObjectId, viewer: ObjectId) {
    const b = await this.businesses.findOne({ _id: id, active: true });
    if (!b) throw errors.notFound('Commerce introuvable.');
    const items = await this.items.find({ businessId: b._id, archivedAt: null, available: true }).sort({ section: 1, sortOrder: 1 }).toArray();
    const [liked, interested] = await Promise.all([this.likedBy(viewer, items), this.interestedBy(viewer, items)]);
    return { ...this.publicView(b), items: items.map((i) => this.itemView(i, liked, interested)) };
  }

  /** Which of these items the student likes (their hexes). */
  private async interestedBy(userId: ObjectId, items: CatalogItemDoc[]): Promise<Set<string>> {
    const onSite = items.filter((i) => !i.orderable);
    if (!onSite.length) return new Set();
    const mine = await this.interests.find({ userId, itemId: { $in: onSite.map((i) => i._id) } }, { projection: { itemId: 1 } }).toArray();
    return new Set(mine.map((l) => l.itemId.toHexString()));
  }

  /**
   * « Intéressé » on an article done on the spot (printing, repairs…: nothing to order): the shop's team is told who,
   * with their phone, to call them back. Once per student and article (`on` again is a no-op); `off` takes it back.
   */
  async interest(userId: ObjectId, itemId: ObjectId, on: boolean): Promise<{ interested: boolean }> {
    await this.limiter.hit(`interest:${userId.toHexString()}`, { limit: 60, windowS: 3600 });
    const item = await this.items.findOne({ _id: itemId, archivedAt: null });
    const b = item && (await this.businesses.findOne({ _id: item.businessId, active: true }));
    if (!item || !b) throw errors.notFound('Article introuvable.');
    if (item.orderable) throw errors.rule('ORDERABLE', 'Cet article se commande : ajoute-le au panier.');
    if (!on) {
      await this.interests.deleteOne({ userId, itemId });
      return { interested: false };
    }
    const team = (await this.organizations.members(b.orgId, b.kind)).filter((m) => m.roles.some((r) => r === 'owner' || r === 'manager' || r === 'staff'));
    if (team.some((m) => m.userId.equals(userId))) throw errors.rule('OWN_BUSINESS', 'C’est ta boutique : tes clients te le diront.');
    const res = await this.interests.updateOne({ userId, itemId }, { $setOnInsert: { businessId: b._id, createdAt: this.clock.now() } }, { upsert: true });
    if (res.upsertedCount) {
      const who = await this.accounts.findById(userId);
      const name = who ? `${who.firstName} ${who.lastName}` : 'Un étudiant';
      await this.notifications.notify(
        team.map((m) => m.userId),
        {
          type: 'commerce.item_interest', category: 'paiements', icon: 'hand-left-outline', tone: 'primary', url: '/catalogue', dedupeKey: `interest:${userId.toHexString()}:${itemId.toHexString()}`, channel: 'orders',
          title: `${name} est intéressé(e) · ${item.name}`,
          body: who ? `Rappelle au ${localPhone(who.phone)} pour convenir du rendez-vous.` : 'Retrouve sa demande dans ton catalogue.',
        },
      );
    }
    return { interested: true };
  }

  /** The shop's side: who said « Intéressé » lately (30 days), newest first, to call them back. */
  async interestsOf(ref: BusinessRef) {
    const b = await this.ofOrg(ref);
    const since = new Date(this.clock.now().getTime() - 30 * 86_400_000);
    const list = await this.interests.find({ businessId: b._id, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(100).toArray();
    const [users, items] = await Promise.all([
      this.accounts.contactsByIds([...new Map(list.map((x) => [x.userId.toHexString(), x.userId])).values()]),
      this.items.find({ _id: { $in: list.map((x) => x.itemId) } }, { projection: { name: 1 } }).toArray(),
    ]);
    const names = new Map(items.map((i) => [i._id.toHexString(), i.name]));
    return list.map((x) => {
      const c = users.get(x.userId.toHexString());
      return {
        id: x._id!.toHexString(), at: x.createdAt.toISOString(),
        item: { id: x.itemId.toHexString(), name: names.get(x.itemId.toHexString()) ?? 'Article retiré' },
        student: { name: c ? `${c.firstName} ${c.lastName}` : 'Étudiant', phone: c ? localPhone(c.phone) : '' },
      };
    });
  }

  private async likedBy(userId: ObjectId, items: CatalogItemDoc[]): Promise<Set<string>> {
    if (!items.length) return new Set();
    const mine = await this.likes.find({ userId, itemId: { $in: items.map((i) => i._id) } }, { projection: { itemId: 1 } }).toArray();
    return new Set(mine.map((l) => l.itemId.toHexString()));
  }

  /**
   * A student likes an article or a dish (`on`), or no longer does. Idempotent: liking twice counts once. Its own team
   * doesn't like its own items (as they don't order them).
   */
  async like(userId: ObjectId, itemId: ObjectId, on: boolean): Promise<{ liked: boolean; likes: number }> {
    await this.limiter.hit(`like:${userId.toHexString()}`, { limit: 300, windowS: 3600 });
    const item = await this.items.findOne({ _id: itemId, archivedAt: null });
    const b = item && (await this.businesses.findOne({ _id: item.businessId, active: true }));
    if (!item || !b) throw errors.notFound('Article introuvable.');
    if (!LIKEABLE_KINDS.includes(b.kind)) throw errors.rule('NOT_LIKEABLE', 'Seuls les articles des boutiques peuvent être aimés.');
    if (on && (await this.organizations.members(b.orgId, b.kind)).some((m) => m.userId.equals(userId)))
      throw errors.rule('OWN_BUSINESS', b.kind === 'shop' ? 'C’est ta boutique : tu ne peux pas aimer tes articles.' : 'C’est ton restaurant : tu ne peux pas aimer tes plats.');
    // The like and the count change together.
    await withTransaction(this.mongo, async (session) => {
      if (on) {
        // An upsert, not an insert: a duplicate-key error would abort the transaction. Already liked: nothing to count.
        const res = await this.likes.updateOne({ userId, itemId }, { $setOnInsert: { businessId: b._id, createdAt: this.clock.now() } }, { upsert: true, session });
        if (res.upsertedCount) await this.items.updateOne({ _id: itemId }, { $inc: { likes: 1 } }, { session });
      } else {
        const res = await this.likes.deleteOne({ userId, itemId }, { session });
        if (res.deletedCount) await this.items.updateOne({ _id: itemId, likes: { $gt: 0 } }, { $inc: { likes: -1 } }, { session });
      }
    });
    const after = await this.items.findOne({ _id: itemId }, { projection: { likes: 1 } });
    return { liked: on, likes: after?.likes ?? 0 };
  }

  /** The students' average rating of its orders (ratings module). */
  async setRating(businessId: ObjectId, avg: number | null, count: number) {
    await this.businesses.updateOne({ _id: businessId }, { $set: { rating: { avg, count }, updatedAt: this.clock.now() } });
  }

  publicView(b: BusinessDoc) {
    const st = this.status(b);
    return {
      id: b._id.toHexString(),
      orgId: b.orgId.toHexString(),
      kind: b.kind,
      name: b.name,
      specialties: b.specialties,
      // Joined, for the lines that show it ("Sénégalais · Grillades").
      specialty: b.specialties.join(' · '),
      description: b.description,
      photo: b.photo?.url ?? null,
      location: b.location,
      address: b.address,
      campus: b.campus,
      campusLabel: b.campus ? CAMPUS_LABELS[b.campus] : null,
      phone: b.phone,
      services: b.services,
      hours: b.services.map((s) => `${hourLabel(s.start)}-${hourLabel(s.end)}`).join(' · '),
      open: st.open,
      statusLabel: st.label,
      deliveryFees: b.deliveryFees,
      // The lowest price, for the cards ("Livraison dès 200 F"); null: pickup only.
      deliveryFee: delivers(b.deliveryFees) ? Math.min(...DELIVERY_ZONES.map((z) => b.deliveryFees[z]).filter((f): f is number => f !== null)) : null,
      acceptingOrders: b.acceptingOrders,
      rating: b.rating?.avg ?? null,
      ratingCount: b.rating?.count ?? 0,
      paymentMethods: b.paymentMethods.map((m) => ({ value: m, label: ORDER_PAYMENT_LABELS[m] })),
      active: b.active,
      byStudent: !!b.byStudent,
      onlinePayments: onlinePaymentsAllowed(b),
      itemLikes: LIKEABLE_KINDS.includes(b.kind),
    };
  }

  /** `liked`: the items the caller likes (see `likedBy`); none for the business's own views. */
  itemView(i: CatalogItemDoc, liked?: Set<string>, interested?: Set<string>) {
    return {
      id: i._id.toHexString(), section: i.section, category: i.category, name: i.name, detail: i.detail, price: i.price,
      photo: i.photos[0]?.url ?? null, photos: i.photos.map((p) => p.url), photoIds: i.photos.map((p) => p.mediaId.toHexString()),
      stock: i.stock, soldOut: i.stock !== null && i.stock <= 0, available: i.available, orderable: i.orderable,
      likes: i.likes ?? 0, liked: !!liked?.has(i._id.toHexString()), interested: !!interested?.has(i._id.toHexString()), createdAt: i.createdAt.toISOString(),
    };
  }

  /** Pictures already on the article stay as they are; new uploads must be the editor's. */
  private async itemPhotos(by: ObjectId, ids: string[], current: ImageRef[], max: number): Promise<ImageRef[]> {
    if (ids.length > max) throw errors.validation(`${max} photos au plus.`, { field: 'photoIds' });
    const kept = new Map(current.map((p) => [p.mediaId.toHexString(), p]));
    const fresh = ids.filter((id) => !kept.has(id));
    const claimed = fresh.length ? await this.media.claim(by, fresh) : [];
    return ids.map((id) => kept.get(id) ?? claimed.find((c) => c.mediaId.toHexString() === id)!);
  }

  // ---- Students: ordering -----------------------------------------------------------------------------------------

  /**
   * One order to one business, paid now (Wave / Orange Money). Shops' stock is taken here (a conditional update per
   * article: two students never get the last one) and given back if the order isn't paid, is refused or cancelled.
   */
  async place(userId: ObjectId, businessId: ObjectId, input: { lines: { itemId: string; qty: number }[]; mode: OrderMode; zone?: DeliveryZone | null; address?: string | null; note?: string | null; method: OrderPaymentMethod; returnUrl?: string | null }, baseUrl: string) {
    await this.limiter.hit(`order:${userId.toHexString()}`, { limit: 20, windowS: 3600 });
    const cash = input.method === 'cash';
    if (!cash) this.payments.assertAvailable(input.method as PaymentMethod);
    const returnUrl = cash ? null : this.payments.validateReturnUrl(input.returnUrl);
    const b = await this.businesses.findOne({ _id: businessId, active: true });
    if (!b) throw errors.notFound('Commerce introuvable.');
    // Its owner and team manage it; they don't order from it.
    if ((await this.organizations.members(b.orgId, b.kind)).some((m) => m.userId.equals(userId)))
      throw errors.rule('OWN_BUSINESS', b.kind === 'shop' ? 'C’est ta boutique : tu ne peux pas y commander.' : 'C’est ton restaurant : tu ne peux pas y commander.');
    if (!b.paymentMethods.includes(input.method) || (ONLINE_PAYMENT_METHODS.includes(input.method) && !onlinePaymentsAllowed(b))) {
      throw errors.validation(`${b.name} accepte : ${b.paymentMethods.map((m) => ORDER_PAYMENT_LABELS[m]).join(', ')}.`, { field: 'method' });
    }
    const st = this.status(b);
    if (!st.open) throw errors.conflict('BUSINESS_CLOSED', `${b.name} ne prend pas de commande pour le moment (${st.label.toLowerCase()}).`);
    if (input.mode === 'delivery' && !delivers(b.deliveryFees)) throw errors.validation(`${b.name} ne livre pas : choisis « À emporter ».`, { field: 'mode' });
    if (input.mode === 'delivery' && !input.zone) throw errors.validation('Choisis où te livrer : campus 1, campus 2 ou hors campus.', { field: 'zone' });
    if (input.mode === 'delivery' && b.deliveryFees[input.zone!] === null) throw errors.validation(`${b.name} ne livre pas ${input.zone === 'outside' ? 'hors du campus' : `au ${DELIVERY_ZONE_LABELS[input.zone!].toLowerCase()}`}.`, { field: 'zone' });
    if (input.mode === 'delivery' && !input.address?.trim()) throw errors.validation('Indique où te livrer.', { field: 'address' });
    const wanted = input.lines.filter((l) => l.qty > 0);
    if (!wanted.length) throw errors.validation('Ton panier est vide.', { field: 'lines' });
    if (new Set(wanted.map((l) => l.itemId)).size !== wanted.length) throw errors.validation('Un article est en double.', { field: 'lines' });
    const items = await this.items.find({ _id: { $in: wanted.map((l) => (ObjectId.isValid(l.itemId) ? new ObjectId(l.itemId) : new ObjectId())) }, businessId: b._id, archivedAt: null }).toArray();
    const lines: OrderLine[] = wanted.map((l) => {
      const item = items.find((i) => i._id.toHexString() === l.itemId);
      if (!item || !item.available) throw errors.conflict('ITEM_UNAVAILABLE', `${item?.name ?? 'Un article'} n’est plus disponible : retire-le de ton panier.`);
      if (!item.orderable) throw errors.rule('ITEM_NOT_ORDERABLE', `${item.name} se fait sur place : il ne se commande pas.`);
      return { itemId: item._id, name: item.name, price: item.price, qty: l.qty };
    });
    const subtotal = lines.reduce((n, l) => n + l.price * l.qty, 0);
    const deliveryFee = input.mode === 'delivery' ? (b.deliveryFees[input.zone!] ?? 0) : 0;
    const now = this.clock.now();

    const { order, payment } = await withTransaction(this.mongo, async (session) => {
      for (const l of lines) {
        const item = items.find((i) => i._id.equals(l.itemId))!;
        if (item.stock === null) continue;
        const taken = await this.items.updateOne({ _id: item._id, stock: { $gte: l.qty } }, { $inc: { stock: -l.qty }, $set: { updatedAt: now } }, { session });
        if (!taken.modifiedCount) throw errors.conflict('OUT_OF_STOCK', `Plus assez de « ${item.name} » : ${Math.max(0, item.stock)} restant${item.stock > 1 ? 's' : ''}.`);
      }
      const orderId = new ObjectId();
      // Cash: no online payment; the order goes straight to the business, paid at delivery or at the counter.
      const created = cash
        ? null
        : await this.payments.create(
        {
          userId, purpose: 'commerce_order', purposeRef: orderId, amount: subtotal + deliveryFee, method: input.method as PaymentMethod,
          description: `${b.name} · ${lines.reduce((n, l) => n + l.qty, 0)} article(s)`, expiresAt: new Date(now.getTime() + ORDER_PAY_WITHIN_MIN * MIN), returnUrl,
        },
        session,
      );
      const doc: OrderDoc = {
        _id: orderId, code: `C${randomCode(6)}`, businessId: b._id, orgId: b.orgId, userId, lines, subtotal, deliveryFee, total: subtotal + deliveryFee, mode: input.mode, zone: input.mode === 'delivery' ? input.zone! : null,
        address: input.mode === 'delivery' ? input.address!.trim() : null, note: input.note?.trim() || null, method: input.method, paymentId: created?._id ?? null, status: cash ? 'placed' : 'pending_payment',
        history: [{ status: cash ? 'placed' : 'pending_payment', at: now, by: userId }], refusal: null, payoutId: null, refundPayoutId: null, createdAt: now, updatedAt: now,
      };
      await this.orders.insertOne(doc, { session });
      return { order: doc, payment: created };
    });
    if (!payment) {
      await this.tellBusiness(order);
      return { order, payment: null };
    }
    return { order, payment: await this.payments.openCheckout(payment, baseUrl) };
  }

  readonly orderPayment: PurposeHandler = {
    onSucceeded: async (payment, session) => {
      const now = this.clock.now();
      const o = await this.orders.findOneAndUpdate(
        { _id: payment.purposeRef, status: 'pending_payment', paymentId: payment._id },
        { $set: { status: 'placed', updatedAt: now }, $push: { history: { status: 'placed', at: now, by: null } } },
        { session, returnDocument: 'after' },
      );
      if (!o) {
        const cur = await this.orders.findOne({ _id: payment.purposeRef }, { session });
        return cur && cur.paymentId?.equals(payment._id) && cur.status !== 'expired' && cur.status !== 'cancelled' ? 'fulfilled' : 'unfulfillable';
      }
      afterCommit(session, () => this.tellBusiness(o));
      return 'fulfilled';
    },
    onClosed: async (payment, session) => {
      const o = await this.orders.findOneAndUpdate(
        { _id: payment.purposeRef, status: 'pending_payment', paymentId: payment._id },
        { $set: { status: 'expired', updatedAt: this.clock.now() }, $push: { history: { status: 'expired', at: this.clock.now(), by: null } } },
        { session, returnDocument: 'after' },
      );
      if (o) await this.giveBackStock(o, session);
    },
  };

  private async giveBackStock(o: OrderDoc, session: ClientSession) {
    for (const l of o.lines) await this.items.updateOne({ _id: l.itemId, stock: { $ne: null } }, { $inc: { stock: l.qty } }, { session });
  }

  /** A new order: every member of the team (owner, managers, staff) gets the push, with the sound. */
  private async tellBusiness(o: OrderDoc) {
    const team = await this.teamOf(o);
    const what = o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ');
    await this.notifications.notify(
      team.map((m) => m.userId),
      {
        type: 'commerce.order_placed', category: 'paiements', icon: 'receipt-outline', tone: 'success', url: BUSINESS_ORDER_URL(o._id), dedupeKey: `order:${o._id.toHexString()}:placed`, channel: 'orders',
        title: `Nouvelle commande ${o.code} · ${fcfa(o.total)}`,
        body: `${what}. ${o.mode === 'delivery' ? `Livraison : ${o.address}` : 'À emporter'}.${o.method === 'cash' ? ` À encaisser en espèces : ${fcfa(o.total)}.` : ''}`,
      },
    );
  }

  private async tellStudent(o: OrderDoc, b: Pick<BusinessDoc, 'name'>) {
    const msg: Partial<Record<OrderStatus, { title: string; body: string; tone: 'success' | 'primary' | 'danger' }>> = {
      accepted: { title: `${b.name} prépare ta commande`, body: `Commande ${o.code} acceptée.`, tone: 'primary' },
      ready:
        o.mode === 'delivery'
          ? { title: `Ta commande arrive`, body: `${b.name} : ta commande ${o.code} est en route.`, tone: 'success' }
          : { title: `Ta commande est prête`, body: `Passe la chercher chez ${b.name} avec le code ${o.code}.`, tone: 'success' },
      completed:
        o.mode === 'delivery'
          ? { title: 'Commande livrée', body: `${b.name} : ta commande ${o.code} t’a été livrée. Bon appétit ! Une note pour ${b.name} ? (facultatif)`, tone: 'success' }
          : { title: 'Commande récupérée', body: `${b.name} : ta commande ${o.code} t’a été remise. Une note pour ${b.name} ? (facultatif)`, tone: 'success' },
      refused: { title: `Commande refusée · ${b.name}`, body: `${o.refusal ?? 'Le commerce ne peut pas la servir.'} Tu es remboursé (${fcfa(o.total)}).`, tone: 'danger' },
    };
    const m = msg[o.status];
    if (!m) return;
    await this.notifications.notify([o.userId], {
      type: `commerce.order_${o.status}`, category: 'paiements', icon: o.status === 'refused' ? 'close-circle-outline' : 'bag-check-outline', tone: m.tone,
      url: MY_ORDER_URL(o._id), dedupeKey: `order:${o._id.toHexString()}:${o.status}`, title: m.title, body: m.body,
    });
  }

  /** Who works in the order's business (its restaurant or shop space): they get its notifications. */
  private async teamOf(o: Pick<OrderDoc, 'orgId' | 'businessId'>) {
    const b = await this.businesses.findOne({ _id: o.businessId }, { projection: { kind: 1 } });
    if (!b) return [];
    return (await this.organizations.members(o.orgId, b.kind)).filter((m) => m.roles.some((r) => r === 'owner' || r === 'manager' || r === 'staff'));
  }

  /** Before the business accepts it: refunded in full. The team hears it (no need to prepare it any more). */
  async cancel(userId: ObjectId, orderId: ObjectId) {
    const o = await this.closeWithRefund({ _id: orderId, userId }, 'cancelled', userId, null);
    const team = await this.teamOf(o);
    await this.notifications.notify(
      team.map((m) => m.userId),
      {
        type: 'commerce.order_cancelled', category: 'paiements', icon: 'close-circle-outline', tone: 'danger', url: BUSINESS_ORDER_URL(o._id), dedupeKey: `order:${o._id.toHexString()}:cancelled`,
        title: `Commande ${o.code} annulée`, body: o.method === 'cash' ? 'Le client a annulé avant que tu l’acceptes : rien à préparer.' : 'Le client a annulé avant que tu l’acceptes. Il est remboursé : rien à préparer.',
      },
    );
    return o;
  }

  private async closeWithRefund(filter: { _id: ObjectId; userId?: ObjectId; businessId?: ObjectId }, to: 'cancelled' | 'refused', by: ObjectId, reason: string | null) {
    const payoutIds: ObjectId[] = [];
    let order!: OrderDoc;
    await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const o = await this.orders.findOneAndUpdate(
        { ...filter, status: 'placed' },
        { $set: { status: to, refusal: reason, updatedAt: now }, $push: { history: { status: to, at: now, by } } },
        { session, returnDocument: 'after' },
      );
      if (!o) {
        const cur = await this.orders.findOne(filter, { session });
        if (!cur) throw errors.notFound('Commande introuvable.');
        throw errors.conflict('ORDER_ALREADY_TAKEN', to === 'cancelled' ? 'Le commerce a déjà pris ta commande en charge : contacte-le.' : 'Cette commande n’attend plus de réponse.');
      }
      await this.giveBackStock(o, session);
      // Paid in cash (not yet, the order isn't served): nothing to refund.
      if (o.method === 'cash') {
        order = o;
        return;
      }
      const payout = await this.payments.createPayout(
        { kind: 'refund', beneficiaryUserId: o.userId, method: o.method as PaymentMethod, amount: o.total, reason: to === 'refused' ? 'order_refused' : 'order_cancelled', source: { type: 'order', id: o._id }, idempotencyKey: `order:${o._id.toHexString()}:refund` },
        session,
      );
      payoutIds.push(payout._id);
      await this.orders.updateOne({ _id: o._id }, { $set: { refundPayoutId: payout._id } }, { session });
      order = { ...o, refundPayoutId: payout._id };
    });
    await this.payments.schedulePayouts(payoutIds);
    return order;
  }

  async mine(userId: ObjectId) {
    const docs = await this.orders.find({ userId, status: { $ne: 'expired' } }).sort({ createdAt: -1 }).limit(50).toArray();
    return this.orderViews(docs, false);
  }

  async mineOne(userId: ObjectId, id: ObjectId) {
    const o = await this.orders.findOne({ _id: id, userId });
    if (!o) throw errors.notFound('Commande introuvable.');
    return (await this.orderViews([o], false))[0]!;
  }

  // ---- The business: incoming orders ------------------------------------------------------------------------------

  /** Active orders first (to serve), then the day's finished ones. */
  async queue(ref: BusinessRef, scope: 'active' | 'done') {
    const b = await this.ofOrg(ref);
    const since = new Date(this.clock.now().getTime() - 48 * HOUR);
    const docs = await this.orders
      .find(scope === 'active' ? { businessId: b._id, status: { $in: ['placed', 'accepted', 'ready'] } } : { businessId: b._id, status: { $in: ['completed', 'refused', 'cancelled'] }, updatedAt: { $gt: since } })
      .sort({ createdAt: scope === 'active' ? 1 : -1 })
      .limit(200)
      .toArray();
    return this.orderViews(docs, true);
  }

  /**
   * « Mes ventes » from `from` to `to` (days, both included, Dakar time, which is UTC all year). Sales are completed
   * orders, counted on the day they were placed: their total (delivery included), by payment method, day by day, the
   * best sellers, and what Wave / Orange Money still owe (payouts not yet received). Orders still being served and
   * refused or cancelled ones are counted apart, never in the money.
   */
  async sales(ref: BusinessRef, from: string, to: string) {
    const b = await this.ofOrg(ref);
    const start = new Date(`${from}T00:00:00.000Z`);
    const last = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(last.getTime()) || last < start) throw errors.validation('Période invalide.', { field: 'from' });
    const days = Math.round((last.getTime() - start.getTime()) / DAY) + 1;
    if (days > SALES_MAX_DAYS) throw errors.validation(`${SALES_MAX_DAYS} jours au plus à la fois.`, { field: 'to' });
    const end = new Date(last.getTime() + DAY);
    const done = { $match: { status: 'completed' } };
    type Facets = {
      total: { revenue: number; orders: number }[];
      methods: { _id: OrderPaymentMethod; amount: number; orders: number }[];
      byDay: { _id: string; revenue: number; orders: number }[];
      top: { _id: ObjectId; name: string; qty: number; revenue: number }[];
      statuses: { _id: OrderStatus; n: number }[];
      owed: { amount: number }[];
    };
    const [f] = await this.orders
      .aggregate<Facets>([
        { $match: { businessId: b._id, createdAt: { $gte: start, $lt: end }, status: { $nin: ['pending_payment', 'expired'] } } },
        {
          $facet: {
            total: [done, { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } }],
            methods: [done, { $group: { _id: '$method', amount: { $sum: '$total' }, orders: { $sum: 1 } } }],
            byDay: [done, { $group: { _id: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: 'Africa/Dakar' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } }],
            top: [
              done,
              { $unwind: '$lines' },
              { $group: { _id: '$lines.itemId', name: { $last: '$lines.name' }, qty: { $sum: '$lines.qty' }, revenue: { $sum: { $multiply: ['$lines.qty', '$lines.price'] } } } },
              { $sort: { qty: -1, revenue: -1 } },
              { $limit: SALES_TOP_ITEMS },
            ],
            statuses: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
            owed: [
              { $match: { status: 'completed', method: { $ne: 'cash' }, payoutId: { $ne: null } } },
              { $lookup: { from: 'payouts', localField: 'payoutId', foreignField: '_id', as: 'payout' } },
              { $unwind: '$payout' },
              { $match: { 'payout.status': { $ne: 'succeeded' } } },
              { $group: { _id: null, amount: { $sum: '$payout.amount' } } },
            ],
          },
        },
      ])
      .toArray();
    const count = (st: OrderStatus[]) => f!.statuses.filter((x) => st.includes(x._id)).reduce((n, x) => n + x.n, 0);
    const revenue = f!.total[0]?.revenue ?? 0;
    const orders = f!.total[0]?.orders ?? 0;
    const perDay = new Map(f!.byDay.map((d) => [d._id, d]));
    return {
      from,
      to,
      revenue,
      orders,
      average: orders ? Math.round(revenue / orders) : 0,
      methods: ORDER_PAYMENT_METHODS.map((m) => {
        const x = f!.methods.find((y) => y._id === m);
        return { method: m, label: ORDER_PAYMENT_LABELS[m], amount: x?.amount ?? 0, orders: x?.orders ?? 0 };
      }).filter((m) => m.orders > 0),
      owed: f!.owed[0]?.amount ?? 0,
      days: Array.from({ length: days }, (_, i) => {
        const date = new Date(start.getTime() + i * DAY).toISOString().slice(0, 10);
        return { date, revenue: perDay.get(date)?.revenue ?? 0, orders: perDay.get(date)?.orders ?? 0 };
      }),
      top: f!.top.map((t) => ({ itemId: t._id.toHexString(), name: t.name, qty: t.qty, revenue: t.revenue })),
      inProgress: count(['placed', 'accepted', 'ready']),
      refused: count(['refused']),
      cancelled: count(['cancelled']),
    };
  }

  async businessOrder(ref: BusinessRef, id: ObjectId) {
    const b = await this.ofOrg(ref);
    const o = await this.orders.findOne({ _id: id, businessId: b._id, status: { $ne: 'pending_payment' } });
    if (!o) throw errors.notFound('Commande introuvable.');
    return (await this.orderViews([o], true))[0]!;
  }

  /** accepted → ready → completed, one step at a time. Completed: the amount goes to the business's number. */
  async advance(ref: BusinessRef, id: ObjectId, by: ObjectId, to: 'accepted' | 'ready' | 'completed') {
    const { _id: businessId } = await this.ofOrg(ref);
    const from = (Object.keys(NEXT) as OrderStatus[]).find((k) => NEXT[k] === to)!;
    const now = this.clock.now();
    const o = await this.orders.findOneAndUpdate(
      { _id: id, businessId, status: from },
      { $set: { status: to, updatedAt: now }, $push: { history: { status: to, at: now, by } } },
      { returnDocument: 'after' },
    );
    if (!o) {
      if (!(await this.orders.findOne({ _id: id, businessId }))) throw errors.notFound('Commande introuvable.');
      throw errors.conflict('ORDER_STEP', 'Cette commande a déjà changé : recharge la liste.');
    }
    const b = await this.businesses.findOne({ _id: o.businessId });
    if (to === 'completed') await this.payOut(o, by);
    await this.tellStudent(o, b!);
    return o;
  }

  /**
   * At the counter: the student gives their order's code (typed, or its QR scanned, "UGBCMD:C7KQ2M"). An order being
   * prepared or ready is handed over (completed, paid out); anything else says why not.
   */
  async handover(ref: BusinessRef, rawCode: string, by: ObjectId) {
    const { _id: businessId } = await this.ofOrg(ref);
    const code = rawCode.trim().toUpperCase().replace(/^UGBCMD:/, '').replace(/\s/g, '');
    const o = await this.orders.findOne({ businessId, code, status: { $ne: 'pending_payment' } });
    if (!o) throw errors.notFound(`Aucune commande ${code} chez toi.`);
    if (o.status === 'completed') throw errors.conflict('ORDER_ALREADY_DONE', `La commande ${code} a déjà été remise.`);
    if (o.status === 'placed') throw errors.conflict('ORDER_NOT_ACCEPTED', `Accepte d’abord la commande ${code}.`);
    if (o.status !== 'accepted' && o.status !== 'ready') throw errors.conflict('ORDER_CLOSED', `La commande ${code} a été ${o.status === 'refused' ? 'refusée' : 'annulée'}.`);
    const now = this.clock.now();
    const done = await this.orders.findOneAndUpdate(
      { _id: o._id, status: o.status },
      { $set: { status: 'completed', updatedAt: now }, $push: { history: { status: 'completed', at: now, by } } },
      { returnDocument: 'after' },
    );
    if (!done) throw errors.conflict('ORDER_STEP', 'Cette commande a déjà changé : réessaie.');
    await this.payOut(done, by);
    const b = await this.businesses.findOne({ _id: done.businessId });
    await this.tellStudent(done, b!);
    return done;
  }

  async refuse(ref: BusinessRef, id: ObjectId, by: ObjectId, reason: string) {
    const { _id: businessId } = await this.ofOrg(ref);
    const o = await this.closeWithRefund({ _id: id, businessId }, 'refused', by, reason);
    const b = await this.businesses.findOne({ _id: o.businessId });
    await this.tellStudent(o, b!);
    return o;
  }

  /** The order's amount to the organization's payout number, once. */
  private async payOut(o: OrderDoc, by: ObjectId | null) {
    // Cash: the business was paid by hand.
    if (o.method === 'cash') return;
    const phone = await this.organizations.payoutPhone(o.orgId, o.method);
    if (!phone) return;
    const owner = by ?? (await this.teamOf(o)).find((m) => m.roles.includes('owner'))?.userId;
    if (!owner) return;
    const payoutIds: ObjectId[] = [];
    await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const payout = await this.payments.createPayout(
        { kind: 'organizer_claim', beneficiaryUserId: owner, payTo: { orgId: o.orgId, phone }, method: o.method as PaymentMethod, amount: o.total, reason: 'order_payout', source: { type: 'order', id: o._id }, idempotencyKey: `order:${o._id.toHexString()}:payout` },
        session,
      );
      payoutIds.push(payout._id);
      await this.orders.updateOne({ _id: o._id }, { $set: { payoutId: payout._id } }, { session });
    });
    await this.payments.schedulePayouts(payoutIds);
  }

  /** Worker: orders left accepted or ready for 12 h are completed (served), and paid out. */
  async sweep() {
    const old = await this.orders.find({ status: { $in: ['accepted', 'ready'] }, updatedAt: { $lt: new Date(this.clock.now().getTime() - ORDER_AUTO_COMPLETE_H * HOUR) } }).limit(100).toArray();
    for (const o of old) {
      const now = this.clock.now();
      const done = await this.orders.findOneAndUpdate({ _id: o._id, status: o.status }, { $set: { status: 'completed', updatedAt: now }, $push: { history: { status: 'completed', at: now, by: null } } }, { returnDocument: 'after' });
      if (done) await this.payOut(done, null);
    }
    return old.length;
  }

  private async orderViews(docs: OrderDoc[], forBusiness: boolean) {
    if (!docs.length) return [];
    const businesses = await this.businesses.find({ _id: { $in: [...new Map(docs.map((d) => [d.businessId.toHexString(), d.businessId])).values()] } }).toArray();
    const customers = forBusiness ? await this.accounts.contactsByIds([...new Map(docs.map((d) => [d.userId.toHexString(), d.userId])).values()]) : new Map();
    // Each line with its item's current picture (null once the item has none, or was deleted).
    const itemIds = [...new Map(docs.flatMap((d) => d.lines.map((l) => [l.itemId.toHexString(), l.itemId] as const))).values()];
    const photos = new Map((await this.items.find({ _id: { $in: itemIds } }, { projection: { photos: 1 } }).toArray()).map((i) => [i._id.toHexString(), i.photos?.[0]?.url ?? null]));
    return Promise.all(
      docs.map(async (o) => {
        const b = businesses.find((x) => x._id.equals(o.businessId))!;
        const payment = !forBusiness && o.status === 'pending_payment' && o.paymentId ? await this.payments.findById(o.paymentId) : null;
        const c = customers.get(o.userId.toHexString());
        return {
          id: o._id.toHexString(),
          code: o.code,
          status: o.status,
          business: { id: b._id.toHexString(), kind: b.kind, name: b.name, phone: b.phone, photo: b.photo?.url ?? null, address: b.address },
          lines: o.lines.map((l) => ({ itemId: l.itemId.toHexString(), name: l.name, price: l.price, qty: l.qty, photo: photos.get(l.itemId.toHexString()) ?? null })),
          subtotal: o.subtotal,
          deliveryFee: o.deliveryFee,
          zone: o.zone ?? null,
          zoneLabel: o.zone ? DELIVERY_ZONE_LABELS[o.zone] : null,
          total: o.total,
          mode: o.mode,
          address: o.address,
          note: o.note,
          refusal: o.refusal,
          refunded: !!o.refundPayoutId,
          method: o.method,
          methodLabel: ORDER_PAYMENT_LABELS[o.method],
          history: o.history.map((h) => ({ status: h.status, at: h.at.toISOString() })),
          createdAt: o.createdAt.toISOString(),
          payment: payment && (payment.status === 'created' || payment.status === 'pending') ? { reference: payment.reference, checkoutUrl: payment.checkoutUrl } : null,
          // The business calls or meets the student: their name and number.
          customer: forBusiness && c ? { name: `${c.firstName} ${c.lastName}`, phone: localPhone(c.phone) } : null,
        };
      }),
    );
  }
}
