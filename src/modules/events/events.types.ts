import type { ObjectId } from 'mongodb';

import type { ImageRef } from '../../platform/media.js';
import type { Audience } from '../accounts/index.js';
import type { PaymentMethod } from '../payments/index.js';
import type { TicketPaymentMethod } from '../ticketing/index.js';

export const EVENT_CATEGORIES = ['soiree', 'conference', 'sortie', 'sport', 'culture', 'autre'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<EventCategory, string> = { soiree: 'Soirée', conference: 'Conférence', sortie: 'Sortie', sport: 'Sport', culture: 'Culture', autre: 'Événement' };

/**
 * draft → published (verified organizations), or, for a student's event: draft → pending_review → approved (the
 * owner picks who sees it and pays the publication, per place) → published; or changes_requested (the admin's
 * message says what to fix; resubmitted after editing) or rejected.
 */
export const EVENT_STATUSES = ['draft', 'pending_review', 'changes_requested', 'rejected', 'approved', 'published', 'cancelled', 'completed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Who sees the event on the home screen: each non-empty list narrows (all empty: the whole university). */
export type EventAudience = Audience & { villages: string[] };

/** A student's event is published once the owner pays: so much per place put on sale, with a minimum. */
export const PUBLICATION_FEE = { perPlace: 40, minimum: 500 };
export const publicationFee = (places: number) => Math.max(PUBLICATION_FEE.minimum, places * PUBLICATION_FEE.perPlace);

/** "Standard 2 000 FCFA", "VIP 5 000 FCFA": its own price and number of places. Price 0: free (registration). */
export type TicketType = { typeId: string; name: string; description: string | null; price: number; capacity: number; remaining: number };

/**
 * A party, a conference, an outing… run by an organization the platform verified for events. Tickets are issued by
 * the ticketing module (kind `event_entry`) and scanned at the entrance.
 */
export type EventDoc = {
  _id: ObjectId;
  /** Short, unique: "EV7KQ2M". */
  code: string;
  orgId: ObjectId;
  title: string;
  category: EventCategory;
  description: string;
  /** 1 to 8, the first is the cover. */
  images: ImageRef[];
  /** The organizer chose the cover (the first picture). Otherwise its banner shows one of the pictures at random. */
  fixedCover?: boolean;
  venue: { name: string; address: string | null };
  startsAt: Date;
  endsAt: Date;
  salesCloseAt: Date;
  ticketTypes: TicketType[];
  /** Tickets one student can buy for this event, all orders together (for friends too). */
  maxPerStudent: number;
  /** How students may pay: Wave, Orange Money, cash at the door. Missing: Wave and Orange Money (events from before). */
  paymentMethods?: TicketPaymentMethod[];
  status: EventStatus;
  audience: EventAudience;
  /** A student's event: the publication being paid (or paid). */
  publication: { places: number; fee: number; method: PaymentMethod; paymentId: ObjectId; paidAt: Date | null } | null;
  /** The admins' last word on a student's event: what to correct, or why it's refused. */
  review: { message: string; at: Date; by: ObjectId } | null;
  /** Every submission and decision, oldest first. */
  reviewLog: { at: Date; by: ObjectId; action: 'submitted' | 'approved' | 'changes_requested' | 'rejected'; message: string | null }[];
  cancellation: { at: Date; reason: string } | null;
  publishedAt: Date | null;
  completedAt: Date | null;
  claimPayoutId: ObjectId | null;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const BOOKING_STATUSES = ['held', 'confirmed', 'cancelled', 'expired'] as const;
export type EventBookingStatus = (typeof BOOKING_STATUSES)[number];

/** One ticket of an order: its id is the ticket's `source`, so each ticket is issued once. */
export type BookingUnit = { unitId: ObjectId; typeId: string; name: string; price: number; status: EventBookingStatus; ticketId: ObjectId | null };

/** An order: one or more tickets, one payment (none for a free event). Places are held 10 minutes while paying. */
export type EventBookingDoc = {
  _id: ObjectId;
  eventId: ObjectId;
  userId: ObjectId;
  units: BookingUnit[];
  total: number;
  method: TicketPaymentMethod;
  status: EventBookingStatus;
  holdExpiresAt: Date;
  paymentId: ObjectId | null;
  /** Ordered by the organizing team: every ticket is one to give (none for them). */
  forFriends?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const HOLD_MIN = 10;
/** Free cancellation until 24 h before the start, then 10 % (same rule as the caravans). */
export const FREE_CANCEL_MS = 24 * 60 * 60 * 1000;
export const LATE_CANCEL_FEE = 0.1;
/** The entrance opens this long before the start and closes this long after the end. */
export const ENTRY_OPENS_MS = 3 * 60 * 60 * 1000;
export const ENTRY_GRACE_MS = 2 * 60 * 60 * 1000;
