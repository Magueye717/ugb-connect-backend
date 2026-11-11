import type { ClientSession, ObjectId } from 'mongodb';

import { PAYMENT_METHODS } from '../payments/index.js';

/**
 * How a ticket is paid: in the app (Wave, Orange Money) or in cash, handed to the organizer at boarding or at the
 * door. Each event / departure says which it accepts.
 */
export const TICKET_PAYMENT_METHODS = ['cash', ...PAYMENT_METHODS] as const;
export type TicketPaymentMethod = (typeof TICKET_PAYMENT_METHODS)[number];
export const TICKET_PAYMENT_LABELS: Record<TicketPaymentMethod, string> = { cash: 'Espèces', wave: 'Wave', orange_money: 'Orange Money' };

/**
 * What a ticket admits to. Ticketing is generic: it issues, transfers, cancels and scans tickets; the module that
 * owns the event (caravans for `caravan_seat`, a future events module for `event_entry`…) registers a
 * TicketKindHandler that knows the event's rules.
 */
export const TICKET_KINDS = ['caravan_seat', 'event_entry'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export type TicketStatus = 'active' | 'cancelled';

export type TicketDoc = {
  _id: ObjectId;
  kind: TicketKind;
  /** The departure, the concert…: what the ticket admits to. */
  eventId: ObjectId;
  /** The organization running the event: only its members can scan the ticket. */
  orgId: ObjectId;
  /** 6 random characters (Crockford base32), unique per event: typed when a phone can't show its QR. */
  code: string;
  /** Who paid. Never changes. */
  purchaserUserId: ObjectId;
  /** Whose app shows the ticket. Changes on transfer; receives the refund if cancelled (decision Q-3). */
  holderUserId: ObjectId;
  /**
   * Who travels / enters when it isn't the holder: a companion the purchaser booked for, by name and phone, without
   * an account. Cleared when the ticket is transferred (the recipient travels).
   */
  passenger: { name: string; phone: string } | null;
  /** `passenger === null`: the holder travels. One such ticket per person per event (unique index). */
  holderTravels: boolean;
  /** The purchase that issued it (a caravan booking…). Unique: confirming twice issues one ticket. */
  source: { type: 'caravan_booking' | 'event_booking'; id: ObjectId };
  /** Paid price, without fees: the base for refunds. */
  price: number;
  /** `cash`: reserved now, the price handed over at boarding / the door (never refunded, never paid out by the app). */
  paidWith: TicketPaymentMethod;
  /** Cash tickets: when the organizer took the money (at the scan). Null: still to collect. */
  cashCollectedAt?: Date | null;
  seat: number | null;
  /** Kind-specific data, read by the kind's handler only (caravan: pickup and drop-off stops). */
  details: Record<string, unknown>;
  status: TicketStatus;
  /** +1 on every transfer: older QR codes (screenshots) stop working. */
  version: number;
  /** Cache of the active admission (boarding), for lists. The authority is `admissions`. */
  admittedAt: Date | null;
  cancellation: {
    at: Date;
    by: 'holder' | 'organizer' | 'system';
    reason: 'holder_cancelled' | 'event_cancelled' | 'min_not_reached';
    fee: number;
    refundAmount: number;
    payoutId: ObjectId | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
};

export const TRANSFER_STATUSES = ['pending', 'accepted', 'declined', 'cancelled', 'expired'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** "Transférer à un ami": the friend accepts (decision Q-4); one transfer in flight per ticket. */
export type TicketTransferDoc = {
  _id: ObjectId;
  ticketId: ObjectId;
  eventId: ObjectId;
  fromUserId: ObjectId;
  toUserId: ObjectId;
  status: TransferStatus;
  /** The ticket version when offered: if it changed meanwhile, accepting fails. */
  ticketVersion: number;
  expiresAt: Date;
  respondedAt: Date | null;
  createdAt: Date;
};

/**
 * Every scan, append-only and auditable ("faire monter" for a bus, entry for an event). Unboarding ("faire
 * descendre") voids the admission instead of deleting it.
 */
export type AdmissionDoc = {
  _id: ObjectId;
  /** Null when the scanned code matched no ticket. */
  ticketId: ObjectId | null;
  eventId: ObjectId | null;
  orgId: ObjectId;
  /** Where it happened: the pickup stop for a bus, the gate for an event. */
  locationId: string | null;
  method: 'qr' | 'code' | 'manual';
  result: 'admitted' | 'duplicate' | 'rejected';
  reason: string | null;
  scannedBy: ObjectId;
  deviceId: string | null;
  /** Set by the scanning phone: a retried (or offline-synced) scan is recorded once. */
  clientScanId: string | null;
  scannedAt: Date;
  receivedAt: Date;
  voided: { at: Date; by: ObjectId; reason: string | null } | null;
  /** True only for an admission that counts (admitted, not voided): unique per ticket. */
  active: boolean;
};

/** Generic description of the event, for ticket lists and screens. */
export type EventSummary = {
  id: string;
  kind: TicketKind;
  title: string;
  startsAt: string;
  status: string;
  organizer: { id: string; name: string; category: string; level: string; rating: number | null; trips: number };
};

export type CancellationQuote = { allowed: true; fee: number; refund: number; freeUntil: string | null } | { allowed: false; reason: string };

export type AdmissionCheck = { ok: true; notes: string[]; warning: string | null } | { ok: false; reason: string; message: string };

/** What the module owning a ticket kind implements. Write hooks run inside ticketing's transaction. */
export type TicketKindHandler = {
  /** Event cards and the kind-specific part of each ticket (stops, times, vehicle…). */
  present(tickets: TicketDoc[], viewer: ObjectId): Promise<Map<string, { event: EventSummary; details: Record<string, unknown> }>>;
  /** Fee and refund if the holder cancels now; refused after departure, once boarded… */
  cancellationQuote(ticket: TicketDoc, now: Date): Promise<CancellationQuote>;
  /** Releases what the ticket held (seat, counters). */
  onCancelled(ticket: TicketDoc, session: ClientSession): Promise<void>;
  /** Latest moment a transfer can be offered or accepted. */
  transferDeadline(ticket: TicketDoc): Promise<Date>;
  /** Extra rule for the recipient (e.g. no pending booking on the same departure). Null = allowed. */
  refuseRecipient(ticket: TicketDoc, recipientId: ObjectId, session?: ClientSession): Promise<string | null>;
  /** Is the event open for scanning now, at this place; what to tell the scanner. */
  checkAdmission(ticket: TicketDoc, ctx: { locationId: string | null; now: Date }): Promise<AdmissionCheck>;
  /** Events of this organization open for scanning now (typed codes are looked up among them). */
  openForAdmission(orgId: ObjectId, now: Date): Promise<ObjectId[]>;
  /** The organization running an event, or null if it isn't one of this kind. */
  orgOf(eventId: ObjectId): Promise<ObjectId | null>;
};

export type NewTicket = {
  kind: TicketKind;
  eventId: ObjectId;
  orgId: ObjectId;
  purchaserUserId: ObjectId;
  source: TicketDoc['source'];
  price: number;
  paidWith: TicketPaymentMethod;
  seat: number | null;
  details: Record<string, unknown>;
  passenger: TicketDoc['passenger'];
  /** Default: the holder travels unless there's a passenger. False for the extra tickets of a multi-ticket order. */
  holderTravels?: boolean;
  /** Cash already handed to the organizer (a request they validated): nothing left to collect at the scan. */
  cashCollectedAt?: Date | null;
};

/** Transfers are refused this close to the start (decision Q-4). The kind can set an earlier deadline. */
export const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
