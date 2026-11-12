import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Config } from '../../config/env.js';
import type { Clock } from '../../platform/clock.js';
import { isDuplicateKey, withTransaction } from '../../platform/db/mongo.js';
import { AppError, errors } from '../../platform/http/errors.js';
import { hmac } from '../../platform/security/crypto.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { AccountsApi } from '../accounts/index.js';
import type { ConversationMember, MessagingApi } from '../messaging/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { PaymentMethod, PaymentsApi, PayoutDoc, PurposeHandler } from '../payments/index.js';
import {
  TAXI_CHAT_HOURS,
  TAXI_DEPARTURE,
  TAXI_GRACE_MIN,
  TAXI_HOLD_MIN,
  TAXI_LOCK_MIN,
  TAXI_STRIKE_WINDOW_DAYS,
  TAXI_STRIKES_LIMIT,
  TAXI_SUSPENSION_DAYS,
  type TaxiParticipantDoc,
  type TaxiStrikeDoc,
  type TaxiTripDoc,
} from './taxi.types.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** What each passenger pays: the fare split as if the taxi were full, rounded up to 50 FCFA. */
export const seatPriceOf = (fare: number, seats: number) => Math.ceil(fare / seats / 50) * 50;

/**
 * Seats lock `lockMinutes` before departure, as the organizer chose ("non remboursable 20 minutes avant le départ").
 * Without a choice, 10 minutes, but never earlier than half-way: the people who join a "dans 15 min" trip still get a
 * window to change their mind.
 */
export const lockTimeOf = (createdAt: Date, departureAt: Date, lockMinutes?: number) =>
  lockMinutes !== undefined
    ? new Date(departureAt.getTime() - lockMinutes * MIN)
    : new Date(Math.max(departureAt.getTime() - TAXI_LOCK_MIN * MIN, createdAt.getTime() + (departureAt.getTime() - createdAt.getTime()) / 2));

const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');
const dakar = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Dakar', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export type NewTrip = { from: string; to: string; seats: number; fare: number; departureAt?: string; leaveInMinutes?: number; lockMinutes?: number };

export type Standing = { strikes: number; limit: number; suspendedUntil: Date | null };

export type TripView = {
  id: string;
  /** Seats paid in the app; false: a reservation, the fare settled in the taxi. */
  payOnline: boolean;
  from: string;
  to: string;
  departureAt: string;
  lockAt: string;
  chatClosesAt: string;
  seats: number;
  seatsTaken: number;
  fare: number;
  seatPrice: number;
  status: TaxiTripDoc['status'];
  organizer: Person & { trips: number; lateCancels: number };
  passengers: (Person & { role: 'organizer' | 'passenger'; checkedIn: boolean })[];
  vehicle: string | null;
  /** The trip chat, for the people in it (organizer, paid passengers, late leavers). */
  conversationId: string | null;
  me: {
    key: string;
    role: 'organizer' | 'passenger';
    status: TaxiParticipantDoc['status'];
    checkedIn: boolean;
    forfeited: boolean;
    payment: { reference: string; checkoutUrl: string | null; expiresAt: string } | null;
  } | null;
  claim: { amount: number; payout: { id: string; status: PayoutDoc['status']; amount: number } | null } | null;
};
type Person = { key: string; name: string; initials: string };

const tripClosed = () => errors.conflict('TRIP_CLOSED', 'Ce trajet n’est plus ouvert.');
const notIn = () => errors.notFound('Tu n’es pas dans ce trajet.');

export class TaxiService {
  private readonly trips: Collection<TaxiTripDoc>;
  private readonly participants: Collection<TaxiParticipantDoc>;
  private readonly strikes: Collection<TaxiStrikeDoc>;

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly config: Config,
    private readonly accounts: AccountsApi,
    private readonly payments: PaymentsApi,
    private readonly messaging: MessagingApi,
    private readonly limiter: Limiter,
    private readonly notifications: NotificationsApi,
  ) {
    this.trips = db.collection('taxiTrips');
    this.participants = db.collection('taxiParticipants');
    this.strikes = db.collection('taxiStrikes');
  }

  /**
   * Stable pseudonym of a student in Sunu Taxi: lets the app tell people apart (and block someone) across trips
   * without ever seeing their user id or phone.
   */
  personKey(userId: ObjectId) {
    return hmac(this.config.OTP_PEPPER, `taxi-person:${userId.toHexString()}`).slice(0, 16);
  }

  /** "Moussa S." and "MS": how a student appears in lists and in the chat. */
  private identityOf(userId: ObjectId, names: Map<string, { firstName: string; lastName: string }>): Person {
    const n = names.get(userId.toHexString()) ?? { firstName: 'Étudiant', lastName: '' };
    return {
      key: this.personKey(userId),
      name: n.lastName ? `${n.firstName} ${n.lastName[0]}.` : n.firstName,
      initials: `${n.firstName[0] ?? ''}${n.lastName[0] ?? ''}`.toUpperCase(),
    };
  }

  private async firstName(userId: ObjectId) {
    return (await this.accounts.namesByIds([userId])).get(userId.toHexString())?.firstName ?? 'Un étudiant';
  }

  // ---- Trip chat (messaging module) ------------------------------------------------------------------------------

  /**
   * Who is in the trip chat, after every change of membership: the organizer and paid passengers write; a
   * passenger who left after the lock (seat paid) still reads. Closed when the trip is cancelled; read-only
   * 2 h after departure.
   */
  private async syncChat(tripId: ObjectId, session: ClientSession) {
    const trip = await this.trips.findOne({ _id: tripId }, { session });
    if (!trip) return;
    const people = await this.participants.find({ tripId, $or: [{ status: 'joined' }, { forfeited: true }] }, { session }).toArray();
    const names = await this.accounts.namesByIds(people.map((p) => p.userId));
    const members: ConversationMember[] = people.map((p) => ({ userId: p.userId, ...this.identityOf(p.userId, names), role: p.role, canWrite: p.status === 'joined' }));
    await this.messaging.sync(
      'taxi_trip',
      tripId,
      { title: `${trip.from} → ${trip.to}`, url: `/trajet/${tripId.toHexString()}`, members, writableUntil: trip.chatClosesAt, status: trip.status === 'cancelled' ? 'closed' : 'open' },
      session,
    );
  }

  /** Trips created before the chat existed get their conversation (seed / maintenance). Returns how many. */
  async backfillChats() {
    const now = this.clock.now();
    const trips = await this.trips.find({ chatClosesAt: { $gt: now } }, { projection: { _id: 1 } }).toArray();
    const have = await this.messaging.idsFor('taxi_trip', trips.map((t) => t._id));
    const missing = trips.filter((t) => !have.has(t._id.toHexString()));
    for (const t of missing) await withTransaction(this.mongo, (session) => this.syncChat(t._id, session));
    return missing.length;
  }

  private async tellOrganizerJoined(p: TaxiParticipantDoc, session: ClientSession) {
    const trip = await this.trips.findOne({ _id: p.tripId }, { session });
    if (!trip) return;
    await this.notifications.notify(
      [trip.organizerUserId],
      {
        type: 'taxi.joined', category: 'social', icon: 'car-outline', tone: 'success', url: `/taxi/${trip._id.toHexString()}`, dedupeKey: `taxi:${p._id.toHexString()}:joined`,
        title: `${await this.firstName(p.userId)} a rejoint ton trajet`, body: `${trip.from} → ${trip.to} · place payée.`,
      },
      session,
    );
  }

  /** A line from the app in the trip chat, seen by everyone in it. */
  private say(tripId: ObjectId, body: string, session?: ClientSession) {
    return this.messaging.postSystem('taxi_trip', tripId, body, session);
  }

  // ---- Standing: late cancellations and suspension ---------------------------------------------------------------

  async standing(userId: ObjectId): Promise<Standing> {
    const now = this.clock.now();
    const recent = await this.strikes.find({ userId, at: { $gt: new Date(now.getTime() - TAXI_STRIKE_WINDOW_DAYS * DAY) } }).sort({ at: -1 }).toArray();
    let suspendedUntil: Date | null = null;
    const latest = recent[0];
    if (latest) {
      // Suspended for 7 days from the strike that reached 3 within 30 days.
      const inWindow = await this.strikes.countDocuments({ userId, at: { $gt: new Date(latest.at.getTime() - TAXI_STRIKE_WINDOW_DAYS * DAY), $lte: latest.at } });
      const until = new Date(latest.at.getTime() + TAXI_SUSPENSION_DAYS * DAY);
      if (inWindow >= TAXI_STRIKES_LIMIT && until > now) suspendedUntil = until;
    }
    return { strikes: recent.length, limit: TAXI_STRIKES_LIMIT, suspendedUntil };
  }

  private async assertNotSuspended(userId: ObjectId) {
    const { suspendedUntil } = await this.standing(userId);
    if (suspendedUntil) {
      throw new AppError(403, 'TAXI_SUSPENDED', `Sunu Taxi est suspendu jusqu’au ${dakar.format(suspendedUntil)} après ${TAXI_STRIKES_LIMIT} annulations tardives.`, {
        suspendedUntil: suspendedUntil.toISOString(),
      });
    }
  }

  // ---- Create ----------------------------------------------------------------------------------------------------

  /** `replay`: the same trip was just created by this student (a retried request), returned as is. */
  async create(userId: ObjectId, input: NewTrip): Promise<{ trip: TaxiTripDoc; replay: boolean }> {
    await this.limiter.hit(`taxi:create:${userId.toHexString()}`, { limit: 10, windowS: 3600 }, 'Trop de trajets proposés. Réessaie plus tard.');
    await this.assertNotSuspended(userId);
    await this.releaseIfStale(userId);
    const now = this.clock.now();

    if ((input.departureAt === undefined) === (input.leaveInMinutes === undefined)) {
      throw errors.validation('Indique l’heure de départ.', { field: 'departureAt' });
    }
    const departureAt = input.leaveInMinutes !== undefined ? new Date(now.getTime() + input.leaveInMinutes * MIN) : new Date(input.departureAt!);
    if (Number.isNaN(departureAt.getTime())) throw errors.validation('Heure de départ invalide.', { field: 'departureAt' });
    if (departureAt.getTime() < now.getTime() + TAXI_DEPARTURE.minMin * MIN) {
      throw errors.rule('DEPARTURE_TOO_SOON', `Le départ doit être dans ${TAXI_DEPARTURE.minMin} minutes au moins.`);
    }
    if (departureAt.getTime() > now.getTime() + TAXI_DEPARTURE.maxDays * DAY) {
      throw errors.rule('DEPARTURE_TOO_FAR', `Le départ doit être dans les ${TAXI_DEPARTURE.maxDays} prochains jours.`);
    }
    if (input.lockMinutes !== undefined && departureAt.getTime() - input.lockMinutes * MIN <= now.getTime()) {
      throw errors.validation('Le délai sans remboursement doit être plus court que le temps avant le départ.', { field: 'lockMinutes' });
    }
    const from = tidy(input.from);
    const to = tidy(input.to);
    if (from.length < 2) throw errors.validation('Indique le lieu de départ.', { field: 'from' });
    if (to.length < 2) throw errors.validation('Indique la destination.', { field: 'to' });
    if (from.toLowerCase() === to.toLowerCase()) throw errors.validation('Le départ et la destination sont identiques.', { field: 'to' });

    const trip: TaxiTripDoc = {
      _id: new ObjectId(),
      organizerUserId: userId,
      from,
      to,
      departureAt,
      lockAt: lockTimeOf(now, departureAt, input.lockMinutes),
      chatClosesAt: new Date(departureAt.getTime() + TAXI_CHAT_HOURS * 60 * MIN),
      seats: input.seats,
      fare: input.fare,
      seatPrice: seatPriceOf(input.fare, input.seats),
      seatsTaken: 1,
      joinSeq: 0,
      status: 'open',
      vehicle: null,
      departedAt: null,
      cancelledAt: null,
      claimPayoutId: null,
      payOnline: this.config.TAXI_ONLINE_PAYMENT,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await withTransaction(this.mongo, async (session) => {
        await this.trips.insertOne(trip, { session });
        await this.participants.insertOne(
          {
            _id: new ObjectId(), tripId: trip._id, userId, role: 'organizer', status: 'joined', joinOrder: 0, paymentId: null, holdExpiresAt: null,
            joinedAt: now, checkedInAt: null, leftAt: null, forfeited: false, active: true, activeTrip: true, createdAt: now, updatedAt: now,
          },
          { session },
        );
        await this.syncChat(trip._id, session);
        await this.say(trip._id, trip.payOnline ? 'Trajet publié. La discussion est réservée aux passagers qui ont payé leur place.' : 'Trajet publié. La discussion est réservée aux passagers qui ont réservé leur place.', session);
      });
      return { trip, replay: false };
    } catch (err) {
      if (!isDuplicateKey(err, 'user_active_trip_unique')) throw err;
      const current = await this.activeTripOf(userId);
      const same =
        current && current.organizerUserId.equals(userId) && current.from === from && current.to === to && current.seats === trip.seats &&
        current.fare === trip.fare && current.createdAt.getTime() > now.getTime() - 2 * MIN;
      if (same) return { trip: current, replay: true };
      throw this.alreadyInTrip(current);
    }
  }

  /** Whether trips proposed now are paid in the app. */
  get onlinePayment() {
    return this.config.TAXI_ONLINE_PAYMENT;
  }

  /** Trips from before the setting were all paid. */
  private paid(trip: Pick<TaxiTripDoc, 'payOnline'>) {
    return trip.payOnline ?? true;
  }

  private alreadyInTrip(current: TaxiTripDoc | null) {
    return errors.conflict(
      'ALREADY_IN_TRIP',
      current ? `Tu es déjà inscrit sur ${current.from} → ${current.to}. Quitte-le ou attends le départ.` : 'Tu es déjà dans un trajet.',
      current ? { tripId: current._id.toHexString() } : {},
    );
  }

  async activeTripOf(userId: ObjectId): Promise<TaxiTripDoc | null> {
    const p = await this.participants.findOne({ userId, activeTrip: true });
    return p ? this.trips.findOne({ _id: p.tripId }) : null;
  }

  // ---- Join and pay ---------------------------------------------------------------------------------------------

  /**
   * Takes a seat for 10 minutes and opens the payment. The seat counter and the participant are written in one
   * transaction; the unique indexes stop a second seat in the same trip and a second active trip.
   */
  async join(userId: ObjectId, tripId: ObjectId, input: { method?: PaymentMethod; returnUrl?: string | null }, baseUrl: string) {
    await this.limiter.hit(`taxi:join:${userId.toHexString()}`, { limit: 30, windowS: 3600 });
    await this.assertNotSuspended(userId);
    await this.releaseIfStale(userId);
    const target = await this.trips.findOne({ _id: tripId });
    if (target && !this.paid(target)) return { ...(await this.reserve(userId, target)), payment: null };
    if (!input.method) throw errors.validation('Choisis Wave ou Orange Money pour payer ta place.', { field: 'method' });
    const method = input.method;
    await this.payments.assertAvailable(method);
    const returnUrl = this.payments.validateReturnUrl(input.returnUrl);

    // A retry (or coming back to pay): the same hold and the same payment, not a second seat.
    const pending = await this.participants.findOne({ tripId, userId, status: 'pending_payment' });
    if (pending?.paymentId) {
      const payment = await this.payments.findById(pending.paymentId);
      if (payment && (payment.status === 'created' || payment.status === 'pending')) {
        return { trip: (await this.trips.findOne({ _id: tripId }))!, payment: await this.payments.openCheckout(payment, baseUrl), replay: true };
      }
    }

    const trip = await this.trips.findOne({ _id: tripId });
    const now = this.clock.now();
    if (!trip) throw errors.notFound('Trajet introuvable.');
    if (trip.status !== 'open' || trip.departureAt <= now) throw tripClosed();
    const holdExpiresAt = new Date(Math.min(now.getTime() + TAXI_HOLD_MIN * MIN, trip.departureAt.getTime()));

    let result;
    try {
      result = await withTransaction(this.mongo, async (session) => {
        const t = await this.trips.findOneAndUpdate(
          { _id: tripId, status: 'open', departureAt: { $gt: now }, $expr: { $lt: ['$seatsTaken', '$seats'] } },
          { $inc: { seatsTaken: 1, joinSeq: 1 }, $set: { updatedAt: now } },
          { returnDocument: 'after', session },
        );
        if (!t) throw errors.conflict('TRIP_FULL', 'Ce trajet est complet.');
        const participantId = new ObjectId();
        const payment = await this.payments.create(
          { userId, purpose: 'taxi_seat', purposeRef: participantId, amount: t.seatPrice, method, description: `Sunu Taxi · ${t.from} → ${t.to}`, expiresAt: holdExpiresAt, returnUrl },
          session,
        );
        await this.participants.insertOne(
          {
            _id: participantId, tripId, userId, role: 'passenger', status: 'pending_payment', joinOrder: t.joinSeq, paymentId: payment._id, holdExpiresAt,
            joinedAt: null, checkedInAt: null, leftAt: null, forfeited: false, active: true, activeTrip: true, createdAt: now, updatedAt: now,
          },
          { session },
        );
        return { trip: t, payment };
      });
    } catch (err) {
      if (isDuplicateKey(err, 'user_active_trip_unique')) throw this.alreadyInTrip(await this.activeTripOf(userId));
      if (isDuplicateKey(err, 'trip_user_active_unique')) throw errors.conflict('ALREADY_JOINED', 'Tu as déjà une place dans ce trajet.');
      throw err;
    }
    return { trip: result.trip, payment: await this.payments.openCheckout(result.payment, baseUrl), replay: false };
  }

  /**
   * A trip without payment in the app: the seat is taken at once (no hold, nothing to pay here), the organizer is told
   * and the student joins the chat. The fare is settled in the taxi.
   */
  private async reserve(userId: ObjectId, trip: TaxiTripDoc): Promise<{ trip: TaxiTripDoc; replay: boolean }> {
    const now = this.clock.now();
    if (trip.status !== 'open' || trip.departureAt <= now) throw tripClosed();
    const mine = await this.participants.findOne({ tripId: trip._id, userId, active: true });
    if (mine) return { trip, replay: true };
    let result!: TaxiTripDoc;
    try {
      await withTransaction(this.mongo, async (session) => {
        const t = await this.trips.findOneAndUpdate(
          { _id: trip._id, status: 'open', departureAt: { $gt: now }, $expr: { $lt: ['$seatsTaken', '$seats'] } },
          { $inc: { seatsTaken: 1, joinSeq: 1 }, $set: { updatedAt: now } },
          { returnDocument: 'after', session },
        );
        if (!t) throw errors.conflict('TRIP_FULL', 'Ce trajet est complet.');
        const p: TaxiParticipantDoc = {
          _id: new ObjectId(), tripId: trip._id, userId, role: 'passenger', status: 'joined', joinOrder: t.joinSeq, paymentId: null, holdExpiresAt: null,
          joinedAt: now, checkedInAt: null, leftAt: null, forfeited: false, active: true, activeTrip: true, createdAt: now, updatedAt: now,
        };
        await this.participants.insertOne(p, { session });
        await this.syncChat(trip._id, session);
        await this.say(trip._id, `${await this.firstName(userId)} a réservé une place`, session);
        await this.tellOrganizerJoined(p, session);
        result = t;
      });
    } catch (err) {
      if (isDuplicateKey(err, 'user_active_trip_unique')) throw this.alreadyInTrip(await this.activeTripOf(userId));
      if (isDuplicateKey(err, 'trip_user_active_unique')) throw errors.conflict('ALREADY_JOINED', 'Tu as déjà une place dans ce trajet.');
      throw err;
    }
    return { trip: result, replay: false };
  }

  /** Called by payments, inside its transaction, when a seat payment succeeds or ends without money. */
  readonly seatPayment: PurposeHandler = {
    onSucceeded: async (payment, session) => {
      const p = await this.participants.findOne({ _id: payment.purposeRef }, { session });
      if (!p || !p.paymentId?.equals(payment._id)) return 'unfulfillable';
      if (p.status === 'joined') return 'fulfilled';
      const now = this.clock.now();
      if (p.status === 'pending_payment') {
        await this.participants.updateOne(
          { _id: p._id, status: 'pending_payment' },
          { $set: { status: 'joined', joinedAt: now, holdExpiresAt: null, updatedAt: now } },
          { session },
        );
        await this.syncChat(p.tripId, session);
        await this.say(p.tripId, `${await this.firstName(p.userId)} a rejoint le trajet`, session);
        await this.tellOrganizerJoined(p, session);
        return 'fulfilled';
      }
      if (p.status !== 'expired') return 'unfulfillable'; // left on purpose: refunded
      // Paid after the hold ran out: keep the seat if one is still free and the student isn't in another trip.
      const busy = await this.participants.findOne({ $or: [{ userId: p.userId, activeTrip: true }, { tripId: p.tripId, userId: p.userId, active: true }] }, { session });
      if (busy) return 'unfulfillable';
      const t = await this.trips.findOneAndUpdate(
        { _id: p.tripId, status: 'open', departureAt: { $gt: now }, $expr: { $lt: ['$seatsTaken', '$seats'] } },
        { $inc: { seatsTaken: 1 }, $set: { updatedAt: now } },
        { session },
      );
      if (!t) return 'unfulfillable';
      await this.participants.updateOne(
        { _id: p._id, status: 'expired' },
        { $set: { status: 'joined', joinedAt: now, active: true, activeTrip: true, updatedAt: now } },
        { session },
      );
      await this.syncChat(p.tripId, session);
      await this.say(p.tripId, `${await this.firstName(p.userId)} a rejoint le trajet`, session);
      await this.tellOrganizerJoined(p, session);
      return 'fulfilled';
    },
    onClosed: async (payment, session) => {
      const now = this.clock.now();
      const p = await this.participants.findOneAndUpdate(
        { _id: payment.purposeRef, status: 'pending_payment', paymentId: payment._id },
        { $set: { status: 'expired', active: false, activeTrip: false, holdExpiresAt: null, updatedAt: now } },
        { session },
      );
      if (p) await this.trips.updateOne({ _id: p.tripId }, { $inc: { seatsTaken: -1 }, $set: { updatedAt: now } }, { session });
    },
  };

  // ---- Leave, cancel, hand over ---------------------------------------------------------------------------------

  async leaveQuote(userId: ObjectId, tripId: ObjectId) {
    const p = await this.participants.findOne({ tripId, userId, active: true });
    const trip = await this.trips.findOne({ _id: tripId });
    if (!p || !trip) throw notIn();
    // A reservation: nothing paid, nothing to refund, and the seat always reopens.
    if (!this.paid(trip)) return { refundAmount: 0, locked: false };
    const locked = this.clock.now() >= trip.lockAt;
    return { refundAmount: p.status === 'joined' && p.role === 'passenger' && !locked ? trip.seatPrice : 0, locked };
  }

  /** Before the lock: refunded and the seat reopens. After: no refund, the seat stays paid for the organizer. */
  async leave(userId: ObjectId, tripId: ObjectId) {
    const payoutIds: ObjectId[] = [];
    const res = await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const p = await this.participants.findOne({ tripId, userId, active: true }, { session });
      if (!p) throw notIn();
      if (p.role === 'organizer') throw errors.conflict('ORGANIZER_CANNOT_LEAVE', 'Tu organises ce trajet : passe le relais ou annule-le.');
      const trip = await this.trips.findOne({ _id: tripId }, { session });
      if (!trip || trip.status !== 'open') throw tripClosed();
      const gone = { leftAt: now, active: false, activeTrip: false, holdExpiresAt: null, updatedAt: now };

      if (p.status === 'pending_payment') {
        await this.participants.updateOne({ _id: p._id, status: 'pending_payment' }, { $set: { status: 'left', ...gone } }, { session });
        await this.trips.updateOne({ _id: tripId }, { $inc: { seatsTaken: -1 }, $set: { updatedAt: now } }, { session });
        if (p.paymentId) await this.payments.cancelInSession(p.paymentId, session);
        return { refundAmount: 0, forfeited: false };
      }

      // A reservation: the seat reopens, whenever they leave.
      if (!this.paid(trip)) {
        await this.participants.updateOne({ _id: p._id, status: 'joined' }, { $set: { status: 'left', ...gone } }, { session });
        await this.trips.updateOne({ _id: tripId }, { $inc: { seatsTaken: -1 }, $set: { updatedAt: now } }, { session });
        await this.say(tripId, `${await this.firstName(userId)} a annulé sa réservation`, session);
        await this.syncChat(tripId, session);
        return { refundAmount: 0, forfeited: false };
      }
      const refundable = now < trip.lockAt;
      await this.participants.updateOne({ _id: p._id, status: 'joined' }, { $set: { status: 'left', forfeited: !refundable, ...gone } }, { session });
      await this.say(tripId, `${await this.firstName(userId)} a quitté le trajet`, session);
      await this.syncChat(tripId, session);
      if (!refundable) return { refundAmount: 0, forfeited: true };
      await this.trips.updateOne({ _id: tripId }, { $inc: { seatsTaken: -1 }, $set: { updatedAt: now } }, { session });
      payoutIds.push(await this.refund(p, trip, 'taxi_left', 'leave', session));
      return { refundAmount: trip.seatPrice, forfeited: false };
    });
    await this.payments.schedulePayouts(payoutIds);
    return res;
  }

  private async refund(p: TaxiParticipantDoc, trip: TaxiTripDoc, reason: 'taxi_left' | 'taxi_cancelled' | 'taxi_handover', step: string, session: ClientSession) {
    const payment = p.paymentId ? await this.payments.findById(p.paymentId, session) : null;
    const payout = await this.payments.createPayout(
      {
        kind: 'refund', beneficiaryUserId: p.userId, method: payment?.method ?? 'wave', amount: trip.seatPrice, reason,
        source: { type: 'taxi_participant', id: p._id }, idempotencyKey: `taxi:${p._id.toHexString()}:${step}`,
      },
      session,
    );
    return payout._id;
  }

  /** Everyone who paid is refunded 100 %. After the lock, with paid passengers, it counts as a late cancellation. */
  async cancel(userId: ObjectId, tripId: ObjectId) {
    const payoutIds: ObjectId[] = [];
    const res = await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const trip = await this.trips.findOneAndUpdate(
        { _id: tripId, organizerUserId: userId, status: 'open' },
        { $set: { status: 'cancelled', cancelledAt: now, updatedAt: now } },
        { session },
      );
      if (!trip) {
        const exists = await this.trips.findOne({ _id: tripId, organizerUserId: userId }, { session });
        throw exists ? tripClosed() : errors.notFound('Trajet introuvable.');
      }
      const people = await this.participants.find({ tripId, $or: [{ active: true }, { forfeited: true }] }, { session }).toArray();
      const online = this.paid(trip);
      // Paid seats, or (without payment in the app) the reservations.
      const paid = people.filter((p) => p.role === 'passenger' && (p.status === 'joined' || p.forfeited));
      if (online) for (const p of paid) payoutIds.push(await this.refund(p, trip, 'taxi_cancelled', 'cancel', session));
      await this.notifications.notify(
        paid.map((p) => p.userId),
        {
          type: 'taxi.cancelled', category: online ? 'paiements' : 'social', icon: 'car-outline', tone: 'danger', url: null, dedupeKey: `taxi:${tripId.toHexString()}:cancelled`,
          title: 'Trajet Sunu Taxi annulé', body: online ? `${trip.from} → ${trip.to} · ta place est remboursée à 100 %.` : `${trip.from} → ${trip.to} · ta réservation est annulée.`,
        },
        session,
      );
      for (const p of people) if (p.status === 'pending_payment' && p.paymentId) await this.payments.cancelInSession(p.paymentId, session);
      await this.participants.updateMany({ tripId, status: 'pending_payment' }, { $set: { status: 'expired', holdExpiresAt: null } }, { session });
      await this.participants.updateMany({ tripId, $or: [{ active: true }, { activeTrip: true }] }, { $set: { active: false, activeTrip: false, updatedAt: now } }, { session });
      await this.say(tripId, online ? 'Trajet annulé par l’organisateur. Les places payées sont remboursées à 100 %.' : 'Trajet annulé par l’organisateur.', session);
      await this.syncChat(tripId, session);
      const strike = now >= trip.lockAt && paid.length > 0;
      if (strike) await this.strikes.insertOne({ _id: new ObjectId(), userId, tripId, reason: 'late_cancel', at: now }, { session });
      return { refunded: paid.length, strike };
    });
    await this.payments.schedulePayouts(payoutIds);
    return { ...res, ...(await this.standing(userId)) };
  }

  /**
   * "Passer le relais": the first passenger who joined organizes the trip, no penalty. Their seat is refunded
   * (organizers don't pay a seat) and the former organizer leaves the trip.
   */
  async handOver(userId: ObjectId, tripId: ObjectId) {
    const payoutIds: ObjectId[] = [];
    await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const now = this.clock.now();
      const trip = await this.trips.findOne({ _id: tripId, organizerUserId: userId }, { session });
      if (!trip) throw errors.notFound('Trajet introuvable.');
      if (trip.status !== 'open') throw tripClosed();
      const [next] = await this.participants.find({ tripId, role: 'passenger', status: 'joined' }, { session }).sort({ joinOrder: 1 }).limit(1).toArray();
      if (!next) throw errors.conflict('NO_PASSENGER', 'Personne n’a encore rejoint ce trajet : tu peux l’annuler sans pénalité.');
      await this.participants.updateOne(
        { tripId, userId, role: 'organizer', active: true },
        { $set: { status: 'left', leftAt: now, active: false, activeTrip: false, updatedAt: now } },
        { session },
      );
      await this.participants.updateOne({ _id: next._id }, { $set: { role: 'organizer', updatedAt: now } }, { session });
      await this.trips.updateOne({ _id: tripId }, { $set: { organizerUserId: next.userId, updatedAt: now }, $inc: { seatsTaken: -1 } }, { session });
      if (this.paid(trip)) payoutIds.push(await this.refund(next, trip, 'taxi_handover', 'handover', session));
      await this.syncChat(tripId, session);
      await this.say(tripId, `${await this.firstName(userId)} a passé le relais. ${await this.firstName(next.userId)} organise maintenant le trajet.`, session);
      await this.notifications.notify(
        [next.userId],
        {
          type: 'taxi.handover', category: 'social', icon: 'car-outline', tone: 'warning', url: `/taxi/${tripId.toHexString()}`, dedupeKey: `taxi:${tripId.toHexString()}:handover:${next._id.toHexString()}`,
          title: 'Tu organises maintenant le trajet', body: this.paid(trip) ? `${trip.from} → ${trip.to} · ta place t’est remboursée, c’est toi qui paies le taxi.` : `${trip.from} → ${trip.to} · c’est toi qui organises, et qui paies le taxi.`,
        },
        session,
      );
    });
    await this.payments.schedulePayouts(payoutIds);
  }

  // ---- At the meeting point --------------------------------------------------------------------------------------

  async checkIn(userId: ObjectId, tripId: ObjectId) {
    const trip = await this.trips.findOne({ _id: tripId });
    if (!trip || trip.status !== 'open') throw trip ? tripClosed() : notIn();
    const now = this.clock.now();
    const res = await this.participants.updateOne({ tripId, userId, status: 'joined', active: true, checkedInAt: null }, { $set: { checkedInAt: now, updatedAt: now } });
    if (res.modifiedCount === 1) {
      await this.say(tripId, `${await this.firstName(userId)} est là ✓`);
      return;
    }
    // Already checked in (twice is fine), or not in this trip.
    if (!(await this.participants.countDocuments({ tripId, userId, status: 'joined', active: true }, { limit: 1 }))) throw notIn();
  }

  async setVehicle(userId: ObjectId, tripId: ObjectId, label: string) {
    const vehicle = tidy(label);
    if (vehicle.length < 2) throw errors.validation('Décris le taxi (modèle, couleur, plaque).', { field: 'label' });
    const res = await this.trips.updateOne({ _id: tripId, organizerUserId: userId, status: { $in: ['open', 'departed'] } }, { $set: { vehicle, updatedAt: this.clock.now() } });
    if (res.matchedCount === 0) throw errors.notFound('Trajet introuvable.');
    if (res.modifiedCount === 1) await this.say(tripId, `Taxi indiqué : ${vehicle}`);
  }

  /** "On est partis": from the lock until the chat closes. Unpaid holds are dropped; nobody can join any more. */
  async depart(userId: ObjectId, tripId: ObjectId) {
    await withTransaction(this.mongo, async (session) => {
      const now = this.clock.now();
      const trip = await this.trips.findOne({ _id: tripId, organizerUserId: userId }, { session });
      if (!trip) throw errors.notFound('Trajet introuvable.');
      if (trip.status !== 'open' || now >= trip.chatClosesAt) throw tripClosed();
      if (now < trip.lockAt) {
        throw errors.rule('TOO_EARLY_TO_DEPART', `Tu pourras confirmer le départ à partir de ${dakar.format(trip.lockAt).split(' ').pop()}, quand les places sont verrouillées.`);
      }
      const holds = await this.participants.find({ tripId, status: 'pending_payment' }, { session }).toArray();
      for (const p of holds) if (p.paymentId) await this.payments.cancelInSession(p.paymentId, session);
      await this.participants.updateMany({ tripId, status: 'pending_payment' }, { $set: { status: 'expired', active: false, holdExpiresAt: null, updatedAt: now } }, { session });
      await this.participants.updateMany({ tripId, activeTrip: true }, { $set: { activeTrip: false, updatedAt: now } }, { session });
      await this.say(tripId, 'Vous êtes partis 🚕 Bon trajet !', session);
      await this.trips.updateOne(
        { _id: tripId, status: 'open' },
        // No $inc of -0 when nobody is mid-payment: it would store a double and fail the int validator.
        { $set: { status: 'departed', departedAt: now, updatedAt: now }, ...(holds.length ? { $inc: { seatsTaken: -holds.length } } : {}) },
        { session },
      );
    });
  }

  /** After departure, the organizer collects every paid seat on their Wave / Orange Money number. Once per trip. */
  async claim(userId: ObjectId, tripId: ObjectId, method: PaymentMethod): Promise<PayoutDoc> {
    let payout!: PayoutDoc;
    await withTransaction(this.mongo, async (session) => {
      const trip = await this.trips.findOne({ _id: tripId, organizerUserId: userId }, { session });
      if (!trip) throw errors.notFound('Trajet introuvable.');
      if (!this.paid(trip)) throw errors.rule('NOTHING_TO_CLAIM', 'Les places de ce trajet se règlent dans le taxi : rien à récupérer dans l’app.');
      if (trip.status !== 'departed') throw errors.conflict('TRIP_NOT_DEPARTED', 'Confirme d’abord le départ (« On est partis »).');
      const paid = await this.participants.countDocuments({ tripId, role: 'passenger', $or: [{ status: 'joined' }, { forfeited: true }] }, { session });
      if (paid === 0) throw errors.rule('NOTHING_TO_CLAIM', 'Aucun passager n’a payé de place sur ce trajet.');
      payout = await this.payments.createPayout(
        {
          kind: 'organizer_claim', beneficiaryUserId: userId, method, amount: paid * trip.seatPrice, reason: 'taxi_claim',
          source: { type: 'taxi_trip', id: tripId }, idempotencyKey: `taxi:${tripId.toHexString()}:claim`,
        },
        session,
      );
      await this.trips.updateOne({ _id: tripId }, { $set: { claimPayoutId: payout._id } }, { session });
    });
    await this.payments.schedulePayouts([payout._id]);
    return payout;
  }

  /**
   * Trips whose time has come leave by themselves, as if the organizer had said « On est partis » (they still may,
   * earlier): marked departed at their time, nobody can join, their people are free for another trip, the chat says so.
   */
  private async departDue(now: Date) {
    const due = await this.trips.find({ status: 'open', departureAt: { $lte: now }, chatClosesAt: { $gt: now } }, { projection: { _id: 1, departureAt: 1 } }).limit(200).toArray();
    let n = 0;
    for (const t of due) {
      await withTransaction(this.mongo, async (session) => {
        const holds = await this.participants.find({ tripId: t._id, status: 'pending_payment' }, { session }).toArray();
        const res = await this.trips.updateOne(
          { _id: t._id, status: 'open' },
          { $set: { status: 'departed', departedAt: t.departureAt, updatedAt: now }, ...(holds.length ? { $inc: { seatsTaken: -holds.length } } : {}) },
          { session },
        );
        if (!res.modifiedCount) return;
        n++;
        for (const p of holds) if (p.paymentId) await this.payments.cancelInSession(p.paymentId, session);
        await this.participants.updateMany({ tripId: t._id, status: 'pending_payment' }, { $set: { status: 'expired', active: false, holdExpiresAt: null, updatedAt: now } }, { session });
        await this.participants.updateMany({ tripId: t._id, activeTrip: true }, { $set: { activeTrip: false, updatedAt: now } }, { session });
        await this.say(t._id, 'Heure du départ : bon trajet 🚕', session);
      });
    }
    return n;
  }

  /** Worker: trips at their time leave; trips past it that never could (chat closed) stop blocking their people. */
  async sweep() {
    const now = this.clock.now();
    await this.departDue(now);
    const stale = await this.trips
      .find({ status: 'open', departureAt: { $lt: new Date(now.getTime() - TAXI_GRACE_MIN * MIN), $gt: new Date(now.getTime() - 2 * DAY) } }, { projection: { _id: 1 } })
      .toArray();
    return this.release(stale.map((t) => t._id), now);
  }

  private async release(tripIds: ObjectId[], now: Date) {
    if (!tripIds.length) return 0;
    const res = await this.participants.updateMany({ tripId: { $in: tripIds }, activeTrip: true }, { $set: { activeTrip: false, updatedAt: now } });
    return res.modifiedCount;
  }

  /**
   * Before proposing or joining a trip: a trip of mine past its time (and its 15 minutes' grace) that never left is
   * over. It no longer blocks me, even if the worker's sweep hasn't run yet (it's also off the board by then: without
   * this, the student could neither see it nor start another one).
   */
  private async releaseIfStale(userId: ObjectId) {
    const now = this.clock.now();
    const current = await this.activeTripOf(userId);
    if (current && current.status === 'open' && current.departureAt.getTime() < now.getTime() - TAXI_GRACE_MIN * MIN) await this.release([current._id], now);
  }

  // ---- Reads ----------------------------------------------------------------------------------------------------

  /** Open trips (until 15 min after their time), plus mine while their chat is open. */
  async board(userId: ObjectId): Promise<TaxiTripDoc[]> {
    const now = this.clock.now();
    // Not waiting for the worker: a trip whose time has come is shown gone.
    await this.departDue(now);
    const open = await this.trips.find({ status: 'open', departureAt: { $gt: new Date(now.getTime() - TAXI_GRACE_MIN * MIN) } }).sort({ departureAt: 1 }).limit(50).toArray();
    const mine = await this.participants
      .find({ userId, $or: [{ active: true }, { forfeited: true }], createdAt: { $gt: new Date(now.getTime() - TAXI_DEPARTURE.maxDays * DAY - DAY) } }, { projection: { tripId: 1 } })
      .toArray();
    const seen = new Set(open.map((t) => t._id.toHexString()));
    const extra = mine.filter((p) => !seen.has(p.tripId.toHexString())).map((p) => p.tripId);
    const myTrips = extra.length ? await this.trips.find({ _id: { $in: extra }, status: 'departed', chatClosesAt: { $gt: now } }).toArray() : [];
    return [...open, ...myTrips].sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime());
  }

  /** Open trips are public to students; past or cancelled ones only to the people who were in them. */
  async getVisible(userId: ObjectId, tripId: ObjectId) {
    const trip = await this.trips.findOne({ _id: tripId });
    if (!trip) throw errors.notFound('Trajet introuvable.');
    if (trip.status === 'open') return trip;
    const wasIn = await this.participants.findOne({ tripId, userId, $or: [{ status: 'joined' }, { forfeited: true }, { role: 'organizer' }] });
    if (!wasIn) throw errors.notFound('Trajet introuvable.');
    return trip;
  }

  async views(viewerId: ObjectId, trips: TaxiTripDoc[]): Promise<TripView[]> {
    if (!trips.length) return [];
    const ids = trips.map((t) => t._id);
    const people = await this.participants.find({ tripId: { $in: ids }, $or: [{ status: 'joined' }, { forfeited: true }, { userId: viewerId }] }).toArray();
    const organizerIds = [...new Map(trips.map((t) => [t.organizerUserId.toHexString(), t.organizerUserId])).values()];
    const userIds = [...new Map([...people.map((p) => p.userId), ...organizerIds].map((id) => [id.toHexString(), id])).values()];
    const since = new Date(this.clock.now().getTime() - TAXI_STRIKE_WINDOW_DAYS * DAY);
    const [names, tripCounts, strikeCounts] = await Promise.all([
      this.accounts.namesByIds(userIds),
      this.trips.aggregate<{ _id: ObjectId; n: number }>([{ $match: { organizerUserId: { $in: organizerIds }, status: 'departed' } }, { $group: { _id: '$organizerUserId', n: { $sum: 1 } } }]).toArray(),
      this.strikes.aggregate<{ _id: ObjectId; n: number }>([{ $match: { userId: { $in: organizerIds }, at: { $gt: since } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]).toArray(),
    ]);
    const countOf = (rows: { _id: ObjectId; n: number }[], id: ObjectId) => rows.find((r) => r._id.equals(id))?.n ?? 0;
    const person = (userId: ObjectId): Person => this.identityOf(userId, names);
    const chats = await this.messaging.idsFor('taxi_trip', ids);

    return Promise.all(
      trips.map(async (t): Promise<TripView> => {
        const inTrip = people.filter((p) => p.tripId.equals(t._id));
        const mineAll = inTrip.filter((p) => p.userId.equals(viewerId)).sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt.getTime() - a.createdAt.getTime());
        const mine = mineAll[0];
        const isPeople = !!mine && (mine.status === 'joined' || mine.forfeited);
        const isOrganizer = t.organizerUserId.equals(viewerId);
        const passengers = inTrip
          .filter((p) => p.status === 'joined')
          .sort((a, b) => Number(b.role === 'organizer') - Number(a.role === 'organizer') || a.joinOrder - b.joinOrder)
          .map((p) => ({ ...person(p.userId), role: p.role, checkedIn: !!p.checkedInAt }));

        let payment: NonNullable<TripView['me']>['payment'] = null;
        if (mine?.status === 'pending_payment' && mine.paymentId) {
          const pay = await this.payments.findById(mine.paymentId);
          if (pay) payment = { reference: pay.reference, checkoutUrl: pay.checkoutUrl, expiresAt: pay.expiresAt.toISOString() };
        }
        let claim: TripView['claim'] = null;
        if (isOrganizer && t.status === 'departed' && this.paid(t)) {
          const paid = inTrip.filter((p) => p.role === 'passenger' && (p.status === 'joined' || p.forfeited)).length;
          const payout = t.claimPayoutId ? await this.payments.findPayout(t.claimPayoutId) : null;
          claim = { amount: paid * t.seatPrice, payout: payout ? { id: payout._id.toHexString(), status: payout.status, amount: payout.amount } : null };
        }
        return {
          id: t._id.toHexString(),
          from: t.from,
          to: t.to,
          departureAt: t.departureAt.toISOString(),
          lockAt: t.lockAt.toISOString(),
          chatClosesAt: t.chatClosesAt.toISOString(),
          seats: t.seats,
          seatsTaken: t.seatsTaken,
          fare: t.fare,
          seatPrice: t.seatPrice,
          payOnline: this.paid(t),
          status: t.status,
          organizer: { ...person(t.organizerUserId), trips: countOf(tripCounts, t.organizerUserId), lateCancels: countOf(strikeCounts, t.organizerUserId) },
          passengers,
          vehicle: isPeople ? t.vehicle : null,
          conversationId: isPeople ? (chats.get(t._id.toHexString())?.toHexString() ?? null) : null,
          me: mine
            ? { key: this.personKey(viewerId), role: mine.role, status: mine.status, checkedIn: !!mine.checkedInAt, forfeited: mine.forfeited, payment }
            : null,
          claim,
        };
      }),
    );
  }

  async view(viewerId: ObjectId, trip: TaxiTripDoc) {
    return (await this.views(viewerId, [trip]))[0]!;
  }
}
