import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { afterCommit, withTransaction } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import type { ImageRef } from '../../platform/media.js';
import { randomCode } from '../../platform/security/crypto.js';
import type { Limiter } from '../../platform/security/limiter.js';
import { CAMPUSES, REGIONS, UFR_CODES, VILLAGES, type AccountsApi, type AudienceProfile, type Campus, type Region, type UfrCode } from '../accounts/index.js';
import type { MediaApi } from '../media/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrgCard, OrganizationsApi, OrgRole } from '../organizations/index.js';
import { PAYMENT_METHODS, type PaymentMethod, type PaymentsApi, type PayoutDoc, type PurposeHandler } from '../payments/index.js';
import type { EventSummary, TicketingApi, TicketKindHandler } from '../ticketing/index.js';
import { TICKET_PAYMENT_LABELS, type TicketPaymentMethod } from '../ticketing/index.js';
import {
  CATEGORY_LABELS,
  ENTRY_GRACE_MS,
  ENTRY_OPENS_MS,
  FREE_CANCEL_MS,
  HOLD_MIN,
  LATE_CANCEL_FEE,
  PUBLICATION_FEE,
  publicationFee,
  type BookingUnit,
  type EventBookingDoc,
  type EventCategory,
  type EventAudience,
  type EventDoc,
} from './events.types.js';

const MIN = 60_000;
/** Everyone on an organizer space's team: none of them books its events. */
const ORGANIZER_TEAM: OrgRole[] = ['owner', 'manager', 'scanner', 'staff'];
const dakar = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Dakar', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fcfa = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;

const EVERYONE: EventAudience = { campuses: [], ufrs: [], regions: [], villages: [] };
const ALL_VILLAGES = [...VILLAGES.campus1, ...VILLAGES.campus2];
/** Time to pay the publication. */
const PAY_WITHIN_MIN = 15;

/**
 * Is the event for this viewer? Each non-empty list must contain theirs (as announcements). Accounts without a
 * student profile see whole-university events only.
 */
export function isForViewer(a: EventAudience, p: AudienceProfile) {
  if (!a.campuses.length && !a.ufrs.length && !a.regions.length && !a.villages.length) return true;
  if (!p) return false;
  return (
    (!a.campuses.length || a.campuses.includes(p.campus)) &&
    (!a.ufrs.length || (!!p.ufr && a.ufrs.includes(p.ufr))) &&
    (!a.regions.length || (!!p.region && a.regions.includes(p.region))) &&
    (!a.villages.length || (!!p.village && a.villages.includes(p.village)))
  );
}

/** What the owner sets when publishing an approved event: who sees it, the places on sale, a few details. */
export type PublicationInput = {
  audience: { campuses: string[]; ufrs: string[]; regions: string[]; villages: string[] };
  places: { typeId: string; capacity: number }[];
  description?: string;
  imageIds?: string[];
  fixedCover?: boolean;
  address?: string | null;
  maxPerStudent?: number;
  method: PaymentMethod;
  returnUrl?: string | null;
};

export type EventInput = {
  title: string;
  category: EventCategory;
  description: string;
  imageIds: string[];
  fixedCover?: boolean;
  venue: { name: string; address?: string | null };
  startsAt: string;
  endsAt: string;
  salesCloseAt?: string;
  ticketTypes: { name: string; description?: string | null; price: number; capacity: number }[];
  maxPerStudent?: number;
  /** Default: Wave and Orange Money. */
  paymentMethods?: TicketPaymentMethod[];
};

/**
 * What students see of an event's organizer: an entity (association, company) by its name; a person organizing on
 * their own (their personal entity is named after them) without a name: no owner's name on the event page.
 */
const shownOrganizer = (o: OrgCard): OrgCard => (o.category === 'Étudiant' ? { ...o, name: '' } : o);

export class EventsService {
  private readonly events: Collection<EventDoc>;
  private readonly bookings: Collection<EventBookingDoc>;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
    private readonly organizations: OrganizationsApi,
    private readonly payments: PaymentsApi,
    private readonly ticketing: TicketingApi,
    private readonly media: MediaApi,
    private readonly limiter: Limiter,
    private readonly notifications: NotificationsApi,
  ) {
    this.events = db.collection('events');
    this.bookings = db.collection('eventBookings');
  }

  // ---- Students -------------------------------------------------------------------------------------------------

  /** Published events not over yet, for this student (UFR, campus, village, region), soonest first. */
  async list(viewerId: ObjectId) {
    const now = this.clock.now();
    const [docs, profile] = await Promise.all([
      this.events.find({ status: 'published', endsAt: { $gt: now } }).sort({ startsAt: 1 }).limit(200).toArray(),
      this.accounts.audienceOf(viewerId),
    ]);
    return this.views(docs.filter((e) => isForViewer(e.audience ?? EVERYONE, profile)), viewerId);
  }

  /** What students can open: published (or cancelled, completed) events, never one being prepared or reviewed. */
  async get(id: ObjectId) {
    const e = await this.events.findOne({ _id: id, status: { $in: ['published', 'cancelled', 'completed'] } });
    if (!e) throw errors.notFound('Événement introuvable.');
    return e;
  }

  async views(docs: EventDoc[], viewerId: ObjectId) {
    if (!docs.length) return [];
    const cards = await this.organizations.cards([...new Map(docs.map((d) => [d.orgId.toHexString(), d.orgId])).values()]);
    const mine = await this.bookings.find({ eventId: { $in: docs.map((d) => d._id) }, userId: viewerId, status: { $in: ['held', 'confirmed'] } }).toArray();
    const orgIds = [...new Map(docs.map((d) => [d.orgId.toHexString(), d.orgId])).values()];
    const organized = new Set((await Promise.all(orgIds.map(async (o) => ((await this.organizes(o, viewerId)) ? o.toHexString() : null)))).filter(Boolean));
    const now = this.clock.now();
    return Promise.all(
      docs.map(async (e) => {
        const my = mine.filter((b) => b.eventId.equals(e._id));
        const held = my.find((b) => b.status === 'held');
        const payment = held?.paymentId ? await this.payments.findById(held.paymentId) : null;
        const bought = my.reduce((n, b) => n + b.units.filter((u) => u.status === 'confirmed' || u.status === 'held').length, 0);
        return {
          ...this.publicView(e, shownOrganizer(cards.get(e.orgId.toHexString())!), now),
          myTickets: my.filter((b) => b.status === 'confirmed').flatMap((b) => b.units.filter((u) => u.status === 'confirmed' && u.ticketId).map((u) => u.ticketId!.toHexString())),
          myTicketsLeft: Math.max(0, e.maxPerStudent - bought),
          organizedByMe: organized.has(e.orgId.toHexString()),
          myBooking: held
            ? { id: held._id.toHexString(), total: held.total, holdExpiresAt: held.holdExpiresAt.toISOString(), payment: payment ? { reference: payment.reference, checkoutUrl: payment.checkoutUrl } : null }
            : null,
        };
      }),
    );
  }

  /** On the event's organizing team (its organizer space, any role): they run it, they don't buy tickets for it. */
  private async organizes(orgId: ObjectId, userId: ObjectId) {
    return !!(await this.organizations.roleIn(orgId, userId, ORGANIZER_TEAM, 'organizer'));
  }

  private publicView(e: EventDoc, organizer: OrgCard, now: Date) {
    const prices = e.ticketTypes.map((t) => t.price);
    return {
      id: e._id.toHexString(),
      code: e.code,
      status: e.status,
      organizer,
      title: e.title,
      category: e.category,
      categoryLabel: CATEGORY_LABELS[e.category],
      description: e.description,
      images: e.images.map((i) => i.url),
      venue: e.venue,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      salesCloseAt: e.salesCloseAt.toISOString(),
      salesOpen: e.status === 'published' && now < e.salesCloseAt && e.ticketTypes.some((t) => t.remaining > 0),
      minPrice: Math.min(...prices),
      maxPerStudent: e.maxPerStudent,
      paymentMethods: e.paymentMethods ?? [...PAYMENT_METHODS],
      ticketTypes: e.ticketTypes.map((t) => ({ typeId: t.typeId, name: t.name, description: t.description, price: t.price, remaining: t.remaining, soldOut: t.remaining === 0 })),
      cancellation: e.cancellation ? { at: e.cancellation.at.toISOString(), reason: e.cancellation.reason } : null,
      review: e.review ? { message: e.review.message, at: e.review.at.toISOString() } : null,
    };
  }

  /**
   * Holds the tickets for 10 minutes and opens one payment (none for a free event: the tickets are issued at once).
   * Places are taken with a conditional update per ticket type: two students can never take the last place twice.
   * Its organizing team orders only `forFriends`: every ticket is then one to give, none is theirs.
   */
  async book(userId: ObjectId, eventId: ObjectId, input: { items: { typeId: string; qty: number }[]; method: TicketPaymentMethod; forFriends?: boolean; returnUrl?: string | null }, baseUrl: string) {
    await this.limiter.hit(`event-book:${userId.toHexString()}`, { limit: 20, windowS: 3600 });
    // Cash: nothing to pay here, the tickets are issued at once and paid at the door.
    const cash = input.method === 'cash';
    if (!cash) this.payments.assertAvailable(input.method as PaymentMethod);
    const returnUrl = this.payments.validateReturnUrl(input.returnUrl);
    const e = await this.get(eventId);
    const now = this.clock.now();
    if (e.status !== 'published' || now >= e.salesCloseAt) throw errors.conflict('SALES_CLOSED', 'La billetterie est fermée pour cet événement.');
    const organizer = await this.organizes(e.orgId, userId);
    if (organizer && !input.forFriends) throw errors.rule('OWN_EVENT', 'C’est ton événement : tu peux seulement commander des billets pour tes amis.');
    const forFriends = organizer;

    const held = await this.bookings.findOne({ eventId, userId, status: 'held' });
    if (held?.paymentId) {
      const payment = await this.payments.findById(held.paymentId);
      if (payment && (payment.status === 'created' || payment.status === 'pending')) return { booking: held, payment: await this.payments.openCheckout(payment, baseUrl), replay: true };
    }

    const items = input.items.filter((i) => i.qty > 0);
    const qty = items.reduce((n, i) => n + i.qty, 0);
    if (!qty) throw errors.validation('Choisis au moins un billet.', { field: 'items' });
    if (new Set(items.map((i) => i.typeId)).size !== items.length) throw errors.validation('Un type de billet est en double.', { field: 'items' });
    const already = (await this.bookings.find({ eventId, userId, status: { $in: ['held', 'confirmed'] } }).toArray()).reduce((n, b) => n + b.units.filter((u) => u.status !== 'cancelled' && u.status !== 'expired').length, 0);
    if (already + qty > e.maxPerStudent) {
      throw errors.conflict('TICKET_LIMIT', `${e.maxPerStudent} billet${e.maxPerStudent > 1 ? 's' : ''} maximum par étudiant pour cet événement${already ? ` : tu en as déjà ${already}` : ''}.`);
    }
    const units: BookingUnit[] = items.flatMap((i) => {
      const t = e.ticketTypes.find((x) => x.typeId === i.typeId);
      if (!t) throw errors.validation('Type de billet inconnu.', { field: 'items' });
      return Array.from({ length: i.qty }, () => ({ unitId: new ObjectId(), typeId: t.typeId, name: t.name, price: t.price, status: 'held' as const, ticketId: null }));
    });
    const total = units.reduce((n, u) => n + u.price, 0);
    // A paid event takes only what its organizer accepts (a free one has nothing to pay).
    if (total > 0 && !(e.paymentMethods ?? [...PAYMENT_METHODS]).includes(input.method)) {
      throw errors.validation(`Cet événement n’accepte pas ${TICKET_PAYMENT_LABELS[input.method]}.`, { field: 'method' });
    }
    const holdExpiresAt = new Date(Math.min(now.getTime() + HOLD_MIN * MIN, e.salesCloseAt.getTime()));

    const created = await withTransaction(this.mongo, async (session) => {
      for (const i of items) {
        const taken = await this.events.updateOne(
          { _id: eventId, status: 'published', ticketTypes: { $elemMatch: { typeId: i.typeId, remaining: { $gte: i.qty } } } },
          { $inc: { 'ticketTypes.$.remaining': -i.qty }, $set: { updatedAt: now } },
          { session },
        );
        if (!taken.modifiedCount) {
          const name = e.ticketTypes.find((t) => t.typeId === i.typeId)!.name;
          throw errors.conflict('SOLD_OUT', `Plus assez de billets « ${name} ». Choisis une autre quantité ou un autre type.`);
        }
      }
      const bookingId = new ObjectId();
      const payment = total > 0 && !cash
        ? await this.payments.create(
            { userId, purpose: 'event_booking', purposeRef: bookingId, amount: total, method: input.method as PaymentMethod, description: `${e.title} · ${units.length} billet${units.length > 1 ? 's' : ''}`, expiresAt: holdExpiresAt, returnUrl },
            session,
          )
        : null;
      const booking: EventBookingDoc = {
        _id: bookingId, eventId, userId, units, total, method: input.method, status: 'held', holdExpiresAt, paymentId: payment?._id ?? null,
        ...(forFriends ? { forFriends: true } : {}), createdAt: now, updatedAt: now,
      };
      await this.bookings.insertOne(booking, { session });
      // Free, or cash at the door: nothing to pay here, the tickets are issued now.
      if (!payment) await this.confirm(booking, total > 0 ? input.method : cash ? 'wave' : input.method, session);
      return { booking, payment };
    });
    return { booking: created.booking, payment: created.payment ? await this.payments.openCheckout(created.payment, baseUrl) : null, replay: false };
  }

  async booking(userId: ObjectId, bookingId: ObjectId) {
    const b = await this.bookings.findOne({ _id: bookingId, userId });
    if (!b) throw errors.notFound('Réservation introuvable.');
    const payment = b.paymentId ? await this.payments.findById(b.paymentId) : null;
    return {
      id: b._id.toHexString(),
      eventId: b.eventId.toHexString(),
      status: b.status,
      total: b.total,
      holdExpiresAt: b.holdExpiresAt.toISOString(),
      tickets: b.units.map((u) => ({ typeId: u.typeId, name: u.name, price: u.price, status: u.status, ticketId: u.ticketId?.toHexString() ?? null })),
      payment: payment ? { reference: payment.reference, status: payment.status, checkoutUrl: payment.checkoutUrl } : null,
    };
  }

  /** "Retour" while paying: the places go back at once. */
  async release(userId: ObjectId, bookingId: ObjectId) {
    await withTransaction(this.mongo, async (session) => {
      const b = await this.bookings.findOneAndUpdate(
        { _id: bookingId, userId, status: 'held' },
        { $set: { status: 'cancelled', 'units.$[].status': 'cancelled', updatedAt: this.clock.now() } },
        { session },
      );
      if (!b) throw errors.notFound('Réservation introuvable ou déjà payée.');
      await this.giveBack(b, session);
      if (b.paymentId) await this.payments.cancelInSession(b.paymentId, session);
    });
  }

  private async giveBack(b: EventBookingDoc, session: ClientSession) {
    const per = new Map<string, number>();
    for (const u of b.units) per.set(u.typeId, (per.get(u.typeId) ?? 0) + 1);
    for (const [typeId, n] of per) {
      await this.events.updateOne({ _id: b.eventId }, { $inc: { 'ticketTypes.$[t].remaining': n }, $set: { updatedAt: this.clock.now() } }, { arrayFilters: [{ 't.typeId': typeId }], session });
    }
  }

  readonly bookingPayment: PurposeHandler = {
    onSucceeded: async (payment, session) => {
      const b = await this.bookings.findOne({ _id: payment.purposeRef }, { session });
      if (!b || !b.paymentId?.equals(payment._id)) return 'unfulfillable';
      if (b.status === 'confirmed') return 'fulfilled';
      if (b.status !== 'held') return 'unfulfillable';
      return this.confirm(b, payment.method, session);
    },
    onClosed: async (payment, session) => {
      const b = await this.bookings.findOneAndUpdate(
        { _id: payment.purposeRef, status: 'held', paymentId: payment._id },
        { $set: { status: 'expired', 'units.$[].status': 'expired', updatedAt: this.clock.now() } },
        { session },
      );
      if (b) await this.giveBack(b, session);
    },
  };

  /**
   * One ticket per unit. The student travels on the first one unless they already hold one for this event; the
   * others are theirs to give to friends (the transfer makes them the friend's). Ordered for friends (its organizer):
   * all of them are to give.
   */
  private async confirm(b: EventBookingDoc, method: TicketPaymentMethod, session: ClientSession): Promise<'fulfilled' | 'unfulfillable'> {
    const e = (await this.events.findOne({ _id: b.eventId }, { session }))!;
    if (e.status !== 'published') return 'unfulfillable';
    let holderTravels = !b.forFriends && !(await this.ticketing.hasActiveTicket(e._id, b.userId, session));
    const now = this.clock.now();
    const units: BookingUnit[] = [];
    for (const u of b.units) {
      const t = await this.ticketing.issue(
        {
          kind: 'event_entry', eventId: e._id, orgId: e.orgId, purchaserUserId: b.userId, source: { type: 'event_booking', id: u.unitId },
          price: u.price, paidWith: method, seat: null, details: { typeId: u.typeId, typeName: u.name }, passenger: null, holderTravels,
        },
        session,
      );
      holderTravels = false;
      units.push({ ...u, status: 'confirmed', ticketId: t._id });
    }
    await this.bookings.updateOne({ _id: b._id, status: 'held' }, { $set: { status: 'confirmed', units, updatedAt: now } }, { session });
    afterCommit(session, async () => {
      await this.notifications.notify([b.userId], {
        type: 'event.tickets', category: 'paiements', icon: 'ticket-outline', tone: 'success', url: `/billet/${units[0]!.ticketId!.toHexString()}`,
        dedupeKey: `event-booking:${b._id.toHexString()}:confirmed`,
        title: `${units.length > 1 ? `${units.length} billets` : 'Billet'} · ${e.title}`,
        body: `${dakar.format(e.startsAt)} · ${e.venue.name}. Ton QR code est dans l’app.`,
      });
    });
    return 'fulfilled';
  }

  // ---- The rules of an event ticket (ticketing calls these) ----------------------------------------------------

  readonly ticketKind: TicketKindHandler & { labels: { admitted: string; duplicate: string } } = {
    labels: { admitted: 'entré', duplicate: 'Déjà entré' },

    present: async (tickets) => {
      const ids = [...new Map(tickets.map((t) => [t.eventId.toHexString(), t.eventId])).values()];
      const evs = await this.events.find({ _id: { $in: ids } }).toArray();
      const cards = await this.organizations.cards([...new Map(evs.map((e) => [e.orgId.toHexString(), e.orgId])).values()]);
      const out = new Map<string, { event: EventSummary; details: Record<string, unknown> }>();
      for (const t of tickets) {
        const e = evs.find((x) => x._id.equals(t.eventId))!;
        const org = cards.get(e.orgId.toHexString())!;
        out.set(t._id.toHexString(), {
          event: {
            id: e._id.toHexString(), kind: 'event_entry', title: e.title, startsAt: e.startsAt.toISOString(), status: e.status,
            organizer: { id: org.id, name: org.name, category: org.category, level: org.level, rating: org.rating, trips: org.trips },
          },
          details: {
            eventId: e._id.toHexString(), category: e.category, categoryLabel: CATEGORY_LABELS[e.category], venue: e.venue, startsAt: e.startsAt.toISOString(),
            endsAt: e.endsAt.toISOString(), typeName: String(t.details.typeName), image: e.images[0]?.url ?? null,
          },
        });
      }
      return out;
    },

    cancellationQuote: async (t, now) => {
      const e = await this.events.findOne({ _id: t.eventId });
      if (!e || e.status === 'cancelled') return { allowed: false, reason: 'L’événement est annulé : tu es remboursé automatiquement.' };
      if (t.admittedAt) return { allowed: false, reason: 'Ce billet a déjà été scanné à l’entrée.' };
      if (now >= e.startsAt) return { allowed: false, reason: 'L’événement a commencé : annulation impossible.' };
      const free = e.startsAt.getTime() - now.getTime() >= FREE_CANCEL_MS;
      const fee = free ? 0 : Math.round(t.price * LATE_CANCEL_FEE);
      return { allowed: true, fee, refund: t.price - fee, freeUntil: free ? new Date(e.startsAt.getTime() - FREE_CANCEL_MS).toISOString() : null };
    },

    onCancelled: async (t, session) => {
      const b = await this.bookings.findOneAndUpdate(
        { 'units.unitId': t.source.id },
        { $set: { 'units.$[u].status': 'cancelled', updatedAt: this.clock.now() } },
        { arrayFilters: [{ 'u.unitId': t.source.id, 'u.status': 'confirmed' }], session, returnDocument: 'before' },
      );
      const unit = b?.units.find((u) => u.unitId.equals(t.source.id));
      // The place is sold again (unless the whole event is cancelled: nothing is sold any more).
      if (unit && unit.status === 'confirmed') {
        await this.events.updateOne({ _id: t.eventId, status: 'published' }, { $inc: { 'ticketTypes.$[t].remaining': 1 } }, { arrayFilters: [{ 't.typeId': unit.typeId }], session });
      }
    },

    transferDeadline: async (t) => (await this.events.findOne({ _id: t.eventId }, { projection: { startsAt: 1 } }))?.startsAt ?? new Date(0),

    refuseRecipient: async () => null,

    checkAdmission: async (t, { now }) => {
      const e = await this.events.findOne({ _id: t.eventId });
      if (!e || e.status === 'cancelled') return { ok: false, reason: 'event_cancelled', message: 'Cet événement est annulé.' };
      const opens = new Date(e.startsAt.getTime() - ENTRY_OPENS_MS);
      if (now < opens) return { ok: false, reason: 'too_early', message: `L’entrée ouvre le ${dakar.format(opens)}.` };
      if (now > new Date(e.endsAt.getTime() + ENTRY_GRACE_MS)) return { ok: false, reason: 'too_late', message: 'Cet événement est terminé.' };
      return { ok: true, warning: null, notes: [`Billet ${String(t.details.typeName)}.`] };
    },

    openForAdmission: async (orgId, now) =>
      (
        await this.events
          .find({ orgId, status: { $in: ['published', 'completed'] }, startsAt: { $lte: new Date(now.getTime() + ENTRY_OPENS_MS) }, endsAt: { $gte: new Date(now.getTime() - ENTRY_GRACE_MS) } }, { projection: { _id: 1 } })
          .toArray()
      ).map((e) => e._id),

    orgOf: async (eventId) => (await this.events.findOne({ _id: eventId }, { projection: { orgId: 1 } }))?.orgId ?? null,
  };

  // ---- Organizers -----------------------------------------------------------------------------------------------

  private async own(orgId: ObjectId, id: ObjectId, session?: ClientSession) {
    const e = await this.events.findOne({ _id: id, orgId }, { session });
    if (!e) throw errors.notFound('Événement introuvable.');
    return e;
  }

  private async fields(orgId: ObjectId, by: ObjectId, input: EventInput) {
    // Verified organizations, and students with their own organization (their events are reviewed by the admins).
    if (!(await this.organizations.can(orgId, 'events')) && !(await this.organizations.isPersonal(orgId))) {
      throw errors.forbidden('Ton organisation n’est pas encore vérifiée pour vendre des billets. Contacte l’équipe UGB Connect.');
    }
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const salesCloseAt = input.salesCloseAt ? new Date(input.salesCloseAt) : startsAt;
    if ([startsAt, endsAt, salesCloseAt].some((d) => Number.isNaN(d.getTime()))) throw errors.validation('Date invalide.', { field: 'startsAt' });
    if (startsAt <= this.clock.now()) throw errors.rule('EVENT_IN_PAST', 'La date de début est déjà passée.');
    if (endsAt <= startsAt) throw errors.validation('La fin doit être après le début.', { field: 'endsAt' });
    if (salesCloseAt > endsAt) throw errors.validation('La billetterie ferme au plus tard à la fin de l’événement.', { field: 'salesCloseAt' });
    const names = input.ticketTypes.map((t) => t.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) throw errors.validation('Deux types de billets ont le même nom.', { field: 'ticketTypes' });
    const images: ImageRef[] = await this.media.claim(by, input.imageIds);
    return {
      title: input.title.trim(),
      category: input.category,
      description: input.description.trim(),
      images,
      fixedCover: input.fixedCover ?? false,
      venue: { name: input.venue.name.trim(), address: input.venue.address?.trim() || null },
      startsAt,
      endsAt,
      salesCloseAt,
      ticketTypes: input.ticketTypes.map((t) => ({ typeId: randomCode(6), name: t.name.trim(), description: t.description?.trim() || null, price: t.price, capacity: t.capacity, remaining: t.capacity })),
      maxPerStudent: input.maxPerStudent ?? 4,
      paymentMethods: input.paymentMethods?.length ? [...new Set(input.paymentMethods)] : [...PAYMENT_METHODS],
    };
  }

  /** A draft: nothing is sold until it's published. */
  async create(orgId: ObjectId, by: ObjectId, input: EventInput) {
    const now = this.clock.now();
    const doc: EventDoc = {
      _id: new ObjectId(), code: `EV${randomCode(6)}`, orgId, ...(await this.fields(orgId, by, input)), status: 'draft', audience: EVERYONE, publication: null, review: null, reviewLog: [], cancellation: null,
      publishedAt: null, completedAt: null, claimPayoutId: null, createdBy: by, createdAt: now, updatedAt: now,
    };
    await this.events.insertOne(doc);
    return doc;
  }

  /**
   * A draft, or a student's event the admins sent back for corrections. Once tickets are sold, the date, the place
   * and the prices are what people paid for.
   */
  async update(orgId: ObjectId, id: ObjectId, by: ObjectId, input: EventInput) {
    const e = await this.own(orgId, id);
    if (e.status === 'pending_review') throw errors.conflict('EVENT_IN_REVIEW', 'Cet événement est en cours de validation : attends la réponse de l’équipe.');
    if (e.status !== 'draft' && e.status !== 'changes_requested') throw errors.conflict('EVENT_PUBLISHED', 'Un événement publié ne se modifie plus : annule-le et crée-en un autre.');
    await this.events.updateOne({ _id: id, status: e.status }, { $set: { ...(await this.fields(orgId, by, input)), updatedAt: this.clock.now() } });
    return this.own(orgId, id);
  }

  /**
   * A published event's pictures: the organizer reorders them, picks the cover (shown first, and on its banners) or
   * takes some off. Only those already on the event, which the team saw: a new picture would skip the review.
   */
  async updatePhotos(orgId: ObjectId, id: ObjectId, input: { imageIds: string[]; fixedCover: boolean }) {
    const e = await this.own(orgId, id);
    if (e.status !== 'published') throw errors.conflict('EVENT_NOT_PUBLISHED', 'Les photos se changent ici une fois l’événement publié.');
    if (new Set(input.imageIds).size !== input.imageIds.length) throw errors.validation('Une photo est en double.', { field: 'imageIds' });
    const images = input.imageIds.map((imgId) => {
      const found = e.images.find((i) => i.mediaId.toHexString() === imgId);
      if (!found) throw errors.validation('Seules les photos déjà sur l’événement peuvent être gardées.', { field: 'imageIds' });
      return found;
    });
    const res = await this.events.updateOne({ _id: id, status: 'published' }, { $set: { images, fixedCover: input.fixedCover && images.length > 1, updatedAt: this.clock.now() } });
    if (!res.matchedCount) throw errors.conflict('EVENT_NOT_PUBLISHED', 'L’événement a changé entre-temps : recharge la page.');
    // Pictures taken off leave the storage.
    await this.media.release(e.images.filter((old) => !images.some((i) => i.mediaId.equals(old.mediaId))).map((i) => i.mediaId));
    return this.own(orgId, id);
  }

  /**
   * Opens the ticket sales. A verified organization publishes at once; a student's event goes to the admins
   * (published once approved).
   */
  async publish(orgId: ObjectId, id: ObjectId, by?: ObjectId) {
    const e = await this.own(orgId, id);
    if (e.status !== 'draft' && e.status !== 'changes_requested') {
      throw errors.conflict('EVENT_PUBLISHED', e.status === 'pending_review' ? 'Cet événement est déjà en cours de validation.' : 'Cet événement est déjà publié.');
    }
    const now = this.clock.now();
    if (e.salesCloseAt <= now) throw errors.rule('EVENT_TOO_SOON', 'Trop tard pour ouvrir la billetterie.');
    // A student's own entity always goes through the admins' review, whatever its capabilities.
    const verified = (await this.organizations.can(orgId, 'events')) && !(await this.organizations.isPersonal(orgId));
    await this.events.updateOne(
      { _id: id, status: e.status },
      verified
        ? { $set: { status: 'published', publishedAt: now, updatedAt: now } }
        : { $set: { status: 'pending_review', updatedAt: now }, $push: { reviewLog: { at: now, by: by ?? e.createdBy, action: 'submitted', message: null } } },
    );
    return this.own(orgId, id);
  }

  // ---- Admins: students' events --------------------------------------------------------------------------------

  /** The review queue (oldest first), or events in another review status. */
  async listForReview(status: 'pending_review' | 'changes_requested' | 'rejected' = 'pending_review') {
    const docs = await this.events.find({ status }).sort({ updatedAt: 1 }).limit(100).toArray();
    return this.orgViews(docs);
  }

  /** Validated: the owner then chooses who sees it and pays the publication (the ticket sales open then). */
  async approve(id: ObjectId, by: ObjectId) {
    const now = this.clock.now();
    const e = await this.events.findOneAndUpdate(
      { _id: id, status: 'pending_review' },
      { $set: { status: 'approved', review: null, updatedAt: now }, $push: { reviewLog: { at: now, by, action: 'approved', message: null } } },
      { returnDocument: 'after' },
    );
    if (!e) throw errors.conflict('EVENT_NOT_IN_REVIEW', 'Cet événement n’attend pas de validation.');
    await this.tellOrganizer(e, 'approved', 'Événement validé', `« ${e.title} » est validé : choisis qui le voit et publie-le pour ouvrir la billetterie.`);
    return e;
  }

  // ---- Students: publishing an approved event --------------------------------------------------------------------

  private audience(a: PublicationInput['audience']): EventAudience {
    const only = <T extends string>(list: string[], allowed: readonly string[], field: string) => {
      if (list.some((v) => !allowed.includes(v))) throw errors.validation('Choix inconnu dans le public visé.', { field: `audience.${field}` });
      return [...new Set(list)] as T[];
    };
    return {
      campuses: only<Campus>(a.campuses, CAMPUSES, 'campuses'),
      ufrs: only<UfrCode>(a.ufrs, UFR_CODES, 'ufrs'),
      regions: only<Region>(a.regions, REGIONS, 'regions'),
      villages: only<string>(a.villages, ALL_VILLAGES, 'villages'),
    };
  }

  /**
   * The owner of an approved event sets who sees it, the places on sale (the date, the place and the prices stay as
   * validated) and may touch up the description, the pictures and the venue's details, then pays: so much per place.
   * Paid, the event is published. Asking again replaces the payment not made yet.
   */
  async publishPaid(orgId: ObjectId, id: ObjectId, by: ObjectId, input: PublicationInput, baseUrl: string) {
    await this.limiter.hit(`event-publish:${by.toHexString()}`, { limit: 20, windowS: 3600 });
    this.payments.assertAvailable(input.method);
    const returnUrl = this.payments.validateReturnUrl(input.returnUrl);
    const e = await this.own(orgId, id);
    if (e.status !== 'approved') {
      throw errors.conflict('EVENT_NOT_APPROVED', e.status === 'published' ? 'Cet événement est déjà publié.' : 'L’événement doit d’abord être validé par l’équipe UGB Connect.');
    }
    const now = this.clock.now();
    if (e.salesCloseAt <= now) throw errors.rule('EVENT_TOO_SOON', 'Trop tard pour ouvrir la billetterie.');
    const audience = this.audience(input.audience);
    const ticketTypes = e.ticketTypes.map((t) => {
      const p = input.places.find((x) => x.typeId === t.typeId);
      if (!p) throw errors.validation(`Indique le nombre de places « ${t.name} ».`, { field: 'places' });
      return { ...t, capacity: p.capacity, remaining: p.capacity };
    });
    const places = ticketTypes.reduce((n, t) => n + t.capacity, 0);
    const fee = publicationFee(places);
    const images = input.imageIds ? await this.media.claim(by, input.imageIds) : e.images;
    const set = {
      audience,
      ticketTypes,
      images,
      fixedCover: input.fixedCover ?? e.fixedCover ?? false,
      description: input.description?.trim() ?? e.description,
      venue: { name: e.venue.name, address: input.address === undefined ? e.venue.address : input.address?.trim() || null },
      maxPerStudent: input.maxPerStudent ?? e.maxPerStudent,
    };

    const payment = await withTransaction(this.mongo, async (session) => {
      if (e.publication && !e.publication.paidAt) await this.payments.cancelInSession(e.publication.paymentId, session);
      const created = await this.payments.create(
        {
          userId: by, purpose: 'event_publication', purposeRef: e._id, amount: fee, method: input.method, description: `Publication « ${e.title} » · ${places} places`,
          expiresAt: new Date(Math.min(now.getTime() + PAY_WITHIN_MIN * MIN, e.salesCloseAt.getTime())), returnUrl,
        },
        session,
      );
      const res = await this.events.updateOne(
        { _id: e._id, status: 'approved' },
        { $set: { ...set, publication: { places, fee, method: input.method, paymentId: created._id, paidAt: null }, updatedAt: now } },
        { session },
      );
      if (!res.modifiedCount) throw errors.conflict('EVENT_NOT_APPROVED', 'L’événement a changé entre-temps : recharge la page.');
      return created;
    });
    // Pictures taken off the event leave the storage once the new set is saved.
    await this.media.release(e.images.filter((old) => !images.some((i) => i.mediaId.equals(old.mediaId))).map((i) => i.mediaId));
    return { event: await this.own(orgId, id), payment: await this.payments.openCheckout(payment, baseUrl) };
  }

  readonly publicationPayment: PurposeHandler = {
    onSucceeded: async (payment, session) => {
      const now = this.clock.now();
      const e = await this.events.findOneAndUpdate(
        { _id: payment.purposeRef, status: 'approved', 'publication.paymentId': payment._id, salesCloseAt: { $gt: now } },
        { $set: { status: 'published', publishedAt: now, 'publication.paidAt': now, updatedAt: now } },
        { session, returnDocument: 'after' },
      );
      if (!e) {
        const cur = await this.events.findOne({ _id: payment.purposeRef }, { session });
        // Already published by this payment; otherwise (cancelled, replaced, too late) the money goes back.
        return cur?.status === 'published' && cur.publication?.paymentId.equals(payment._id) ? 'fulfilled' : 'unfulfillable';
      }
      afterCommit(session, () => this.tellOrganizer(e, 'published', `Événement publié · ${e.title}`, 'La billetterie est ouverte : ton événement est sur l’accueil des étudiants concernés.'));
      return 'fulfilled';
    },
    onClosed: async (payment, session) => {
      await this.events.updateOne(
        { _id: payment.purposeRef, status: 'approved', 'publication.paymentId': payment._id, 'publication.paidAt': null },
        { $set: { publication: null, updatedAt: this.clock.now() } },
        { session },
      );
    },
  };

  /** "Corrections demandées": the student sees the message on their event, fixes it and submits again. */
  async requestChanges(id: ObjectId, by: ObjectId, message: string) {
    const e = await this.decide(id, by, 'changes_requested', message);
    await this.tellOrganizer(e, 'changes_requested', `Corrections demandées · ${e.title}`, message);
    return e;
  }

  async reject(id: ObjectId, by: ObjectId, message: string) {
    const e = await this.decide(id, by, 'rejected', message);
    await this.tellOrganizer(e, 'rejected', `Événement refusé · ${e.title}`, message);
    return e;
  }

  private async decide(id: ObjectId, by: ObjectId, action: 'changes_requested' | 'rejected', message: string) {
    const now = this.clock.now();
    const e = await this.events.findOneAndUpdate(
      { _id: id, status: 'pending_review' },
      { $set: { status: action, review: { message, at: now, by }, updatedAt: now }, $push: { reviewLog: { at: now, by, action, message } } },
      { returnDocument: 'after' },
    );
    if (!e) throw errors.conflict('EVENT_NOT_IN_REVIEW', 'Cet événement n’attend pas de validation.');
    return e;
  }

  private async tellOrganizer(e: EventDoc, action: string, title: string, body: string) {
    await this.notifications.notify([e.createdBy], {
      type: `event.${action}`, category: 'social', icon: action === 'approved' || action === 'published' ? 'checkmark-circle-outline' : 'create-outline', tone: action === 'approved' || action === 'published' ? 'success' : 'warning',
      url: `/mes-evenements/${e._id.toHexString()}`, dedupeKey: `event:${e._id.toHexString()}:${action}:${(e.reviewLog.length).toString()}`,
      title, body,
    });
  }

  // ---- Students: their own events ------------------------------------------------------------------------------

  /** The student's own organization (created with their first event). */
  async personalOrgOf(userId: ObjectId, create: boolean) {
    const user = await this.accounts.findById(userId);
    if (!user) throw errors.unauthenticated();
    const orgId = await this.organizations.personalOrg(user, create);
    // Their events open the organizer space, even when they already run their own shop.
    if (orgId && create) await this.organizations.addCapability(orgId, 'events');
    return orgId;
  }

  /** Before it starts. Every ticket is refunded 100 %; places being paid are released. */
  async cancel(orgId: ObjectId, id: ObjectId, reason: string) {
    const payoutIds: ObjectId[] = [];
    await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const e = await this.events.findOneAndUpdate(
        { _id: id, orgId, status: { $in: ['draft', 'pending_review', 'changes_requested', 'approved', 'published'] }, startsAt: { $gt: now } },
        { $set: { status: 'cancelled', cancellation: { at: now, reason }, updatedAt: now } },
        { session },
      );
      if (!e) {
        await this.own(orgId, id, session);
        throw errors.conflict('EVENT_NOT_CANCELLABLE', 'Cet événement ne peut plus être annulé (commencé, terminé ou déjà annulé).');
      }
      if (e.publication && !e.publication.paidAt) await this.payments.cancelInSession(e.publication.paymentId, session);
      payoutIds.push(...(await this.ticketing.cancelAllForEvent(id, 'event_cancelled', session)));
      const held = await this.bookings.find({ eventId: id, status: 'held' }, { session }).toArray();
      for (const b of held) if (b.paymentId) await this.payments.cancelInSession(b.paymentId, session);
      await this.bookings.updateMany({ eventId: id, status: 'held' }, { $set: { status: 'cancelled', 'units.$[].status': 'cancelled', updatedAt: now } }, { session });
    });
    await this.payments.schedulePayouts(payoutIds);
    return { refunded: payoutIds.length };
  }

  async listForOrg(orgId: ObjectId) {
    const docs = await this.events.find({ orgId }).sort({ startsAt: -1 }).limit(100).toArray();
    return this.orgViews(docs);
  }

  async orgEvent(orgId: ObjectId, id: ObjectId) {
    return (await this.orgViews([await this.own(orgId, id)]))[0]!;
  }

  private async orgViews(docs: EventDoc[]) {
    if (!docs.length) return [];
    const counts = await this.ticketing.counts(docs.map((d) => d._id));
    const cards = await this.organizations.cards([...new Map(docs.map((d) => [d.orgId.toHexString(), d.orgId])).values()]);
    const now = this.clock.now();
    return Promise.all(
      docs.map(async (e) => {
        const over = e.status === 'completed' || (e.status === 'published' && e.endsAt <= now);
        const revenue = over ? await this.ticketing.revenue(e._id) : null;
        const payout = e.claimPayoutId ? await this.payments.findPayout(e.claimPayoutId) : null;
        const pub = e.publication;
        const pubPayment = pub && !pub.paidAt ? await this.payments.findById(pub.paymentId) : null;
        return {
          ...this.publicView(e, cards.get(e.orgId.toHexString())!, now),
          ticketTypes: e.ticketTypes.map((t) => ({ typeId: t.typeId, name: t.name, description: t.description, price: t.price, capacity: t.capacity, sold: t.capacity - t.remaining, remaining: t.remaining, soldOut: t.remaining === 0 })),
          counts: counts.get(e._id.toHexString()) ?? { booked: 0, buyers: 0, admitted: 0 },
          reviewLog: e.reviewLog.map((r) => ({ at: r.at.toISOString(), action: r.action, message: r.message })),
          // The organizer edits the event with the same pictures.
          imageIds: e.images.map((i) => i.mediaId.toHexString()),
          fixedCover: e.fixedCover ?? false,
          audience: e.audience ?? EVERYONE,
          publicationFee: PUBLICATION_FEE,
          publication: pub
            ? {
                places: pub.places, fee: pub.fee, paid: !!pub.paidAt,
                payment: pubPayment && (pubPayment.status === 'created' || pubPayment.status === 'pending') ? { reference: pubPayment.reference, checkoutUrl: pubPayment.checkoutUrl } : null,
              }
            : null,
          claim: revenue ? { amount: revenue.tickets + revenue.fees, payout: payout ? { id: payout._id.toHexString(), status: payout.status, amount: payout.amount } : null } : null,
        };
      }),
    );
  }

  /** The entrance list: every valid ticket, who holds it, its type, whether it's been scanned. Audited by the route. */
  async attendees(orgId: ObjectId, id: ObjectId) {
    const e = await this.own(orgId, id);
    const tickets = await this.ticketing.activeTickets(id);
    const [contacts, admitted] = await Promise.all([
      this.accounts.contactsByIds([...new Map(tickets.map((t) => [t.holderUserId.toHexString(), t.holderUserId])).values()]),
      this.ticketing.admittedTicketIds(id),
    ]);
    return {
      event: (await this.orgViews([e]))[0]!,
      attendees: tickets.map((t) => {
        const c = contacts.get(t.holderUserId.toHexString());
        const a = admitted.get(t._id.toHexString());
        return {
          ticketId: t._id.toHexString(), code: t.code, typeName: String(t.details.typeName), name: c ? `${c.firstName} ${c.lastName}` : 'Participant',
          admitted: !!a, admittedAt: a?.at.toISOString() ?? null,
        };
      }),
    };
  }

  /** After the event: the paid tickets (and fees kept on late cancellations) to the organization's number. Once. */
  async claim(orgId: ObjectId, id: ObjectId, userId: ObjectId, method: PaymentMethod): Promise<PayoutDoc> {
    const phone = await this.organizations.payoutPhone(orgId);
    if (!phone) throw errors.rule('NO_PAYOUT_ACCOUNT', 'Aucun numéro de paiement pour l’organisation. Demande à l’équipe UGB Connect de l’enregistrer.');
    let payout!: PayoutDoc;
    await withTransaction(this.mongo, async (session) => {
      const e = await this.own(orgId, id, session);
      if (!(e.status === 'completed' || (e.status === 'published' && e.endsAt <= this.clock.now()))) throw errors.conflict('EVENT_NOT_OVER', 'Tu pourras récupérer l’argent une fois l’événement terminé.');
      const { tickets, fees } = await this.ticketing.revenue(e._id, session);
      if (tickets + fees <= 0) throw errors.rule('NOTHING_TO_CLAIM', 'Aucun billet payé pour cet événement.');
      payout = await this.payments.createPayout(
        { kind: 'organizer_claim', beneficiaryUserId: userId, payTo: { orgId, phone }, method, amount: tickets + fees, reason: 'event_claim', source: { type: 'event', id: e._id }, idempotencyKey: `event:${e._id.toHexString()}:claim` },
        session,
      );
      await this.events.updateOne({ _id: e._id }, { $set: { claimPayoutId: payout._id } }, { session });
    });
    await this.payments.schedulePayouts([payout._id]);
    return payout;
  }

  /** Worker: events over are completed (the claim stays possible). */
  async sweep() {
    const res = await this.events.updateMany({ status: 'published', endsAt: { $lte: new Date(this.clock.now().getTime() - ENTRY_GRACE_MS) } }, { $set: { status: 'completed', completedAt: this.clock.now() } });
    return res.modifiedCount;
  }

  /** For banners: an event the organization may promote (its own, published, not over). */
  async promotable(orgId: ObjectId, id: ObjectId) {
    const e = await this.events.findOne({ _id: id, orgId, status: 'published', endsAt: { $gt: this.clock.now() } });
    if (!e) throw errors.validation('Choisis un de tes événements publiés et à venir.', { field: 'eventId' });
    return e;
  }

  /** For banners: what the carousel shows of an event (cover, date, place, from-price). */
  async summaries(ids: ObjectId[]) {
    const docs = ids.length ? await this.events.find({ _id: { $in: ids } }).toArray() : [];
    return new Map(
      docs.map((e) => {
        const min = Math.min(...e.ticketTypes.map((t) => t.price));
        return [
          e._id.toHexString(),
          {
            id: e._id.toHexString(), title: e.title, startsAt: e.startsAt.toISOString(), venue: e.venue.name, status: e.status, categoryLabel: CATEGORY_LABELS[e.category], priceLabel: min === 0 ? 'Gratuit' : `Dès ${fcfa(min)}`,
            images: e.images.map((i) => i.url), fixedCover: e.fixedCover ?? false,
          },
        ];
      }),
    );
  }
}
