import { ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import type { Clock } from '../../platform/clock.js';
import { afterCommit, isDuplicateKey, withTransaction } from '../../platform/db/mongo.js';
import { errors } from '../../platform/http/errors.js';
import { maskPhone } from '../../platform/phone.js';
import type { RealtimeHub } from '../../platform/realtime/hub.js';
import { randomCode } from '../../platform/security/crypto.js';
import type { Limiter } from '../../platform/security/limiter.js';
import type { TokenService } from '../../platform/security/tokens.js';
import type { AccountsApi } from '../accounts/index.js';
import type { NotificationsApi } from '../notifications/index.js';
import type { OrganizationsApi } from '../organizations/index.js';
import type { PaymentsApi } from '../payments/index.js';
import {
  TRANSFER_TTL_MS,
  type AdmissionDoc,
  type CancellationQuote,
  type EventSummary,
  type NewTicket,
  type TicketDoc,
  type TicketKind,
  type TicketKindHandler,
  type TicketTransferDoc,
} from './ticketing.types.js';

const dakar = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Dakar', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export const eventTopic = (id: ObjectId) => `event:${id.toHexString()}`;
const userTopic = (id: ObjectId) => `user:${id.toHexString()}`;

export type TicketView = {
  id: string;
  kind: TicketKind;
  code: string;
  /** `transferred`: I gave this ticket to someone (it's theirs now). */
  status: 'active' | 'cancelled' | 'transferred';
  seat: number | null;
  price: number;
  paidWith: TicketDoc['paidWith'];
  /** Cash: what is still to hand over at boarding / the door (0 once collected, or paid in the app). */
  cashDue: number;
  event: EventSummary;
  details: Record<string, unknown>;
  /** Who travels on it when it isn't the holder: the companion the purchaser booked for. */
  passenger: { name: string; phone: string } | null;
  /** Who paid ("Réservé par Moussa D."). */
  purchaser: { name: string; isMe: boolean };
  /** Signed QR payload, only for the holder of an active ticket. */
  qr: string | null;
  admittedAt: string | null;
  cancellation: { at: string; fee: number; refundAmount: number; reason: string } | null;
  /** What cancelling now would cost, for the holder of an active ticket. */
  cancellationQuote: CancellationQuote | null;
  transferDeadline: string | null;
  /** The transfer I offered (pending), or the one that gave the ticket away. */
  transfer: TransferView | null;
};

export type TransferView = {
  id: string;
  ticketId: string;
  status: TicketTransferDoc['status'];
  expiresAt: string;
  from: { name: string };
  to: { name: string; phoneMasked: string };
};

export type ScanInput = {
  qr?: string;
  code?: string;
  ticketId?: string;
  /** Typed codes and wrong-departure checks: the event the scanner is working on, if known. */
  eventId?: string;
  locationId?: string;
  clientScanId?: string;
  deviceId?: string;
  scannedAt?: string;
};

export type ScanResult = {
  result: AdmissionDoc['result'];
  tone: 'success' | 'warning' | 'danger';
  title: string;
  text: string;
  reason: string | null;
  eventId: string | null;
  ticket: { id: string; code: string; seat: number | null } | null;
  /** Who travels (the companion's name on a companion ticket). */
  holder: { name: string } | null;
  /** Companion ticket: the student who booked it. */
  companionOf: string | null;
  /** The purchaser's other valid tickets on this event ("Groupe : 2 billets"), to board them together. */
  group: ScanGroup | null;
  /** Paid in cash: the amount to take now (0: nothing to collect). */
  cashDue: number;
};

export type ScanGroup = { size: number; purchaser: string; others: { ticketId: string; seat: number | null; name: string; admitted: boolean }[] };

const fullName = (n?: { firstName: string; lastName: string }) => (n ? `${n.firstName} ${n.lastName}`.trim() : 'Passager');
const shortName = (n?: { firstName: string; lastName: string }) => (n ? (n.lastName ? `${n.firstName} ${n.lastName[0]}.` : n.firstName) : 'Un étudiant');

export class TicketingService {
  private readonly tickets: Collection<TicketDoc>;
  private readonly transfers: Collection<TicketTransferDoc>;
  private readonly admissions: Collection<AdmissionDoc>;
  private readonly handlers = new Map<TicketKind, TicketKindHandler & { labels: { admitted: string; duplicate: string } }>();

  constructor(
    db: Db,
    private readonly mongo: MongoClient,
    private readonly clock: Clock,
    private readonly tokens: TokenService,
    private readonly accounts: AccountsApi,
    private readonly organizations: OrganizationsApi,
    private readonly payments: PaymentsApi,
    private readonly hub: RealtimeHub,
    private readonly limiter: Limiter,
    private readonly notifications: NotificationsApi,
  ) {
    this.tickets = db.collection('tickets');
    this.transfers = db.collection('ticketTransfers');
    this.admissions = db.collection('admissions');
  }

  /** `labels`: how a scan reads for this kind ("à bord" for a bus, "entré" for an event). */
  registerKind(kind: TicketKind, handler: TicketKindHandler & { labels: { admitted: string; duplicate: string } }) {
    this.handlers.set(kind, handler);
  }

  private handler(kind: TicketKind) {
    const h = this.handlers.get(kind);
    if (!h) throw new Error(`No ticket handler for ${kind}`);
    return h;
  }

  // ---- Issuing (owning modules) ---------------------------------------------------------------------------------

  /** Inside the purchase's transaction. Idempotent: the same purchase gives back the same ticket. */
  async issue(input: NewTicket, session: ClientSession): Promise<TicketDoc> {
    const existing = await this.tickets.findOne({ 'source.type': input.source.type, 'source.id': input.source.id }, { session });
    if (existing) return existing;
    // Checked before writing: inside a transaction a duplicate-key error would abort everything.
    let code = randomCode(6);
    while (await this.tickets.findOne({ eventId: input.eventId, code }, { session, projection: { _id: 1 } })) code = randomCode(6);
    const now = this.clock.now();
    const doc: TicketDoc = {
      _id: new ObjectId(),
      ...input,
      code,
      holderUserId: input.purchaserUserId,
      holderTravels: input.holderTravels ?? !input.passenger,
      status: 'active',
      version: 1,
      admittedAt: null,
      ...(input.paidWith === 'cash' ? { cashCollectedAt: input.cashCollectedAt ?? null } : {}),
      cancellation: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.tickets.insertOne(doc, { session });
    afterCommit(session, () => this.hub.publish(userTopic(doc.holderUserId), 'ticket.updated', { ticketId: doc._id.toHexString() }));
    return doc;
  }

  /** The ticket this person travels on (not the companions' tickets they hold). */
  hasActiveTicket(eventId: ObjectId, userId: ObjectId, session?: ClientSession) {
    return this.tickets.findOne({ eventId, holderUserId: userId, status: 'active', holderTravels: true }, { session });
  }

  /** Does this phone number already have a seat on the event: their own ticket, or named on someone's companion ticket. */
  async isTravelling(eventId: ObjectId, phone: string, opts: { except?: ObjectId; session?: ClientSession } = {}) {
    const account = await this.accounts.findByPhone(phone);
    const found = await this.tickets.findOne(
      {
        eventId, status: 'active', ...(opts.except ? { _id: { $ne: opts.except } } : {}),
        $or: [{ 'passenger.phone': phone }, ...(account ? [{ holderUserId: account._id, holderTravels: true }] : [])],
      },
      { session: opts.session, projection: { _id: 1 } },
    );
    return !!found;
  }

  findById(id: ObjectId, session?: ClientSession) {
    return this.tickets.findOne({ _id: id }, { session });
  }

  activeTickets(eventId: ObjectId) {
    return this.tickets.find({ eventId, status: 'active' }).sort({ seat: 1 }).toArray();
  }

  /** "34 passagers · 31 acheteurs · 12 à bord" for organizer lists. */
  async counts(eventIds: ObjectId[]): Promise<Map<string, { booked: number; buyers: number; admitted: number }>> {
    const rows = eventIds.length
      ? await this.tickets
          .aggregate<{ _id: ObjectId; booked: number; buyers: number; admitted: number }>([
            { $match: { eventId: { $in: eventIds }, status: 'active' } },
            {
              $group: {
                _id: '$eventId', booked: { $sum: 1 }, buyers: { $addToSet: '$purchaserUserId' },
                admitted: { $sum: { $cond: [{ $ne: ['$admittedAt', null] }, 1, 0] } },
              },
            },
            { $set: { buyers: { $size: '$buyers' } } },
          ])
          .toArray()
      : [];
    return new Map(rows.map((r) => [r._id.toHexString(), { booked: r.booked, buyers: r.buyers, admitted: r.admitted }]));
  }

  /**
   * What the organizer collects after the event: valid tickets paid in the app, plus the fees kept on late
   * cancellations. Cash tickets aren't in it: the organizer took that money themselves.
   */
  async revenue(eventId: ObjectId, session?: ClientSession) {
    const [row] = await this.tickets
      .aggregate<{ tickets: number; fees: number }>(
        [
          { $match: { eventId, paidWith: { $ne: 'cash' } } },
          {
            $group: {
              _id: null,
              tickets: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, '$price', 0] } },
              fees: { $sum: { $ifNull: ['$cancellation.fee', 0] } },
            },
          },
        ],
        { session },
      )
      .toArray();
    return { tickets: row?.tickets ?? 0, fees: row?.fees ?? 0 };
  }

  // ---- Views ---------------------------------------------------------------------------------------------------

  private async views(tickets: TicketDoc[], viewerId: ObjectId): Promise<TicketView[]> {
    if (!tickets.length) return [];
    const byKind = new Map<TicketKind, TicketDoc[]>();
    for (const t of tickets) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t]);
    const presented = new Map<string, { event: EventSummary; details: Record<string, unknown> }>();
    for (const [kind, list] of byKind) for (const [id, p] of await this.handler(kind).present(list, viewerId)) presented.set(id, p);

    const ids = tickets.map((t) => t._id);
    const transfers = await this.transfers
      .find({ ticketId: { $in: ids }, $or: [{ status: 'pending', fromUserId: viewerId }, { status: 'accepted', fromUserId: viewerId }] })
      .sort({ createdAt: -1 })
      .toArray();
    const people = await this.accounts.contactsByIds([...new Map(transfers.flatMap((x) => [x.fromUserId, x.toUserId]).map((u) => [u.toHexString(), u])).values()]);
    const purchasers = await this.accounts.namesByIds([...new Map(tickets.map((t) => [t.purchaserUserId.toHexString(), t.purchaserUserId])).values()]);
    const now = this.clock.now();

    return Promise.all(
      tickets.map(async (t): Promise<TicketView> => {
        const holder = t.holderUserId.equals(viewerId);
        const active = t.status === 'active' && holder;
        const x = transfers.find((tr) => tr.ticketId.equals(t._id) && (tr.status === 'pending' || !holder));
        const p = presented.get(t._id.toHexString())!;
        return {
          id: t._id.toHexString(),
          kind: t.kind,
          code: t.code,
          status: holder ? t.status : 'transferred',
          seat: t.seat,
          price: t.price,
          paidWith: t.paidWith,
          cashDue: t.paidWith === 'cash' && !t.cashCollectedAt && t.status === 'active' ? t.price : 0,
          event: p.event,
          details: p.details,
          passenger: t.passenger && holder ? { name: t.passenger.name, phone: t.passenger.phone } : null,
          purchaser: { name: shortName(purchasers.get(t.purchaserUserId.toHexString())), isMe: t.purchaserUserId.equals(viewerId) },
          qr: active ? await this.tokens.signTicket({ ticketId: t._id.toHexString(), eventId: t.eventId.toHexString(), version: t.version }) : null,
          admittedAt: t.admittedAt?.toISOString() ?? null,
          cancellation: t.cancellation && holder
            ? { at: t.cancellation.at.toISOString(), fee: t.cancellation.fee, refundAmount: t.cancellation.refundAmount, reason: t.cancellation.reason }
            : null,
          cancellationQuote: active ? await this.quote(t, now) : null,
          transferDeadline: active ? (await this.handler(t.kind).transferDeadline(t)).toISOString() : null,
          transfer: x ? this.transferView(x, people) : null,
        };
      }),
    );
  }

  private transferView(x: TicketTransferDoc, people: Map<string, { firstName: string; lastName: string; phone: string }>): TransferView {
    const to = people.get(x.toUserId.toHexString());
    return {
      id: x._id.toHexString(),
      ticketId: x.ticketId.toHexString(),
      status: x.status,
      expiresAt: x.expiresAt.toISOString(),
      from: { name: shortName(people.get(x.fromUserId.toHexString())) },
      to: { name: shortName(to), phoneMasked: to ? maskPhone(to.phone) : '' },
    };
  }

  /** "Mes billets": the ones I hold (any status), and the ones I gave away. Newest first. */
  async mine(userId: ObjectId) {
    const given = await this.transfers.find({ fromUserId: userId, status: 'accepted' }, { projection: { ticketId: 1 } }).toArray();
    const tickets = await this.tickets
      .find({ $or: [{ holderUserId: userId }, { _id: { $in: given.map((g) => g.ticketId) } }] })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return this.views(tickets, userId);
  }

  /** Holder, or former holder who gave it away (read-only, no QR). 404 for anyone else. */
  async getFor(ticketId: ObjectId, userId: ObjectId) {
    const t = await this.tickets.findOne({ _id: ticketId });
    if (!t) throw errors.notFound('Billet introuvable.');
    if (!t.holderUserId.equals(userId) && !(await this.transfers.findOne({ ticketId, fromUserId: userId, status: 'accepted' }))) {
      throw errors.notFound('Billet introuvable.');
    }
    return (await this.views([t], userId))[0]!;
  }

  // ---- Cancellation --------------------------------------------------------------------------------------------

  /** The kind's quote; a cash ticket costs nothing to cancel and refunds nothing (nothing was paid in the app). */
  private async quote(t: TicketDoc, now: Date): Promise<CancellationQuote> {
    const q = await this.handler(t.kind).cancellationQuote(t, now);
    return t.paidWith === 'cash' && q.allowed ? { ...q, fee: 0, refund: 0 } : q;
  }

  /** The holder cancels: refunded to their own payout number (decision Q-3), minus the kind's fee. */
  async cancel(ticketId: ObjectId, userId: ObjectId) {
    const t = await this.tickets.findOne({ _id: ticketId, holderUserId: userId });
    if (!t) throw errors.notFound('Billet introuvable.');
    if (t.status !== 'active') throw errors.conflict('TICKET_NOT_ACTIVE', 'Ce billet est déjà annulé.');
    const quote = await this.quote(t, this.clock.now());
    if (!quote.allowed) throw errors.rule('CANCELLATION_REFUSED', quote.reason);

    const payoutIds: ObjectId[] = [];
    const cancelled = await withTransaction(this.mongo, async (session) => {
      payoutIds.length = 0;
      const doc = await this.cancelOne(t._id, { by: 'holder', reason: 'holder_cancelled', fee: quote.fee, refund: quote.refund, expectHolder: userId }, session);
      if (!doc) throw errors.conflict('TICKET_NOT_ACTIVE', 'Ce billet n’est plus valable.');
      if (doc.cancellation?.payoutId) payoutIds.push(doc.cancellation.payoutId);
      return doc;
    });
    await this.payments.schedulePayouts(payoutIds);
    return { refundAmount: cancelled.cancellation!.refundAmount, fee: cancelled.cancellation!.fee };
  }

  /**
   * Cancels one active ticket and refunds its holder. Shared by the holder's cancellation and the cancellation of
   * a whole event (organizer, minimum not reached).
   */
  private async cancelOne(
    ticketId: ObjectId,
    c: { by: 'holder' | 'organizer' | 'system'; reason: NonNullable<TicketDoc['cancellation']>['reason']; fee: number; refund: number; expectHolder?: ObjectId },
    session: ClientSession,
  ): Promise<TicketDoc | null> {
    const now = this.clock.now();
    const t = await this.tickets.findOneAndUpdate(
      { _id: ticketId, status: 'active', ...(c.expectHolder ? { holderUserId: c.expectHolder } : {}) },
      { $set: { status: 'cancelled', updatedAt: now } },
      { returnDocument: 'after', session },
    );
    if (!t) return null;
    // Cash: nothing was paid in the app, nothing goes back (and no fee).
    if (t.paidWith === 'cash') c = { ...c, refund: 0, fee: 0 };
    let payoutId: ObjectId | null = null;
    if (c.refund > 0) {
      const payout = await this.payments.createPayout(
        {
          kind: 'refund',
          beneficiaryUserId: t.holderUserId,
          // Never cash here (refund is 0 for cash tickets, above).
          method: t.paidWith === 'cash' ? 'wave' : t.paidWith,
          amount: c.refund,
          reason: c.reason === 'holder_cancelled' ? 'ticket_cancelled' : c.reason === 'min_not_reached' ? 'min_not_reached' : 'event_cancelled',
          source: { type: 'ticket', id: t._id },
          idempotencyKey: `ticket:${t._id.toHexString()}:cancel`,
        },
        session,
      );
      payoutId = payout._id;
    }
    const cancellation = { at: now, by: c.by, reason: c.reason, fee: c.fee, refundAmount: c.refund, payoutId };
    await this.tickets.updateOne({ _id: t._id }, { $set: { cancellation } }, { session });
    await this.transfers.updateMany({ ticketId: t._id, status: 'pending' }, { $set: { status: 'cancelled', respondedAt: now } }, { session });
    await this.handler(t.kind).onCancelled(t, session);
    if (c.reason !== 'holder_cancelled') {
      const event = (await this.handler(t.kind).present([t], t.holderUserId)).get(t._id.toHexString())?.event;
      const fcfa = `${String(c.refund).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
      await this.notifications.notify(
        [t.holderUserId],
        {
          type: `ticket.${c.reason}`, category: 'paiements', icon: 'close-circle-outline', tone: 'danger', url: `/billet/${t._id.toHexString()}`,
          dedupeKey: `ticket:${t._id.toHexString()}:cancelled`,
          title: c.reason === 'min_not_reached' ? 'Départ annulé : pas assez de passagers' : `Annulé par l’organisateur${event ? ` : ${event.title}` : ''}`,
          body: `${event ? `${event.title}, ${dakar.format(new Date(event.startsAt))}. ` : ''}${t.paidWith === 'cash' ? (t.cashCollectedAt ? 'Ta place est annulée. Tu as payé l’organisateur en espèces : vois avec lui pour le remboursement.' : 'Ta réservation est annulée : rien à payer.') : `${fcfa} remboursés sur ton numéro.`}`,
        },
        session,
      );
    }
    afterCommit(session, async () => {
      await this.hub.publish(userTopic(t.holderUserId), 'ticket.updated', { ticketId: t._id.toHexString() });
      await this.hub.publish(eventTopic(t.eventId), 'tickets.updated', { ticketId: t._id.toHexString() });
    });
    return { ...t, cancellation };
  }

  /** The event won't happen (organizer cancelled, minimum not reached): every holder gets 100 % back. */
  async cancelAllForEvent(eventId: ObjectId, reason: 'event_cancelled' | 'min_not_reached', session: ClientSession) {
    const active = await this.tickets.find({ eventId, status: 'active' }, { session, projection: { _id: 1, price: 1 } }).toArray();
    const payoutIds: ObjectId[] = [];
    for (const t of active) {
      const doc = await this.cancelOne(t._id, { by: reason === 'min_not_reached' ? 'system' : 'organizer', reason, fee: 0, refund: t.price }, session);
      if (doc?.cancellation?.payoutId) payoutIds.push(doc.cancellation.payoutId);
    }
    return payoutIds;
  }

  // ---- Transfers ("Transférer à un ami") ------------------------------------------------------------------------

  async offer(ticketId: ObjectId, fromUserId: ObjectId, recipientPhone: string) {
    await this.limiter.hit(`ticket-transfer:${fromUserId.toHexString()}`, { limit: 10, windowS: 3600 }, 'Trop de transferts. Réessaie plus tard.');
    const t = await this.tickets.findOne({ _id: ticketId, holderUserId: fromUserId });
    if (!t) throw errors.notFound('Billet introuvable.');
    if (t.status !== 'active') throw errors.conflict('TICKET_NOT_ACTIVE', 'Ce billet n’est plus valable.');
    if (t.admittedAt) throw errors.rule('TICKET_USED', 'Ce billet a déjà été scanné à l’embarquement.');
    const now = this.clock.now();
    const deadline = await this.handler(t.kind).transferDeadline(t);
    if (now >= deadline) throw errors.rule('TRANSFER_CLOSED', `Les transferts sont fermés depuis le ${dakar.format(deadline)}.`);

    const phone = this.accounts.phoneOrThrow(recipientPhone);
    const recipient = await this.accounts.findByPhone(phone);
    if (!recipient || recipient.status !== 'active' || !(await this.accounts.hasStudentProfile(recipient._id))) {
      throw errors.rule('RECIPIENT_NOT_FOUND', 'Aucun étudiant inscrit sur ce numéro. Ton ami doit d’abord créer son compte UGB Connect.');
    }
    if (recipient._id.equals(fromUserId)) throw errors.rule('SELF_TRANSFER', 'C’est ton propre numéro.');
    if (await this.hasActiveTicket(t.eventId, recipient._id)) throw errors.rule('RECIPIENT_HAS_TICKET', 'Ton ami a déjà un billet pour ce départ.');
    // Named as someone's companion on another ticket: they already have a seat (giving them *this* companion ticket is fine).
    if (await this.isTravelling(t.eventId, phone, { except: t._id })) throw errors.rule('RECIPIENT_HAS_TICKET', 'Ton ami a déjà une place sur ce départ.');
    const refused = await this.handler(t.kind).refuseRecipient(t, recipient._id);
    if (refused) throw errors.rule('RECIPIENT_REFUSED', refused);
    return this.createOffer(t, fromUserId, recipient._id, deadline, 'gift');
  }

  /**
   * A companion ticket whose phone number has a student account: the companion is offered the ticket, so it shows
   * in their own app with their own QR code. Best effort: if they don't answer, the purchaser keeps it.
   */
  async offerToPassenger(ticketId: ObjectId) {
    const t = await this.tickets.findOne({ _id: ticketId, status: 'active', holderTravels: false });
    if (!t?.passenger) return null;
    const recipient = await this.accounts.findByPhone(t.passenger.phone);
    if (!recipient || recipient.status !== 'active' || recipient._id.equals(t.holderUserId) || !(await this.accounts.hasStudentProfile(recipient._id))) return null;
    if (await this.hasActiveTicket(t.eventId, recipient._id)) return null;
    if (await this.handler(t.kind).refuseRecipient(t, recipient._id)) return null;
    const deadline = await this.handler(t.kind).transferDeadline(t);
    if (this.clock.now() >= deadline) return null;
    try {
      return await this.createOffer(t, t.holderUserId, recipient._id, deadline, 'companion');
    } catch (err) {
      if (isDuplicateKey(err, 'ticket_pending_unique')) return null;
      throw err;
    }
  }

  private async createOffer(t: TicketDoc, fromUserId: ObjectId, toUserId: ObjectId, deadline: Date, why: 'gift' | 'companion') {
    const now = this.clock.now();
    const doc: TicketTransferDoc = {
      _id: new ObjectId(), ticketId: t._id, eventId: t.eventId, fromUserId, toUserId, status: 'pending', ticketVersion: t.version,
      expiresAt: new Date(Math.min(now.getTime() + TRANSFER_TTL_MS, deadline.getTime())), respondedAt: null, createdAt: now,
    };
    try {
      await this.transfers.insertOne(doc);
    } catch (err) {
      if (why === 'gift' && isDuplicateKey(err, 'ticket_pending_unique')) throw errors.conflict('TRANSFER_PENDING', 'Un transfert est déjà en attente pour ce billet. Annule-le d’abord.');
      throw err;
    }
    await this.hub.publish(userTopic(toUserId), 'ticket.transfer', { transferId: doc._id.toHexString() });
    const people = await this.accounts.contactsByIds([fromUserId, toUserId]);
    const event = (await this.handler(t.kind).present([t], toUserId)).get(t._id.toHexString())?.event;
    const when = event ? `${event.title}, ${dakar.format(new Date(event.startsAt))}. ` : '';
    const from = shortName(people.get(fromUserId.toHexString()));
    await this.notifications.notify([toUserId], {
      // Opens the offer itself (accept / refuse), then the ticket once it's mine.
      type: 'ticket.transfer_offered', category: 'social', icon: 'gift-outline', tone: 'purple', url: `/cadeau/${doc._id.toHexString()}?ticket=${t._id.toHexString()}`,
      dedupeKey: `transfer:${doc._id.toHexString()}:offered`,
      title: why === 'companion' ? `${from} t’a réservé une place` : `${from} t’offre son billet`,
      body: why === 'companion' ? `${when}Ajoute le billet à ton app pour avoir ton propre QR code.` : `${when}Accepte-le avant le ${dakar.format(doc.expiresAt)}.`,
    });
    return this.transferView(doc, people);
  }

  /** Incoming: offered to me, waiting for my answer. Outgoing: offered by me, waiting for the friend. */
  async listTransfers(userId: ObjectId, direction: 'incoming' | 'outgoing') {
    const now = this.clock.now();
    const list = await this.transfers
      .find({ [direction === 'incoming' ? 'toUserId' : 'fromUserId']: userId, status: 'pending', expiresAt: { $gt: now } })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    const people = await this.accounts.contactsByIds(list.flatMap((x) => [x.fromUserId, x.toUserId]));
    const tickets = await this.tickets.find({ _id: { $in: list.map((x) => x.ticketId) } }).toArray();
    const presented = new Map<string, { event: EventSummary; details: Record<string, unknown> }>();
    for (const kind of new Set(tickets.map((t) => t.kind))) {
      for (const [id, p] of await this.handler(kind).present(tickets.filter((t) => t.kind === kind), userId)) presented.set(id, p);
    }
    return list.map((x) => {
      const t = tickets.find((tk) => tk._id.equals(x.ticketId));
      const p = presented.get(x.ticketId.toHexString());
      return { ...this.transferView(x, people), seat: t?.seat ?? null, event: p?.event ?? null, details: p?.details ?? {}, forCompanion: !!t?.passenger };
    });
  }

  /**
   * Accepting swaps the holder and bumps the version (old QR codes die) in one transaction. The unique
   * "one active ticket per person per event" index stops a friend who meanwhile got a ticket of their own.
   */
  async respond(transferId: ObjectId, userId: ObjectId, accept: boolean) {
    const now = this.clock.now();
    const x = await this.transfers.findOne({ _id: transferId, toUserId: userId });
    if (!x) throw errors.notFound('Transfert introuvable.');
    if (x.status !== 'pending' || x.expiresAt <= now) throw errors.gone('TRANSFER_EXPIRED', 'Ce transfert n’est plus valable.');
    const tellSender = async (accepted: boolean) => {
      const friend = shortName((await this.accounts.namesByIds([userId])).get(userId.toHexString()));
      await this.notifications.notify([x.fromUserId], {
        type: accepted ? 'ticket.transfer_accepted' : 'ticket.transfer_declined', category: 'social', icon: 'swap-horizontal', tone: accepted ? 'success' : 'warning',
        url: `/billet/${x.ticketId.toHexString()}`, dedupeKey: `transfer:${x._id.toHexString()}:answered`,
        title: accepted ? `${friend} a accepté ton billet` : `${friend} a refusé ton billet`,
        body: accepted ? 'Le billet est à son nom maintenant : ton QR code ne marche plus.' : 'Ton billet est toujours à toi.',
      });
    };
    if (!accept) {
      await this.transfers.updateOne({ _id: x._id, status: 'pending' }, { $set: { status: 'declined', respondedAt: now } });
      await this.hub.publish(userTopic(x.fromUserId), 'ticket.updated', { ticketId: x.ticketId.toHexString() });
      await tellSender(false);
      return { status: 'declined' as const, ticketId: null };
    }
    const t = await this.tickets.findOne({ _id: x.ticketId });
    if (!t) throw errors.notFound('Billet introuvable.');
    if (await this.hasActiveTicket(t.eventId, userId)) throw errors.rule('RECIPIENT_HAS_TICKET', 'Tu as déjà un billet pour ce départ.');
    const refused = await this.handler(t.kind).refuseRecipient(t, userId);
    if (refused) throw errors.rule('RECIPIENT_REFUSED', refused);

    try {
      await withTransaction(this.mongo, async (session) => {
        const ok = await this.transfers.updateOne({ _id: x._id, status: 'pending' }, { $set: { status: 'accepted', respondedAt: now } }, { session });
        if (!ok.modifiedCount) throw errors.gone('TRANSFER_EXPIRED', 'Ce transfert n’est plus valable.');
        const moved = await this.tickets.updateOne(
          { _id: t._id, status: 'active', version: x.ticketVersion, holderUserId: x.fromUserId, admittedAt: null },
          // The recipient travels on it now: a companion's name on it no longer applies.
          { $set: { holderUserId: userId, passenger: null, holderTravels: true, updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
        if (!moved.modifiedCount) throw errors.gone('TRANSFER_EXPIRED', 'Le billet a changé entre-temps (annulé ou déjà utilisé).');
        afterCommit(session, async () => {
          for (const u of [x.fromUserId, userId]) await this.hub.publish(userTopic(u), 'ticket.updated', { ticketId: t._id.toHexString() });
          await this.hub.publish(eventTopic(t.eventId), 'tickets.updated', { ticketId: t._id.toHexString() });
        });
      });
    } catch (err) {
      if (isDuplicateKey(err, 'event_traveller_active_unique')) throw errors.rule('RECIPIENT_HAS_TICKET', 'Tu as déjà un billet pour ce départ.');
      throw err;
    }
    await tellSender(true);
    return { status: 'accepted' as const, ticketId: t._id.toHexString() };
  }

  /** The sender takes the offer back before the friend answers. */
  async withdraw(transferId: ObjectId, userId: ObjectId) {
    const res = await this.transfers.updateOne({ _id: transferId, fromUserId: userId, status: 'pending' }, { $set: { status: 'cancelled', respondedAt: this.clock.now() } });
    if (!res.matchedCount) throw errors.notFound('Transfert introuvable.');
  }

  /** Worker: offers nobody answered in time. */
  async expireTransfers() {
    const res = await this.transfers.updateMany({ status: 'pending', expiresAt: { $lte: this.clock.now() } }, { $set: { status: 'expired' } });
    return res.modifiedCount;
  }

  // ---- Scanning ("faire monter", "faire descendre") --------------------------------------------------------------

  /** May this user follow the live scans of an event? Members of the organization running it. */
  async canFollowEvent(userId: ObjectId, eventId: ObjectId) {
    for (const h of this.handlers.values()) {
      const orgId = await h.orgOf(eventId);
      if (orgId) return !!(await this.organizations.roleIn(orgId, userId, ['owner', 'manager', 'scanner'], 'organizer'));
    }
    return false;
  }

  /**
   * Checks a QR code, a typed code or a ticket picked in the list, and admits the holder. Every scan is recorded,
   * refused ones too. A retried scan (same clientScanId) gives the first answer again.
   */
  async admit(orgId: ObjectId, scannerId: ObjectId, input: ScanInput): Promise<ScanResult> {
    if (input.code) await this.limiter.hit(`scan-code:${scannerId.toHexString()}`, { limit: 30, windowS: 60 }, 'Trop de codes saisis. Patiente une minute.');
    if (input.clientScanId) {
      const seen = await this.admissions.findOne({ orgId, clientScanId: input.clientScanId });
      if (seen) return this.replay(seen);
    }
    const now = this.clock.now();
    const method: AdmissionDoc['method'] = input.qr ? 'qr' : input.code ? 'code' : 'manual';
    const base = {
      orgId, method, scannedBy: scannerId, deviceId: input.deviceId ?? null, clientScanId: input.clientScanId ?? null,
      locationId: input.locationId ?? null, scannedAt: input.scannedAt ? new Date(input.scannedAt) : now, receivedAt: now, voided: null,
    };
    const reject = async (reason: string, title: string, text: string, t: TicketDoc | null = null): Promise<ScanResult> => {
      await this.record({ ...base, ticketId: t?._id ?? null, eventId: t?.eventId ?? null, result: 'rejected', reason, active: false });
      return { result: 'rejected', tone: 'danger', title, text, reason, eventId: t && t.orgId.equals(orgId) ? t.eventId.toHexString() : null, ticket: null, holder: null, companionOf: null, group: null, cashDue: 0 };
    };

    // 1. Which ticket
    let t: TicketDoc | null;
    if (input.qr) {
      const claims = await this.tokens.verifyTicket(input.qr.trim());
      if (!claims || !ObjectId.isValid(claims.ticketId)) return reject('bad_signature', 'Pas un billet UGB Connect', 'Ce QR code ne vient pas de l’app. Refuse l’accès.');
      t = await this.tickets.findOne({ _id: new ObjectId(claims.ticketId) });
      if (!t) return reject('unknown', 'Billet non valable', 'Billet inconnu : faux ou trop ancien.');
      if (t.orgId.equals(orgId) && claims.version !== t.version) {
        return reject('stale_version', 'Ancien QR code', 'Ce billet a été transféré à quelqu’un d’autre : ce QR ne vaut plus rien. Demande le nouveau.', t);
      }
    } else if (input.code) {
      const code = input.code.trim().toUpperCase();
      const events = input.eventId && ObjectId.isValid(input.eventId) ? [new ObjectId(input.eventId)] : await this.openEvents(orgId, now);
      t = events.length ? await this.tickets.findOne({ orgId, eventId: { $in: events }, code }) : null;
      if (!t) return reject('unknown', 'Billet non valable', `${code || 'Ce code'} n’est pas sur la liste : billet annulé, faux ou mal saisi.`);
    } else if (input.ticketId && ObjectId.isValid(input.ticketId)) {
      t = await this.tickets.findOne({ _id: new ObjectId(input.ticketId), orgId });
      if (!t) return reject('unknown', 'Billet non valable', 'Ce billet n’est pas sur la liste.');
    } else {
      throw errors.validation('Scanne un QR code ou saisis un code.');
    }

    // 2. Is it for us, for this event, still valid
    if (!t.orgId.equals(orgId)) return reject('wrong_org', 'Billet d’un autre organisateur', 'Ce billet n’est pas pour tes départs. Refuse l’accès.');
    if (input.eventId && ObjectId.isValid(input.eventId) && !t.eventId.equals(new ObjectId(input.eventId))) {
      const other = (await this.handler(t.kind).present([t], scannerId)).get(t._id.toHexString())?.event;
      return reject('wrong_event', 'Autre départ', other ? `Ce billet est pour ${other.title}, le ${dakar.format(new Date(other.startsAt))}. Refuse l’accès.` : 'Ce billet est pour un autre départ.', t);
    }
    if (t.status !== 'active') return reject('cancelled', 'Billet annulé', 'Ce billet a été annulé et remboursé. Refuse l’accès.', t);
    const check = await this.handler(t.kind).checkAdmission(t, { locationId: input.locationId ?? null, now });
    if (!check.ok) return reject(check.reason, 'Embarquement fermé', check.message, t);

    // 3. Admit, once
    const { traveller, companionOf, group } = await this.scanPeople(t);
    const labels = this.handler(t.kind).labels;
    const who = `${traveller}${t.seat ? ` · place ${t.seat}` : ''}`;
    const ticket = { id: t._id.toHexString(), code: t.code, seat: t.seat };
    const people = { holder: { name: traveller }, companionOf, group };
    try {
      await this.record({ ...base, ticketId: t._id, eventId: t.eventId, result: 'admitted', reason: null, active: true });
    } catch (err) {
      if (!isDuplicateKey(err, 'ticket_active_unique')) throw err;
      await this.record({ ...base, ticketId: t._id, eventId: t.eventId, result: 'duplicate', reason: 'already_admitted', active: false });
      return {
        result: 'duplicate', tone: 'warning', title: labels.duplicate,
        text: `${who}. Vérifie qu’il n’y a pas deux personnes avec ce billet.`,
        reason: 'already_admitted', eventId: t.eventId.toHexString(), ticket, cashDue: 0, ...people,
      };
    }
    // Paid in cash: the money is taken now, at the scan (once: a voided then repeated scan doesn't ask again).
    const cashDue = t.paidWith === 'cash' && !t.cashCollectedAt ? t.price : 0;
    await this.tickets.updateOne({ _id: t._id }, { $set: { admittedAt: now, updatedAt: now, ...(cashDue ? { cashCollectedAt: now } : {}) } });
    await this.hub.publish(eventTopic(t.eventId), 'admission.updated', { ticketId: t._id.toHexString(), admitted: true });
    const collect = cashDue ? `À encaisser : ${String(cashDue).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA en espèces.` : '';
    return {
      result: 'admitted', tone: check.warning || cashDue ? 'warning' : 'success', title: who,
      text: [collect, companionOf ? `Accompagnant de ${companionOf}.` : '', check.warning, ...check.notes].filter(Boolean).join(' '),
      reason: null, eventId: t.eventId.toHexString(), ticket, cashDue, ...people,
    };
  }

  /**
   * Who a scanned ticket is for: the companion's name on a companion ticket, else the holder's; and the purchaser's
   * other valid tickets on the event, so the scanner can board a pair together.
   */
  private async scanPeople(t: TicketDoc): Promise<{ traveller: string; companionOf: string | null; group: ScanGroup | null }> {
    const others = await this.tickets.find({ eventId: t.eventId, purchaserUserId: t.purchaserUserId, status: 'active', _id: { $ne: t._id } }).sort({ seat: 1 }).toArray();
    const ids = [t.holderUserId, t.purchaserUserId, ...others.map((o) => o.holderUserId)];
    const names = await this.accounts.namesByIds([...new Map(ids.map((u) => [u.toHexString(), u])).values()]);
    const nameOf = (x: TicketDoc) => x.passenger?.name ?? fullName(names.get(x.holderUserId.toHexString()));
    return {
      traveller: nameOf(t),
      companionOf: t.passenger ? fullName(names.get(t.holderUserId.toHexString())) : null,
      group: others.length
        ? {
            size: others.length + 1,
            purchaser: fullName(names.get(t.purchaserUserId.toHexString())),
            others: others.map((o) => ({ ticketId: o._id.toHexString(), seat: o.seat, name: nameOf(o), admitted: !!o.admittedAt })),
          }
        : null,
    };
  }

  private async record(doc: Omit<AdmissionDoc, '_id'>) {
    await this.admissions.insertOne({ _id: new ObjectId(), ...doc });
  }

  /** Same answer as the first time for a retried scan (no second boarding, no second rejection line). */
  private async replay(a: AdmissionDoc): Promise<ScanResult> {
    const t = a.ticketId ? await this.tickets.findOne({ _id: a.ticketId }) : null;
    const p = t ? await this.scanPeople(t) : null;
    const tone = a.result === 'admitted' ? 'success' : a.result === 'duplicate' ? 'warning' : 'danger';
    return {
      result: a.result, tone, title: t && p ? `${p.traveller}${t.seat ? ` · place ${t.seat}` : ''}` : 'Billet non valable', text: 'Scan déjà enregistré.',
      reason: a.reason, eventId: a.eventId?.toHexString() ?? null, ticket: t ? { id: t._id.toHexString(), code: t.code, seat: t.seat } : null,
      holder: p ? { name: p.traveller } : null, companionOf: p?.companionOf ?? null, group: p?.group ?? null, cashDue: 0,
    };
  }

  private async openEvents(orgId: ObjectId, now: Date) {
    const all: ObjectId[] = [];
    for (const h of this.handlers.values()) all.push(...(await h.openForAdmission(orgId, now)));
    return all;
  }

  /** "Faire descendre": the boarding was a mistake (wrong person, scanned twice by accident). Kept, marked void. */
  async voidAdmission(orgId: ObjectId, ticketId: ObjectId, userId: ObjectId, reason: string | null) {
    const now = this.clock.now();
    const a = await this.admissions.findOneAndUpdate({ ticketId, orgId, active: true }, { $set: { active: false, voided: { at: now, by: userId, reason } } });
    if (!a) throw errors.notFound('Ce passager n’est pas à bord.');
    await this.tickets.updateOne({ _id: ticketId }, { $set: { admittedAt: null, updatedAt: now } });
    await this.hub.publish(eventTopic(a.eventId!), 'admission.updated', { ticketId: ticketId.toHexString(), admitted: false });
  }

  /** Admission state of an event's tickets, for the organizer's list. */
  async admittedTicketIds(eventId: ObjectId) {
    const rows = await this.admissions.find({ eventId, active: true }, { projection: { ticketId: 1, receivedAt: 1, locationId: 1 } }).toArray();
    return new Map(rows.map((r) => [r.ticketId!.toHexString(), { at: r.receivedAt, locationId: r.locationId }]));
  }
}

