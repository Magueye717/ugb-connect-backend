import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { afterCommit, isDuplicateKey, withTransaction } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import type { RealtimeHub } from '../../platform/realtime/hub.js';
import { randomCode } from '../../platform/security/crypto.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AccountsApi } from '../accounts/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrgCard, OrganizationsApi } from '../organizations/index.js';
import { PAYMENT_METHODS, type PaymentMethod, type PaymentsApi, type PayoutDoc, type PurposeHandler } from '../payments/index.js';
import { TICKET_PAYMENT_LABELS, type TicketPaymentMethod } from '../ticketing/index.js';
import type { TicketingApi, TicketKindHandler } from '../ticketing/index.js';
import {
  BOARDING_GRACE_MS,
  BOARDING_OPENS_MS,
  BOOKING_CLOSE_MIN,
  FIRST_ROW_SEATS,
  DEFAULT_MAX_SEATS_PER_STUDENT,
  FREE_CANCEL_MS,
  HOLD_MIN,
  LATE_CANCEL_FEE,
  TRANSFER_CUTOFF_MS,
  type BookingDoc,
  type DepartureDoc,
  type Direction,
  type Passenger,
  type Stop,
  type VehicleDoc,
} from './caravans.types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const dakar = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Dakar', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Departures students can see and book. */
const LISTED = ['published', 'confirmed'] as const;
/** Departures that still happen (scanning, stops). */
const RUNNING = ['published', 'confirmed', 'departed'] as const;

const sellable = (v: DepartureDoc['vehicle']) => v.capacity - v.blockedSeats.length;
/** First and last seat of each row are by the window (4 per row: 1, 4, 5, 8…), as on the app's seat map. */
/**
 * Where seat n sits, counted from the front: the first row has 2 seats on the right (the door and the driver on the
 * left), then full rows of `perRow`. Column 0 is the left window.
 */
const columnOf = (n: number, perRow: number) => (n <= FIRST_ROW_SEATS ? perRow - FIRST_ROW_SEATS + (n - 1) : (n - 1 - FIRST_ROW_SEATS) % perRow);
const isWindow = (n: number, perRow: number) => {
  const c = columnOf(n, perRow);
  return c === 0 || c === perRow - 1;
};
/** 5 per row: the middle one is the folding seat in the aisle (« versailler »). */
const isMiddle = (n: number, perRow: number) => perRow % 2 === 1 && columnOf(n, perRow) === Math.floor(perRow / 2);
const lastStop = (d: DepartureDoc) => d.dropoffs[d.dropoffs.length - 1]!;
const stopView = (s: Stop) => ({ stopId: s.stopId, place: s.place, at: s.at.toISOString() });
const localPhone = (phone: string) => phone.replace(/^\+221(\d{2})(\d{3})(\d{2})(\d{2})$/, '+221 $1 $2 $3 $4');

export type StopInput = { place: string; at: string };
export type NewDeparture = {
  vehicleId: string;
  /** Accepted providers; default: all. */
  paymentMethods?: TicketPaymentMethod[];
  direction: Direction;
  from: string;
  to: string;
  pickups: StopInput[];
  dropoffs: StopInput[];
  price: number;
  maxSeatsPerStudent?: number;
  minPassengers: number;
  confirmBy?: string;
  bookingClosesAt?: string;
};

/** One seat in a booking request: for the student (no passenger) or for a companion. Seat omitted: picked by the server. */
export type SeatRequest = { seat?: number; passenger?: { name: string; phone: string } };

export class CaravansService {
  private readonly vehicles: Collection<VehicleDoc>;
  private readonly departures: Collection<DepartureDoc>;
  private readonly bookings: Collection<BookingDoc>;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly accounts: AccountsApi,
    private readonly organizations: OrganizationsApi,
    private readonly payments: PaymentsApi,
    private readonly ticketing: TicketingApi,
    private readonly hub: RealtimeHub,
    private readonly limiter: Limiter,
    private readonly notifications: NotificationsApi,
  ) {
    this.vehicles = db.collection('vehicles');
    this.departures = db.collection('departures');
    this.bookings = db.collection('bookings');
  }

  // ---- Student: browse -----------------------------------------------------------------------------------------

  /** Bookable departures, soonest first. Search by stop is done by the app (accents, partial names). */
  async list(viewerId: ObjectId, direction?: Direction) {
    const now = this.clock.now();
    const docs = await this.departures
      .find({ status: { $in: [...LISTED] }, departureAt: { $gt: now }, ...(direction ? { direction } : {}) })
      .sort({ departureAt: 1 })
      .limit(100)
      .toArray();
    return this.views(docs, viewerId);
  }

  async get(id: ObjectId) {
    const d = await this.departures.findOne({ _id: id });
    if (!d || d.status === 'draft') throw errors.notFound('Départ introuvable.');
    return d;
  }

  async views(docs: DepartureDoc[], viewerId: ObjectId) {
    if (!docs.length) return [];
    const ids = docs.map((d) => d._id);
    const [cards, myBookings] = await Promise.all([
      this.organizations.cards([...new Map(docs.map((d) => [d.orgId.toHexString(), d.orgId])).values()]),
      this.bookings.find({ departureId: { $in: ids }, userId: viewerId, countsForLimit: true }).toArray(),
    ]);
    const tickets = await Promise.all(docs.map((d) => this.ticketing.hasActiveTicket(d._id, viewerId)));
    const now = this.clock.now();
    return Promise.all(
      docs.map(async (d, i) => {
        const ticket = tickets[i];
        const mine = myBookings.filter((b) => b.departureId.equals(d._id)).sort((a, b) => a.slot - b.slot);
        const held = mine.filter((b) => b.status === 'held');
        const lead = held[0];
        const payment = lead?.paymentId ? await this.payments.findById(lead.paymentId) : null;
        return {
          ...this.publicView(d, cards.get(d.orgId.toHexString())!, now),
          // The plate is for the people travelling: shown once you hold a ticket.
          vehicle: { label: d.vehicle.label, airConditioned: d.vehicle.airConditioned, plate: ticket || mine.some((b) => b.status === 'confirmed') ? d.vehicle.plate : null },
          myTicketId: ticket?._id.toHexString() ?? null,
          /** I bought here and gave my own ticket away. */
          purchasedHere: mine.some((b) => b.status === 'confirmed') && !ticket,
          /** Seats I can still buy here (my own, if I have none, and companions'): the limit counts purchases, even transferred. */
          mySeatsLeft: Math.max(0, d.maxSeatsPerStudent - mine.length),
          myBooking: lead
            ? {
                id: lead._id.toHexString(), seat: lead.seat, holdExpiresAt: lead.holdExpiresAt.toISOString(),
                seats: held.map((b) => ({ seat: b.seat, passenger: b.passenger ? { name: b.passenger.name, phone: localPhone(b.passenger.phone) } : null })),
                payment: payment ? { reference: payment.reference, checkoutUrl: payment.checkoutUrl } : null,
              }
            : null,
        };
      }),
    );
  }

  private publicView(d: DepartureDoc, organizer: OrgCard, now: Date) {
    return {
      id: d._id.toHexString(),
      code: d.code,
      status: d.status,
      organizer,
      direction: d.direction,
      from: d.from,
      to: d.to,
      departureAt: d.departureAt.toISOString(),
      pickups: d.pickups.map(stopView),
      dropoffs: d.dropoffs.map(stopView),
      price: d.price,
      maxSeatsPerStudent: d.maxSeatsPerStudent,
      paymentMethods: d.paymentMethods ?? [...PAYMENT_METHODS],
      totalSeats: sellable(d.vehicle),
      seatsFree: Math.max(0, sellable(d.vehicle) - d.seatsTaken),
      seatsBooked: d.seatsConfirmed,
      minPassengers: d.minPassengers,
      confirmBy: d.confirmBy.toISOString(),
      confirmed: d.status === 'confirmed' || d.status === 'departed' || d.status === 'completed',
      bookingOpen: (d.status === 'published' || d.status === 'confirmed') && now < d.bookingClosesAt && d.seatsTaken < sellable(d.vehicle),
    };
  }

  /** The seat map: taken seats only, never who sits where. `suggested`: the seat "Choisis pour moi" would pick. */
  async seatMap(id: ObjectId) {
    const d = await this.get(id);
    const taken = (await this.bookings.find({ departureId: id, seatActive: true }, { projection: { seat: 1 } }).toArray()).map((b) => b.seat).sort((a, b) => a - b);
    return {
      capacity: d.vehicle.capacity,
      seatsPerRow: d.vehicle.seatsPerRow,
      firstRowSeats: FIRST_ROW_SEATS,
      blocked: d.vehicle.blockedSeats,
      taken,
      suggested: this.candidates(d, new Set(taken))[0] ?? null,
    };
  }

  /** Front-most free window seat, then aisle seat, the folding middle seat last (the app's "Choisis pour moi"). */
  private candidates(d: DepartureDoc, taken: Set<number>) {
    const per = d.vehicle.seatsPerRow;
    const free = Array.from({ length: d.vehicle.capacity }, (_, i) => i + 1).filter((n) => !taken.has(n) && !d.vehicle.blockedSeats.includes(n));
    return [...free.filter((n) => isWindow(n, per)), ...free.filter((n) => !isWindow(n, per) && !isMiddle(n, per)), ...free.filter((n) => isMiddle(n, per))];
  }

  // ---- Student: book and pay -----------------------------------------------------------------------------------

  /**
   * Holds the seats for 10 minutes and opens one payment for all of them: the student's own seat and/or seats for
   * companions (name + phone, no account needed), up to the departure's limit per student. The unique indexes
   * decide, not the counters: two students can't hold the same seat, a student can't go over the limit, and can't
   * hold two seats for themselves.
   */
  async book(
    userId: ObjectId,
    departureId: ObjectId,
    input: { seat?: number; seats?: SeatRequest[]; pickupStopId: string; dropoffStopId: string; method: TicketPaymentMethod; returnUrl?: string | null },
    baseUrl: string,
  ) {
    await this.limiter.hit(`caravan-book:${userId.toHexString()}`, { limit: 20, windowS: 3600 });
    // Cash: nothing to pay here, the seats are booked at once and paid at boarding.
    const cash = input.method === 'cash';
    if (!cash) this.payments.assertAvailable(input.method as PaymentMethod);
    const returnUrl = this.payments.validateReturnUrl(input.returnUrl);
    const d = await this.get(departureId);
    const accepted = d.paymentMethods ?? [...PAYMENT_METHODS];
    if (!accepted.includes(input.method)) throw errors.validation(`Ce départ n’accepte pas ${TICKET_PAYMENT_LABELS[input.method]}.`, { field: 'method' });
    const now = this.clock.now();
    if (!(d.status === 'published' || d.status === 'confirmed') || now >= d.bookingClosesAt) {
      throw errors.conflict('BOOKING_CLOSED', 'Les réservations sont fermées pour ce départ.');
    }
    const pickup = d.pickups.find((s) => s.stopId === input.pickupStopId);
    const dropoff = d.dropoffs.find((s) => s.stopId === input.dropoffStopId);
    if (!pickup || !dropoff || dropoff.at <= pickup.at) throw errors.validation('Choisis une montée et une descente de ce trajet.', { field: 'pickupStopId' });

    // Coming back to pay: the same hold, the same payment.
    const held = await this.bookings.find({ departureId, userId, status: 'held' }).sort({ slot: 1 }).toArray();
    if (held[0]?.paymentId) {
      const payment = await this.payments.findById(held[0].paymentId);
      if (payment && (payment.status === 'created' || payment.status === 'pending')) {
        return { booking: held[0], payment: await this.payments.openCheckout(payment, baseUrl), replay: true };
      }
    }

    const wanted = await this.seatRequests(d, userId, input.seats ?? [{ seat: input.seat }]);
    const max = d.maxSeatsPerStudent;
    const tooMany = (used: number) =>
      errors.conflict(
        'SEAT_LIMIT',
        max === 1
          ? 'Une seule place par étudiant sur ce départ.'
          : `${max} places maximum par étudiant sur ce départ${used ? ` : tu en as déjà ${used}` : ''}.`,
      );
    if (wanted.length > max) throw tooMany(0);
    const explicit = wanted.every((w) => w.seat !== undefined);
    const holdExpiresAt = new Date(Math.min(now.getTime() + HOLD_MIN * MIN, d.bookingClosesAt.getTime()));

    for (let attempt = 0; attempt < 5; attempt++) {
      const used = new Set((await this.bookings.find({ departureId, userId, countsForLimit: true }, { projection: { slot: 1 } }).toArray()).map((b) => b.slot));
      const slots = Array.from({ length: max }, (_, i) => i + 1).filter((n) => !used.has(n));
      if (slots.length < wanted.length) throw tooMany(used.size);
      const taken = new Set((await this.bookings.find({ departureId, seatActive: true }, { projection: { seat: 1 } }).toArray()).map((b) => b.seat));
      if (wanted.some((w) => w.seat !== undefined && taken.has(w.seat))) throw errors.conflict('SEAT_TAKEN', 'Une des places choisies vient d’être prise. Choisis-en une autre.');
      const free = this.candidates(d, new Set([...taken, ...wanted.flatMap((w) => (w.seat ? [w.seat] : []))]));
      const seats = wanted.map((w) => w.seat ?? free.shift());
      if (seats.some((n) => n === undefined)) throw errors.conflict('NO_SEATS_LEFT', wanted.length > 1 ? 'Plus assez de places libres sur ce départ.' : 'Ce départ est complet.');
      try {
        const created = await withTransaction(this.mongo, async (session) => {
          const counted = await this.departures.updateOne(
            { _id: departureId, status: { $in: [...LISTED] }, bookingClosesAt: { $gt: now }, $expr: { $lte: [{ $add: ['$seatsTaken', wanted.length] }, sellable(d.vehicle)] } },
            { $inc: { seatsTaken: wanted.length }, $set: { updatedAt: now } },
            { session },
          );
          if (!counted.modifiedCount) throw errors.conflict('NO_SEATS_LEFT', wanted.length > 1 ? 'Plus assez de places libres sur ce départ.' : 'Ce départ est complet.');
          const orderId = new ObjectId();
          const payment = cash
            ? null
            : await this.payments.create(
                {
                  userId, purpose: 'caravan_booking', purposeRef: orderId, amount: d.price * wanted.length, method: input.method as PaymentMethod,
                  description: `Caravane ${d.from} → ${d.to} · ${seats.length > 1 ? `places ${seats.join(', ')}` : `place ${seats[0]}`}`, expiresAt: holdExpiresAt, returnUrl,
                },
                session,
              );
          const docs: BookingDoc[] = wanted.map((w, i) => ({
            _id: new ObjectId(), departureId, userId, orderId, slot: slots[i]!, passenger: w.passenger, forSelf: !w.passenger, seat: seats[i]!,
            pickupStopId: pickup.stopId, dropoffStopId: dropoff.stopId, price: d.price, method: input.method,
            status: 'held', seatActive: true, countsForLimit: true, holdExpiresAt, paymentId: payment?._id ?? null, ticketId: null, createdAt: now, updatedAt: now,
          }));
          await this.bookings.insertMany(docs, { session });
          // Cash: the tickets are issued now (to pay at boarding).
          if (!payment && (await this.confirm(docs, 'cash', session)) !== 'fulfilled') throw errors.conflict('ALREADY_BOOKED', 'Tu as déjà ta place sur ce départ.');
          return { booking: docs[0]!, payment };
        });
        return { booking: created.booking, payment: created.payment ? await this.payments.openCheckout(created.payment, baseUrl) : null, replay: false };
      } catch (err) {
        if (isDuplicateKey(err, 'departure_user_self_held_unique')) throw errors.conflict('ALREADY_BOOKED', 'Tu es déjà en train de payer ta place pour ce départ.');
        // Another purchase of mine took the slot a moment ago: count again.
        if (isDuplicateKey(err, 'departure_user_slot_unique')) continue;
        if (!isDuplicateKey(err, 'departure_seat_active_unique')) throw err;
        // Someone took a seat a moment ago: chosen seats are refused, automatic ones move to the next.
        if (explicit) throw errors.conflict('SEAT_TAKEN', 'Une des places choisies vient d’être prise. Choisis-en une autre.');
      }
    }
    throw errors.conflict('NO_SEATS_LEFT', 'Plus de place libre à l’instant. Réessaie.');
  }

  /**
   * Checks what the student asked for: at most one seat for themselves (and only if they have none), each companion
   * named with a phone that isn't theirs, nor already travelling on this departure.
   */
  private async seatRequests(d: DepartureDoc, userId: ObjectId, list: SeatRequest[]): Promise<{ seat?: number; passenger: Passenger | null }[]> {
    if (!list.length) throw errors.validation('Choisis au moins une place.', { field: 'seats' });
    const chosen = list.flatMap((r) => (r.seat !== undefined ? [r.seat] : []));
    if (new Set(chosen).size !== chosen.length) throw errors.validation('La même place est choisie deux fois.', { field: 'seats' });
    if (chosen.some((n) => n < 1 || n > d.vehicle.capacity || d.vehicle.blockedSeats.includes(n))) {
      throw errors.validation('Cette place n’existe pas dans ce véhicule.', { field: 'seat' });
    }
    const self = list.filter((r) => !r.passenger);
    if (self.length > 1) throw errors.validation('Une seule place à ton nom : indique le nom et le numéro de ton accompagnant.', { field: 'seats' });
    if (self.length && (await this.ticketing.hasActiveTicket(d._id, userId))) {
      throw errors.conflict('ALREADY_BOOKED', 'Tu as déjà ta place sur ce départ. Pour un accompagnant, indique son nom et son numéro.');
    }
    const me = await this.accounts.findById(userId);
    const phones = new Set<string>();
    const out: { seat?: number; passenger: Passenger | null }[] = [];
    for (const r of list) {
      if (!r.passenger) {
        out.push({ seat: r.seat, passenger: null });
        continue;
      }
      const name = r.passenger.name.trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 60) throw errors.validation('Indique le nom complet de ton accompagnant.', { field: 'passenger.name' });
      const phone = this.accounts.phoneOrThrow(r.passenger.phone);
      if (me && phone === me.phone) throw errors.validation('C’est ton propre numéro : indique celui de ton accompagnant.', { field: 'passenger.phone' });
      if (phones.has(phone)) throw errors.validation('Chaque accompagnant a son propre numéro.', { field: 'passenger.phone' });
      if (await this.ticketing.isTravelling(d._id, phone)) throw errors.conflict('PASSENGER_HAS_SEAT', 'Ce numéro a déjà une place sur ce départ.');
      phones.add(phone);
      out.push({ seat: r.seat, passenger: { name, phone } });
    }
    // The student's own seat first: it's the one the booking is shown by.
    return out.sort((a, b) => Number(!!a.passenger) - Number(!!b.passenger));
  }

  /** A booking and the seats paid with it. */
  async booking(userId: ObjectId, bookingId: ObjectId) {
    const b = await this.bookings.findOne({ _id: bookingId, userId });
    if (!b) throw errors.notFound('Réservation introuvable.');
    const order = await this.bookings.find({ orderId: b.orderId, userId }).sort({ slot: 1 }).toArray();
    const payment = b.paymentId ? await this.payments.findById(b.paymentId) : null;
    return {
      id: b._id.toHexString(),
      departureId: b.departureId.toHexString(),
      status: b.status,
      seat: b.seat,
      holdExpiresAt: b.holdExpiresAt.toISOString(),
      ticketId: b.ticketId?.toHexString() ?? null,
      seats: order.map((x) => ({
        seat: x.seat,
        passenger: x.passenger ? { name: x.passenger.name, phone: localPhone(x.passenger.phone) } : null,
        status: x.status,
        ticketId: x.ticketId?.toHexString() ?? null,
      })),
      payment: payment ? { reference: payment.reference, status: payment.status, amount: payment.amount, checkoutUrl: payment.checkoutUrl } : null,
    };
  }

  /** "Retour" on the payment step: the seats go back to others at once. */
  async release(userId: ObjectId, bookingId: ObjectId) {
    await withTransaction(this.mongo, async (session) => {
      const now = this.clock.now();
      const b = await this.bookings.findOne({ _id: bookingId, userId, status: 'held' }, { session });
      if (!b) throw errors.notFound('Réservation introuvable ou déjà payée.');
      const res = await this.bookings.updateMany(
        { orderId: b.orderId, status: 'held' },
        { $set: { status: 'cancelled', seatActive: false, countsForLimit: false, updatedAt: now } },
        { session },
      );
      if (res.modifiedCount) await this.departures.updateOne({ _id: b.departureId }, { $inc: { seatsTaken: -res.modifiedCount }, $set: { updatedAt: now } }, { session });
      if (b.paymentId) await this.payments.cancelInSession(b.paymentId, session);
    });
  }

  /** Called by payments inside its transaction. One payment covers every seat of an order: all are confirmed, or all refunded. */
  readonly bookingPayment: PurposeHandler = {
    onSucceeded: async (payment, session) => {
      const order = await this.bookings.find({ orderId: payment.purposeRef }, { session }).sort({ slot: 1 }).toArray();
      if (!order.length || order.some((b) => !b.paymentId?.equals(payment._id))) return 'unfulfillable';
      if (order.every((b) => b.status === 'confirmed')) return 'fulfilled';
      if (order.every((b) => b.status === 'held')) return this.confirm(order, payment.method, session);
      if (!order.every((b) => b.status === 'expired')) return 'unfulfillable'; // released on purpose: refunded
      // Paid after the hold ran out: keep the same seats if nobody took them, else refund.
      const d = await this.departures.findOne({ _id: order[0]!.departureId }, { session });
      const now = this.clock.now();
      if (!d || !(d.status === 'published' || d.status === 'confirmed') || now >= d.departureAt) return 'unfulfillable';
      const userId = order[0]!.userId;
      const conflict = await this.bookings.findOne(
        {
          departureId: d._id,
          $or: [
            { seat: { $in: order.map((b) => b.seat) }, seatActive: true },
            { userId, slot: { $in: order.map((b) => b.slot) }, countsForLimit: true },
            ...(order.some((b) => b.forSelf) ? [{ userId, forSelf: true, status: 'held' as const }] : []),
          ],
        },
        { session },
      );
      if (conflict || d.seatsTaken + order.length > sellable(d.vehicle)) return 'unfulfillable';
      await this.bookings.updateMany({ orderId: payment.purposeRef }, { $set: { status: 'held', seatActive: true, countsForLimit: true, updatedAt: now } }, { session });
      await this.departures.updateOne({ _id: d._id }, { $inc: { seatsTaken: order.length } }, { session });
      return this.confirm(order.map((b) => ({ ...b, status: 'held' as const })), payment.method, session);
    },
    onClosed: async (payment, session) => {
      const now = this.clock.now();
      const order = await this.bookings.find({ orderId: payment.purposeRef, status: 'held', paymentId: payment._id }, { session }).toArray();
      if (!order.length) return;
      await this.bookings.updateMany(
        { _id: { $in: order.map((b) => b._id) }, status: 'held' },
        { $set: { status: 'expired', seatActive: false, countsForLimit: false, updatedAt: now } },
        { session },
      );
      await this.departures.updateOne({ _id: order[0]!.departureId }, { $inc: { seatsTaken: -order.length }, $set: { updatedAt: now } }, { session });
    },
  };

  /**
   * Held → confirmed, one ticket per seat (a companion's ticket carries their name, held by the purchaser), and the
   * departure confirmed once the minimum is reached. A companion who has an account is then offered their ticket.
   */
  private async confirm(order: BookingDoc[], method: TicketPaymentMethod, session: ClientSession): Promise<'fulfilled' | 'unfulfillable'> {
    const first = order[0]!;
    // Received a ticket by transfer meanwhile: the seat for themselves can't be confirmed, the order is refunded.
    if (order.some((b) => b.forSelf) && (await this.ticketing.hasActiveTicket(first.departureId, first.userId, session))) return 'unfulfillable';
    const now = this.clock.now();
    const d = (await this.departures.findOne({ _id: first.departureId }, { session }))!;
    const companions: ObjectId[] = [];
    for (const b of order) {
      const ticket = await this.ticketing.issue(
        {
          kind: 'caravan_seat', eventId: d._id, orgId: d.orgId, purchaserUserId: b.userId, source: { type: 'caravan_booking', id: b._id },
          price: b.price, paidWith: method, seat: b.seat, details: { pickupStopId: b.pickupStopId, dropoffStopId: b.dropoffStopId }, passenger: b.passenger,
        },
        session,
      );
      if (b.passenger) companions.push(ticket._id);
      await this.bookings.updateOne({ _id: b._id, status: 'held' }, { $set: { status: 'confirmed', ticketId: ticket._id, updatedAt: now } }, { session });
    }
    const after = await this.departures.findOneAndUpdate({ _id: d._id }, { $inc: { seatsConfirmed: order.length }, $set: { updatedAt: now } }, { returnDocument: 'after', session });
    if (after && after.status === 'published' && after.seatsConfirmed >= after.minPassengers) {
      await this.departures.updateOne({ _id: d._id, status: 'published' }, { $set: { status: 'confirmed', confirmedAt: now } }, { session });
      // Everyone holding a ticket hears it, once the confirmation is committed.
      afterCommit(session, () => this.tellConfirmed(d._id));
    }
    afterCommit(session, async () => {
      await this.hub.publish(`event:${d._id.toHexString()}`, 'tickets.updated', {});
      for (const id of companions) await this.ticketing.offerToPassenger(id);
    });
    return 'fulfilled';
  }

  /** "Départ confirmé": the minimum is reached, the bus goes. Each holder gets a link to their own ticket. */
  private async tellConfirmed(departureId: ObjectId) {
    const d = await this.departures.findOne({ _id: departureId });
    if (!d) return;
    for (const t of await this.ticketing.activeTickets(departureId)) {
      const pickup = d.pickups.find((s) => s.stopId === t.details.pickupStopId) ?? d.pickups[0]!;
      await this.notifications.notify([t.holderUserId], {
        type: 'caravan.confirmed', category: 'paiements', icon: 'bus-outline', tone: 'success', url: `/billet/${t._id.toHexString()}`,
        dedupeKey: `departure:${departureId.toHexString()}:confirmed`,
        title: `Départ confirmé · ${d.from} → ${d.to}`,
        body: `Montée le ${dakar.format(pickup.at)} à ${pickup.place}. Sois-y 15 min avant.`,
      });
    }
  }

  // ---- The rules of a caravan ticket (ticketing calls these) -----------------------------------------------------

  readonly ticketKind: TicketKindHandler & { labels: { admitted: string; duplicate: string } } = {
    labels: { admitted: 'à bord', duplicate: 'Déjà à bord' },

    present: async (tickets) => {
      const ids = [...new Map(tickets.map((t) => [t.eventId.toHexString(), t.eventId])).values()];
      const deps = await this.departures.find({ _id: { $in: ids } }).toArray();
      const cards = await this.organizations.cards([...new Map(deps.map((d) => [d.orgId.toHexString(), d.orgId])).values()]);
      const out = new Map<string, { event: import('../ticketing/index.js').EventSummary; details: Record<string, unknown> }>();
      for (const t of tickets) {
        const d = deps.find((x) => x._id.equals(t.eventId))!;
        const org = cards.get(d.orgId.toHexString())!;
        const pickup = d.pickups.find((s) => s.stopId === t.details.pickupStopId) ?? d.pickups[0]!;
        const dropoff = d.dropoffs.find((s) => s.stopId === t.details.dropoffStopId) ?? lastStop(d);
        out.set(t._id.toHexString(), {
          event: {
            id: d._id.toHexString(), kind: 'caravan_seat', title: `${d.from} → ${d.to}`, startsAt: d.departureAt.toISOString(), status: d.status,
            organizer: { id: org.id, name: org.name, category: org.category, level: org.level, rating: org.rating, trips: org.trips },
          },
          details: {
            departureId: d._id.toHexString(),
            direction: d.direction,
            from: d.from,
            to: d.to,
            pickup: stopView(pickup),
            dropoff: stopView(dropoff),
            vehicle: { label: d.vehicle.label, plate: d.vehicle.plate, airConditioned: d.vehicle.airConditioned },
            confirmed: d.status === 'confirmed' || d.status === 'departed' || d.status === 'completed',
            minPassengers: d.minPassengers,
            seatsBooked: d.seatsConfirmed,
            confirmBy: d.confirmBy.toISOString(),
          },
        });
      }
      return out;
    },

    cancellationQuote: async (t, now) => {
      const d = await this.departures.findOne({ _id: t.eventId });
      if (!d || d.status === 'cancelled') return { allowed: false, reason: 'Ce départ est annulé : tu es remboursé automatiquement.' };
      if (t.admittedAt) return { allowed: false, reason: 'Tu es déjà monté dans le bus.' };
      if (now >= d.departureAt || d.status === 'departed' || d.status === 'completed') return { allowed: false, reason: 'Le bus est parti : annulation impossible.' };
      const free = d.departureAt.getTime() - now.getTime() >= FREE_CANCEL_MS;
      const fee = free ? 0 : Math.round(t.price * LATE_CANCEL_FEE);
      return { allowed: true, fee, refund: t.price - fee, freeUntil: free ? new Date(d.departureAt.getTime() - FREE_CANCEL_MS).toISOString() : null };
    },

    onCancelled: async (t, session) => {
      const now = this.clock.now();
      const b = await this.bookings.findOneAndUpdate(
        { _id: t.source.id, status: 'confirmed' },
        { $set: { status: 'cancelled', seatActive: false, countsForLimit: false, updatedAt: now } },
        { session },
      );
      if (b) await this.departures.updateOne({ _id: t.eventId }, { $inc: { seatsTaken: -1, seatsConfirmed: -1 }, $set: { updatedAt: now } }, { session });
    },

    transferDeadline: async (t) => {
      const d = await this.departures.findOne({ _id: t.eventId }, { projection: { departureAt: 1 } });
      return new Date((d?.departureAt.getTime() ?? 0) - TRANSFER_CUTOFF_MS);
    },

    refuseRecipient: async (t, recipientId, session) => {
      const paying = await this.bookings.findOne({ departureId: t.eventId, userId: recipientId, status: 'held', forSelf: true }, { session });
      return paying ? 'Ton ami est en train d’acheter sa propre place pour ce départ.' : null;
    },

    checkAdmission: async (t, { locationId, now }) => {
      const d = await this.departures.findOne({ _id: t.eventId });
      if (!d || d.status === 'cancelled') return { ok: false, reason: 'event_cancelled', message: 'Ce départ est annulé.' };
      const opens = new Date(d.pickups[0]!.at.getTime() - BOARDING_OPENS_MS);
      if (now < opens) return { ok: false, reason: 'too_early', message: `L’embarquement ouvre le ${dakar.format(opens)}.` };
      if (now > new Date(lastStop(d).at.getTime() + BOARDING_GRACE_MS)) return { ok: false, reason: 'too_late', message: 'Ce trajet est terminé.' };
      const booked = d.pickups.find((s) => s.stopId === t.details.pickupStopId);
      const dropoff = d.dropoffs.find((s) => s.stopId === t.details.dropoffStopId);
      // Where the bus is: the stop given by the scanner, else the first pickup it hasn't left.
      const here = d.pickups.find((s) => s.stopId === locationId) ?? d.pickups.find((s) => !d.stopsLeft.some((l) => l.stopId === s.stopId));
      const elsewhere = here && booked && here.stopId !== booked.stopId;
      return {
        ok: true,
        warning: elsewhere ? `Monte à ${here.place} au lieu de ${booked.place}.` : null,
        notes: [
          dropoff ? `Descend à ${dropoff.place}.` : '',
          elsewhere ? '' : t.passenger ? 'Vérifie le nom sur sa pièce d’identité.' : 'Vérifie le nom sur sa carte étudiant.',
        ].filter(Boolean),
      };
    },

    openForAdmission: async (orgId, now) => {
      const deps = await this.departures
        .find({ orgId, status: { $in: [...RUNNING] }, departureAt: { $lte: new Date(now.getTime() + BOARDING_OPENS_MS), $gte: new Date(now.getTime() - 2 * 24 * HOUR) } }, { projection: { _id: 1, dropoffs: 1 } })
        .toArray();
      return deps.filter((d) => now.getTime() <= d.dropoffs[d.dropoffs.length - 1]!.at.getTime() + BOARDING_GRACE_MS).map((d) => d._id);
    },

    orgOf: async (eventId) => (await this.departures.findOne({ _id: eventId }, { projection: { orgId: 1 } }))?.orgId ?? null,
  };

  // ---- Organizer: the day of the trip ("Mes activités", passenger list, stops) ---------------------------------

  private async ownDeparture(orgId: ObjectId, id: ObjectId, session?: ClientSession) {
    const d = await this.departures.findOne({ _id: id, orgId }, { session });
    // Another organizer's departure: 404, its existence isn't revealed.
    if (!d) throw errors.notFound('Départ introuvable.');
    return d;
  }

  /** Upcoming (to run, running) or past departures, with booked / on-board counts. */
  async activities(orgId: ObjectId, scope: 'upcoming' | 'past') {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - 12 * HOUR);
    const docs = await this.departures
      .find(
        scope === 'upcoming'
          ? { orgId, status: { $in: ['draft', ...RUNNING] }, departureAt: { $gte: cutoff } }
          : { orgId, $or: [{ status: { $in: ['cancelled', 'completed'] } }, { departureAt: { $lt: cutoff } }] },
      )
      .sort({ departureAt: scope === 'upcoming' ? 1 : -1 })
      .limit(100)
      .toArray();
    return this.orgViews(docs);
  }

  /** The stops someone boards or gets off at (held or paid seats): they can't be removed. */
  private async bookedStops(departureIds: ObjectId[], session?: ClientSession) {
    const seats = await this.bookings.find({ departureId: { $in: departureIds }, seatActive: true }, { projection: { departureId: 1, pickupStopId: 1, dropoffStopId: 1 }, session }).toArray();
    const out = new Map<string, Set<string>>();
    for (const b of seats) {
      const set = out.get(b.departureId.toHexString()) ?? new Set<string>();
      set.add(b.pickupStopId).add(b.dropoffStopId);
      out.set(b.departureId.toHexString(), set);
    }
    return out;
  }

  async orgViews(docs: DepartureDoc[]) {
    const counts = await this.ticketing.counts(docs.map((d) => d._id));
    const booked = await this.bookedStops(docs.map((d) => d._id));
    const cards = await this.organizations.cards([...new Map(docs.map((d) => [d.orgId.toHexString(), d.orgId])).values()]);
    const now = this.clock.now();
    // After departure: what the owner can collect, and the payout once asked for.
    const claims = new Map<string, { amount: number; payout: { id: string; status: string; amount: number } | null }>();
    for (const d of docs.filter((x) => x.status === 'departed' || x.status === 'completed')) {
      const { tickets, fees } = await this.ticketing.revenue(d._id);
      const payout = d.claimPayoutId ? await this.payments.findPayout(d.claimPayoutId) : null;
      claims.set(d._id.toHexString(), { amount: tickets + fees, payout: payout ? { id: payout._id.toHexString(), status: payout.status, amount: payout.amount } : null });
    }
    return docs.map((d) => ({
      ...this.publicView(d, cards.get(d.orgId.toHexString())!, now),
      vehicle: { label: d.vehicle.label, plate: d.vehicle.plate, airConditioned: d.vehicle.airConditioned },
      vehicleId: d.vehicleId.toHexString(),
      bookedStopIds: [...(booked.get(d._id.toHexString()) ?? [])],
      bookingClosesAt: d.bookingClosesAt.toISOString(),
      stopsLeft: d.stopsLeft.map((s) => ({ stopId: s.stopId, at: s.at.toISOString() })),
      counts: counts.get(d._id.toHexString()) ?? { booked: 0, buyers: 0, admitted: 0 },
      cancellation: d.cancellation ? { at: d.cancellation.at.toISOString(), reason: d.cancellation.reason } : null,
      claim: claims.get(d._id.toHexString()) ?? null,
    }));
  }

  async orgDeparture(orgId: ObjectId, id: ObjectId) {
    return (await this.orgViews([await this.ownDeparture(orgId, id)]))[0]!;
  }

  /**
   * The driver's list: every valid ticket with the traveller's name (checked against the student card, or an ID for a
   * companion) and phone (to call a late passenger), grouped by purchaser ("Moussa D. · 2 billets"). Members of the
   * organization only; access is audited by the route.
   */
  async manifest(orgId: ObjectId, id: ObjectId) {
    const d = await this.ownDeparture(orgId, id);
    const tickets = await this.ticketing.activeTickets(d._id);
    const people = [...new Map(tickets.flatMap((t) => [t.holderUserId, t.purchaserUserId]).map((u) => [u.toHexString(), u])).values()];
    const [contacts, admitted] = await Promise.all([this.accounts.contactsByIds(people), this.ticketing.admittedTicketIds(d._id)]);
    const nameOf = (u: ObjectId) => {
      const c = contacts.get(u.toHexString());
      return c ? `${c.firstName} ${c.lastName}` : 'Passager';
    };
    const groupSize = new Map<string, number>();
    for (const t of tickets) groupSize.set(t.purchaserUserId.toHexString(), (groupSize.get(t.purchaserUserId.toHexString()) ?? 0) + 1);
    return {
      departure: (await this.orgViews([d]))[0]!,
      passengers: tickets.map((t) => {
        const holder = contacts.get(t.holderUserId.toHexString());
        const a = admitted.get(t._id.toHexString());
        return {
          ticketId: t._id.toHexString(),
          code: t.code,
          seat: t.seat,
          name: t.passenger?.name ?? nameOf(t.holderUserId),
          phone: t.passenger ? localPhone(t.passenger.phone) : holder ? localPhone(holder.phone) : '',
          pickupStopId: String(t.details.pickupStopId),
          dropoffStopId: String(t.details.dropoffStopId),
          admitted: !!a,
          admittedAt: a?.at.toISOString() ?? null,
          /** Received by transfer: the driver checks who shows up. */
          transferred: !t.holderUserId.equals(t.purchaserUserId),
          /** Companion ticket: booked by the holder for this person (no account), checked against an ID. */
          companionOf: t.passenger ? nameOf(t.holderUserId) : null,
          /** Seats bought by the same student are shown together. */
          purchaser: { id: t.purchaserUserId.toHexString(), name: nameOf(t.purchaserUserId) },
          groupSize: groupSize.get(t.purchaserUserId.toHexString()) ?? 1,
        };
      }),
    };
  }

  /**
   * Everything a scanner needs to keep working without network (between towns): the passenger list, each
   * ticket's current version (older QR codes are refused) and the public key that checks QR signatures.
   * Scans made offline are sent later to /admissions/batch; the server stays the final judge.
   */
  async offlinePack(orgId: ObjectId, id: ObjectId) {
    const manifest = await this.manifest(orgId, id);
    const tickets = await this.ticketing.activeTickets(id);
    return {
      generatedAt: this.clock.now().toISOString(),
      key: await this.ticketing.verificationKey(),
      versions: Object.fromEntries(tickets.map((t) => [t._id.toHexString(), t.version])),
      codes: Object.fromEntries(tickets.map((t) => [t.code, t._id.toHexString()])),
      // Paid in cash and not collected yet: what the scanner asks for offline too.
      cash: Object.fromEntries(tickets.filter((t) => t.paidWith === 'cash' && !t.cashCollectedAt).map((t) => [t._id.toHexString(), t.price])),
      manifest,
    };
  }

  /**
   * "Le bus repart de cet arrêt": whoever was due here and wasn't scanned is absent. Leaving the first pickup
   * means the trip has started (status `departed`).
   */
  async leaveStop(orgId: ObjectId, id: ObjectId, stopId: string, userId: ObjectId, leftAt?: Date) {
    const d = await this.ownDeparture(orgId, id);
    if (!(RUNNING as readonly string[]).includes(d.status)) throw errors.conflict('DEPARTURE_NOT_RUNNING', 'Ce départ n’est pas en cours.');
    if (!d.pickups.some((s) => s.stopId === stopId)) throw errors.validation('Arrêt inconnu sur ce trajet.', { field: 'stopId' });
    const now = this.clock.now();
    // Sent later from a phone that was offline: when it really happened (never in the future).
    const at = leftAt && leftAt < now ? leftAt : now;
    const first = d.pickups[0]!.stopId === stopId;
    await this.departures.updateOne(
      { _id: d._id, 'stopsLeft.stopId': { $ne: stopId } },
      {
        $push: { stopsLeft: { stopId, at, by: userId } },
        $set: { updatedAt: now, ...(first && d.status !== 'departed' ? { status: 'departed', departedAt: at } : {}) },
      },
    );
    const tickets = (await this.ticketing.activeTickets(d._id)).filter((t) => t.details.pickupStopId === stopId);
    const admitted = await this.ticketing.admittedTicketIds(d._id);
    await this.hub.publish(`event:${d._id.toHexString()}`, 'departure.updated', { stopId });
    return { absent: tickets.filter((t) => !admitted.has(t._id.toHexString())).map((t) => ({ ticketId: t._id.toHexString(), seat: t.seat })) };
  }

  // ---- Organizer: vehicles and departures (organizer space of the app) -------------------------------------------

  async createVehicle(orgId: ObjectId, input: { label: string; plate?: string | null; airConditioned?: boolean; capacity: number; seatsPerRow?: number; blockedSeats?: number[] }) {
    const plate = input.plate?.trim() ? input.plate.trim().toUpperCase().replace(/\s+/g, '-') : null;
    const blocked = [...new Set(input.blockedSeats ?? [])].filter((n) => n >= 1 && n <= input.capacity);
    const now = this.clock.now();
    const doc: VehicleDoc = {
      _id: new ObjectId(), orgId, label: input.label.trim(), plate, airConditioned: !!input.airConditioned, capacity: input.capacity, seatsPerRow: input.seatsPerRow ?? 4,
      blockedSeats: blocked, status: 'active', createdAt: now, updatedAt: now,
    };
    try {
      await this.vehicles.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err, 'plate_unique_when_set')) throw errors.conflict('PLATE_TAKEN', 'Ce véhicule est déjà enregistré.');
      throw err;
    }
    return doc;
  }

  /**
   * Name, seats, air conditioning. Drafts take the change; published departures keep the vehicle they were sold with
   * (seats already sold on that seat map).
   */
  async updateVehicle(orgId: ObjectId, id: ObjectId, input: { label: string; capacity: number; airConditioned: boolean; seatsPerRow?: number }) {
    const v = await this.vehicles.findOne({ _id: id, orgId, status: 'active' });
    if (!v) throw errors.notFound('Véhicule introuvable.');
    const now = this.clock.now();
    const set = { label: input.label.trim(), capacity: input.capacity, airConditioned: input.airConditioned, seatsPerRow: input.seatsPerRow ?? v.seatsPerRow, blockedSeats: v.blockedSeats.filter((n) => n <= input.capacity) };
    await this.vehicles.updateOne({ _id: id }, { $set: { ...set, updatedAt: now } });
    const updated = { ...v, ...set };
    await this.departures.updateMany(
      { vehicleId: id, status: 'draft' },
      { $set: { vehicle: { label: updated.label, plate: updated.plate, airConditioned: updated.airConditioned, capacity: updated.capacity, seatsPerRow: updated.seatsPerRow, blockedSeats: updated.blockedSeats }, updatedAt: now } },
    );
    return updated;
  }

  /** Out of the list (kept for past trips). Not while a departure still planned uses it. */
  async retireVehicle(orgId: ObjectId, id: ObjectId) {
    const v = await this.vehicles.findOne({ _id: id, orgId, status: 'active' });
    if (!v) throw errors.notFound('Véhicule introuvable.');
    const planned = await this.departures.countDocuments({ vehicleId: id, status: { $in: ['draft', ...RUNNING] } });
    if (planned) {
      throw errors.conflict(
        'VEHICLE_IN_USE',
        `Ce véhicule a ${planned} départ${planned > 1 ? 's prévus' : ' prévu'} (brouillons compris). Annule-${planned > 1 ? 'les' : 'le'} ou change de véhicule d’abord.`,
      );
    }
    await this.vehicles.updateOne({ _id: id }, { $set: { status: 'retired', updatedAt: this.clock.now() } });
  }

  listVehicles(orgId: ObjectId) {
    return this.vehicles.find({ orgId, status: 'active' }).sort({ label: 1 }).toArray();
  }

  /** A draft: nothing is sold until it's published. */
  async createDeparture(orgId: ObjectId, input: NewDeparture) {
    const vehicle = await this.vehicles.findOne({ _id: new ObjectId(input.vehicleId), orgId, status: 'active' });
    if (!vehicle) throw errors.validation('Véhicule inconnu.', { field: 'vehicleId' });
    const fields = this.departureFields(vehicle, input);
    const now = this.clock.now();
    const doc: DepartureDoc = {
      _id: new ObjectId(), code: `${input.from.slice(0, 2).toUpperCase().replace(/[^A-Z]/g, 'X')}${randomCode(5)}`, orgId, vehicleId: vehicle._id, ...fields,
      status: 'draft', seatsTaken: 0, seatsConfirmed: 0, stopsLeft: [], cancellation: null, confirmedAt: null, departedAt: null, completedAt: null,
      claimPayoutId: null, createdAt: now, updatedAt: now,
    };
    await this.departures.insertOne(doc);
    return doc;
  }

  private departureFields(vehicle: VehicleDoc, input: NewDeparture) {
    const toStops = (list: StopInput[], prefix: string) =>
      list.map((s, i) => ({ stopId: `${prefix}${i + 1}`, place: s.place.trim().replace(/\s+/g, ' '), at: new Date(s.at) }));
    const pickups = toStops(input.pickups, 'p');
    const dropoffs = toStops(input.dropoffs, 'd');
    const route = [...pickups, ...dropoffs];
    if (route.some((s) => Number.isNaN(s.at.getTime()))) throw errors.validation('Heure d’arrêt invalide.', { field: 'pickups' });
    if (route.some((s, i) => i > 0 && s.at < route[i - 1]!.at)) throw errors.validation('Les arrêts doivent être dans l’ordre du trajet.', { field: 'pickups' });
    const departureAt = pickups[0]!.at;
    if (departureAt.getTime() < this.clock.now().getTime() + HOUR) throw errors.rule('DEPARTURE_TOO_SOON', 'Le départ doit être dans plus d’une heure.');
    const seats = vehicle.capacity - vehicle.blockedSeats.length;
    if (input.minPassengers > seats) throw errors.validation(`Le minimum dépasse les ${seats} places du véhicule.`, { field: 'minPassengers' });
    const confirmBy = input.confirmBy ? new Date(input.confirmBy) : new Date(departureAt.getTime() - 24 * HOUR);
    const bookingClosesAt = input.bookingClosesAt ? new Date(input.bookingClosesAt) : new Date(departureAt.getTime() - BOOKING_CLOSE_MIN * MIN);
    if (confirmBy > departureAt || bookingClosesAt > departureAt) throw errors.validation('Les échéances doivent précéder le départ.', { field: 'confirmBy' });
    return {
      vehicle: { label: vehicle.label, plate: vehicle.plate, airConditioned: vehicle.airConditioned, capacity: vehicle.capacity, seatsPerRow: vehicle.seatsPerRow, blockedSeats: vehicle.blockedSeats },
      direction: input.direction,
      from: input.from.trim(),
      to: input.to.trim(),
      pickups,
      dropoffs,
      departureAt,
      price: input.price,
      maxSeatsPerStudent: input.maxSeatsPerStudent ?? DEFAULT_MAX_SEATS_PER_STUDENT,
      paymentMethods: input.paymentMethods?.length ? [...new Set(input.paymentMethods)] : [...PAYMENT_METHODS],
      minPassengers: input.minPassengers,
      confirmBy,
      bookingClosesAt,
    };
  }

  /** Drafts only: once published, price, stops and seats are what people paid for. */
  async updateDeparture(orgId: ObjectId, id: ObjectId, input: NewDeparture) {
    const d = await this.ownDeparture(orgId, id);
    if (d.status !== 'draft') throw errors.conflict('DEPARTURE_PUBLISHED', 'Un départ publié ne se modifie plus : annule-le et crée-en un autre.');
    const vehicle = await this.vehicles.findOne({ _id: new ObjectId(input.vehicleId), orgId, status: 'active' });
    if (!vehicle) throw errors.validation('Véhicule inconnu.', { field: 'vehicleId' });
    await this.departures.updateOne({ _id: id, status: 'draft' }, { $set: { ...this.departureFields(vehicle, input), vehicleId: vehicle._id, updatedAt: this.clock.now() } });
    return this.ownDeparture(orgId, id);
  }

  /**
   * A published departure, before the bus leaves: only what can't hurt someone who already booked. Stops can be added
   * (never removed or moved: a student boards or gets off there), not before the departure; the bus can be swapped for
   * one with as many seats or more (every seat sold keeps its number).
   */
  async extendDeparture(orgId: ObjectId, id: ObjectId, input: { pickups?: StopInput[]; dropoffs?: StopInput[]; vehicleId?: string; remove?: string[] }) {
    const d = await this.ownDeparture(orgId, id);
    const now = this.clock.now();
    if (d.status === 'draft') throw errors.conflict('DEPARTURE_DRAFT', 'Ce départ est un brouillon : modifie-le directement.');
    if (!(d.status === 'published' || d.status === 'confirmed') || d.departureAt <= now) throw errors.conflict('DEPARTURE_LOCKED', 'Ce départ ne peut plus être modifié (parti, terminé ou annulé).');
    const clean = (place: string) => place.trim().replace(/\s+/g, ' ');
    const added = (list: StopInput[] | undefined, prefix: string, existing: Stop[]) => {
      let next = Math.max(0, ...[...d.pickups, ...d.dropoffs].filter((x) => x.stopId.startsWith(prefix)).map((x) => Number(x.stopId.slice(1)) || 0));
      return (list ?? []).map((x) => {
        const at = new Date(x.at);
        if (Number.isNaN(at.getTime())) throw errors.validation('Heure d’arrêt invalide.', { field: prefix === 'p' ? 'pickups' : 'dropoffs' });
        const place = clean(x.place);
        if (existing.some((e) => e.place.toLowerCase() === place.toLowerCase())) throw errors.validation(`« ${place} » est déjà un arrêt de ce départ.`, { field: prefix === 'p' ? 'pickups' : 'dropoffs' });
        return { stopId: `${prefix}${++next}`, place, at };
      });
    };
    // Removing: only a stop nobody boards or gets off at, never the departure itself, and one drop-off at least stays.
    const remove = new Set(input.remove ?? []);
    if (remove.size) {
      const known = new Set([...d.pickups, ...d.dropoffs].map((x) => x.stopId));
      if ([...remove].some((x) => !known.has(x))) throw errors.validation('Arrêt inconnu.', { field: 'remove' });
      if (remove.has(d.pickups[0]!.stopId)) throw errors.validation('Le point de départ ne se retire pas : annule le départ si besoin.', { field: 'remove' });
      const booked = (await this.bookedStops([id])).get(id.toHexString()) ?? new Set<string>();
      const blocked = [...d.pickups, ...d.dropoffs].filter((x) => remove.has(x.stopId) && booked.has(x.stopId));
      if (blocked.length) throw errors.conflict('STOP_BOOKED', `Des étudiants ont réservé à « ${blocked[0]!.place} » : cet arrêt reste.`);
    }
    const keep = (list: Stop[]) => list.filter((x) => !remove.has(x.stopId));
    const pickups = [...keep(d.pickups), ...added(input.pickups, 'p', keep(d.pickups))].sort((a, b) => a.at.getTime() - b.at.getTime());
    const dropoffs = [...keep(d.dropoffs), ...added(input.dropoffs, 'd', keep(d.dropoffs))].sort((a, b) => a.at.getTime() - b.at.getTime());
    if (!dropoffs.length) throw errors.validation('Garde au moins une descente.', { field: 'remove' });
    if (pickups.length > 15 || dropoffs.length > 15) throw errors.validation('15 arrêts au plus de chaque côté.', { field: 'pickups' });
    // The departure stays when it was announced: a new pickup comes after the first one.
    if (pickups[0]!.stopId !== d.pickups[0]!.stopId) throw errors.validation('Une nouvelle montée doit être après le départ.', { field: 'pickups' });
    if (pickups[pickups.length - 1]!.at > dropoffs[0]!.at) throw errors.validation('Les montées doivent précéder les descentes.', { field: 'dropoffs' });

    let vehicle = d.vehicle;
    let vehicleId = d.vehicleId;
    if (input.vehicleId && input.vehicleId !== d.vehicleId.toHexString()) {
      const v = await this.vehicles.findOne({ _id: new ObjectId(input.vehicleId), orgId, status: 'active' });
      if (!v) throw errors.validation('Véhicule inconnu.', { field: 'vehicleId' });
      const highest = (await this.bookings.find({ departureId: id, seatActive: true }, { projection: { seat: 1 } }).sort({ seat: -1 }).limit(1).toArray())[0]?.seat ?? 0;
      const seats = v.capacity - v.blockedSeats.length;
      if (seats < sellable(d.vehicle) || v.capacity < highest) throw errors.validation(`Choisis un véhicule d’au moins ${sellable(d.vehicle)} places : on ne retire pas de places à un départ publié.`, { field: 'vehicleId' });
      if (v.blockedSeats.some((n) => n <= highest && n > 0)) {
        const taken = new Set((await this.bookings.find({ departureId: id, seatActive: true }, { projection: { seat: 1 } }).toArray()).map((b) => b.seat));
        if (v.blockedSeats.some((n) => taken.has(n))) throw errors.validation('Une place déjà vendue n’existe pas dans ce véhicule.', { field: 'vehicleId' });
      }
      vehicle = { label: v.label, plate: v.plate, airConditioned: v.airConditioned, capacity: v.capacity, seatsPerRow: v.seatsPerRow, blockedSeats: v.blockedSeats };
      vehicleId = v._id;
    }
    await this.departures.updateOne({ _id: id, status: d.status }, { $set: { pickups, dropoffs, vehicle, vehicleId, updatedAt: now } });
    await this.hub.publish(`event:${id.toHexString()}`, 'departure.updated', {});
    return this.ownDeparture(orgId, id);
  }

  async publish(orgId: ObjectId, id: ObjectId) {
    const d = await this.ownDeparture(orgId, id);
    const now = this.clock.now();
    if (d.status !== 'draft') throw errors.conflict('DEPARTURE_PUBLISHED', 'Ce départ est déjà publié.');
    if (d.bookingClosesAt <= now) throw errors.rule('DEPARTURE_TOO_SOON', 'Trop tard pour publier ce départ.');
    await this.departures.updateOne({ _id: id, status: 'draft' }, { $set: { status: d.minPassengers === 0 ? 'confirmed' : 'published', updatedAt: now } });
    return this.ownDeparture(orgId, id);
  }

  /** Before the bus leaves. Every ticket is cancelled and refunded 100 %; unpaid holds are released. */
  async cancelDeparture(orgId: ObjectId | null, id: ObjectId, by: 'organizer' | 'system', reason: string) {
    const payoutIds: ObjectId[] = [];
    await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const d = await this.departures.findOneAndUpdate(
        { _id: id, ...(orgId ? { orgId } : {}), status: { $in: ['draft', 'published', 'confirmed'] } },
        { $set: { status: 'cancelled', cancellation: { at: now, by, reason }, updatedAt: now } },
        { returnDocument: 'after', session },
      );
      if (!d) {
        if (orgId) await this.ownDeparture(orgId, id, session);
        throw errors.conflict('DEPARTURE_NOT_CANCELLABLE', 'Ce départ ne peut plus être annulé (parti, terminé ou déjà annulé).');
      }
      payoutIds.push(...(await this.ticketing.cancelAllForEvent(d._id, by === 'system' ? 'min_not_reached' : 'event_cancelled', session)));
      const held = await this.bookings.find({ departureId: d._id, status: 'held' }, { session }).toArray();
      for (const b of held) if (b.paymentId) await this.payments.cancelInSession(b.paymentId, session);
      await this.bookings.updateMany(
        { departureId: d._id, status: 'held' },
        { $set: { status: 'cancelled', seatActive: false, countsForLimit: false, updatedAt: now } },
        { session },
      );
      await this.departures.updateOne({ _id: d._id }, { $set: { seatsTaken: 0, seatsConfirmed: 0 } }, { session });
    });
    await this.payments.schedulePayouts(payoutIds);
    return { refunded: payoutIds.length };
  }

  /**
   * After departure the organizer collects the paid seats (and fees kept on late cancellations) on the
   * organization's payout number. Once per departure.
   */
  async claim(orgId: ObjectId, id: ObjectId, userId: ObjectId, method: PaymentMethod): Promise<PayoutDoc> {
    const phone = await this.organizations.payoutPhone(orgId, method);
    if (!phone) throw errors.rule('NO_PAYOUT_ACCOUNT', 'Aucun numéro de paiement pour l’organisation. Demande à l’équipe UGB Connect de l’enregistrer.');
    let payout!: PayoutDoc;
    await withTransaction(this.mongo, async (session) => {
      const d = await this.ownDeparture(orgId, id, session);
      if (!(d.status === 'departed' || d.status === 'completed')) throw errors.conflict('DEPARTURE_NOT_DEPARTED', 'Tu pourras récupérer l’argent une fois le bus parti.');
      const { tickets, fees } = await this.ticketing.revenue(d._id, session);
      if (tickets + fees <= 0) throw errors.rule('NOTHING_TO_CLAIM', 'Aucun billet payé sur ce départ.');
      payout = await this.payments.createPayout(
        {
          kind: 'organizer_claim', beneficiaryUserId: userId, payTo: { orgId, phone }, method, amount: tickets + fees, reason: 'event_claim',
          source: { type: 'caravan_departure', id: d._id }, idempotencyKey: `caravan:${d._id.toHexString()}:claim`,
        },
        session,
      );
      await this.departures.updateOne({ _id: d._id }, { $set: { claimPayoutId: payout._id } }, { session });
    });
    await this.payments.schedulePayouts([payout._id]);
    return payout;
  }

  // ---- Worker --------------------------------------------------------------------------------------------------

  /**
   * - Minimum not reached at `confirmBy`: cancelled, everyone refunded 100 %.
   * - Departed and past arrival: completed, counted in the organizer's trips.
   */
  async sweep() {
    const now = this.clock.now();
    const short = await this.departures.find({ status: 'published', confirmBy: { $lte: now } }, { projection: { _id: 1, seatsConfirmed: 1, minPassengers: 1 } }).toArray();
    for (const d of short) {
      if (d.seatsConfirmed >= d.minPassengers) await this.departures.updateOne({ _id: d._id, status: 'published' }, { $set: { status: 'confirmed', confirmedAt: now } });
      else await this.cancelDeparture(null, d._id, 'system', 'Minimum de passagers non atteint');
    }
    const done = await this.departures.find({ status: 'departed' }).toArray();
    for (const d of done.filter((x) => lastStop(x).at.getTime() + BOARDING_GRACE_MS <= now.getTime())) {
      const res = await this.departures.updateOne({ _id: d._id, status: 'departed' }, { $set: { status: 'completed', completedAt: now } });
      if (res.modifiedCount) await this.organizations.countTrip(d.orgId);
    }
    return short.length;
  }
}

