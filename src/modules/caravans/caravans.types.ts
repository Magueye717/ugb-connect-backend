import type { ObjectId } from 'mongodb';

import type { TicketPaymentMethod } from '../ticketing/index.js';
import type { SeatLayout } from './vehicle-models.js';

export const DIRECTIONS = ['aller', 'retour'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** A bus or minibus checked by the platform: its registered capacity is the most that is ever sold. */
export type VehicleDoc = {
  _id: ObjectId;
  orgId: ObjectId;
  /** "Bus 64 places" */
  label: string;
  /** Optional (the app doesn't ask for it). Normalized, unique when set: "DK-4821-BF". */
  plate: string | null;
  /** Shown to students on the trip ("Climatisé"). */
  airConditioned: boolean;
  capacity: number;
  /** Seats per row, for the seat map (and window seats: first and last of each row). */
  seatsPerRow: number;
  /** Seats never sold (driver's helper, broken seat). */
  blockedSeats: number[];
  /** From the catalog ("bus-53"): its plan is `layout`. Null: one the organizer described (rows of `seatsPerRow`). */
  model?: string | null;
  /** The seat plan, front first; null: drawn from `capacity` and `seatsPerRow`. */
  layout?: SeatLayout | null;
  status: 'active' | 'retired';
  createdAt: Date;
  updatedAt: Date;
};

/** A pickup or drop-off point, with the bus's scheduled time there. */
export type Stop = { stopId: string; place: string; at: Date };

export const DEPARTURE_STATUSES = ['draft', 'published', 'confirmed', 'cancelled', 'departed', 'completed'] as const;
export type DepartureStatus = (typeof DEPARTURE_STATUSES)[number];

/**
 * One trip of one vehicle. The ticketing module calls it an "event": tickets are issued for it, scanned at its
 * pickup stops.
 */
export type DepartureDoc = {
  _id: ObjectId;
  /** Short, unique, readable: "DK0903A". */
  code: string;
  orgId: ObjectId;
  vehicleId: ObjectId;
  /** Snapshot at publication: later edits to the vehicle don't change a sold trip. */
  vehicle: { label: string; plate: string | null; airConditioned: boolean; capacity: number; seatsPerRow: number; blockedSeats: number[]; layout?: SeatLayout | null };
  direction: Direction;
  /** Cities shown on the card ("UGB", "Dakar"). */
  from: string;
  to: string;
  /** In route order. The first pickup is the departure. */
  pickups: Stop[];
  /** In route order. Times are estimates. */
  dropoffs: Stop[];
  departureAt: Date;
  price: number;
  /** Seats one student can buy on this trip (their own + companions). Set by the organizer, 2 by default. */
  maxSeatsPerStudent: number;
  /** The providers the organizer accepts for this trip (Wave, Orange Money, or both). */
  /** Wave, Orange Money, cash (handed over at boarding): the organizer's choice. */
  paymentMethods: TicketPaymentMethod[];
  /** Confirmed seats needed for the trip to go ahead; below that at `confirmBy`, everyone is refunded. */
  minPassengers: number;
  confirmBy: Date;
  bookingClosesAt: Date;
  status: DepartureStatus;
  /** Held (paying) + confirmed seats. For listings; the authority is the unique index on bookings. */
  seatsTaken: number;
  seatsConfirmed: number;
  /** "Le bus repart de cet arrêt": who wasn't scanned at a stop the bus left is absent. */
  stopsLeft: { stopId: string; at: Date; by: ObjectId }[];
  cancellation: { at: Date; by: 'organizer' | 'system'; reason: string } | null;
  confirmedAt: Date | null;
  departedAt: Date | null;
  completedAt: Date | null;
  claimPayoutId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export const BOOKING_STATUSES = ['held', 'confirmed', 'cancelled', 'expired'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Someone travelling on a seat the student bought for them ("accompagnant"). They need no account. */
export type Passenger = { name: string; phone: string };

/**
 * One seat of a purchase. Seats bought together share an `orderId` and one payment; a confirmed booking issues one
 * ticket (ticketing module).
 */
export type BookingDoc = {
  _id: ObjectId;
  departureId: ObjectId;
  /** The purchaser. */
  userId: ObjectId;
  /** Seats paid together: the payment's `purposeRef`. */
  orderId: ObjectId;
  /** The request's code (all its seats): shown as a QR code (UGBREQ:…), scanned or typed by the organizer. */
  requestCode?: string;
  /** This seat's own code (UGBREQ:…): paid and validated on its own, the order's other seats still waiting. */
  seatCode?: string;
  /**
   * 1..maxSeatsPerStudent, unique per student and departure while the booking counts for the limit: two purchases
   * made at the same moment can't both take the last slot.
   */
  slot: number;
  /** Null: the purchaser travels on this seat. */
  passenger: Passenger | null;
  /** `passenger === null`, for the index that stops a student holding two seats for themselves. */
  forSelf: boolean;
  seat: number;
  pickupStopId: string;
  dropoffStopId: string;
  /** Copied from the departure on the server: the app never sets a price. */
  price: number;
  method: TicketPaymentMethod;
  status: BookingStatus;
  /** True while held or confirmed: the seat is taken (unique per departure). */
  seatActive: boolean;
  /**
   * True while held or confirmed, and still after the ticket is given to a friend: a few seats per student per
   * departure, so nobody fills a bus by buying and transferring again and again.
   */
  countsForLimit: boolean;
  holdExpiresAt: Date;
  paymentId: ObjectId | null;
  ticketId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Seats a student can buy per departure unless the organizer says otherwise (their own + one companion). */
export const DEFAULT_MAX_SEATS_PER_STUDENT = 2;
export const MAX_SEATS_PER_STUDENT = 10;

/** Seats are held this long while paying. */
export const HOLD_MIN = 10;
/** A request waits this long for its organizer to validate it (cash received), never past the departure. */
export const REQUEST_H = 24;
/** Requests waiting at once, per student (one per departure). */
export const MAX_PENDING_REQUESTS = 3;
/** Bookings close this long before departure (default). */
export const BOOKING_CLOSE_MIN = 30;
/** Seats in the first row, on the right (the door and the driver take the left): the seat map starts with them. */
export const FIRST_ROW_SEATS = 2;
/** Free cancellation until 24 h before departure, then 10 % (the app's rule). */
export const FREE_CANCEL_MS = 24 * 60 * 60 * 1000;
export const LATE_CANCEL_FEE = 0.1;
/** Transfers close 2 h before departure (decision Q-4). */
export const TRANSFER_CUTOFF_MS = 2 * 60 * 60 * 1000;
/** Scanning opens this long before the first pickup, and stays open until arrival plus this margin. */
export const BOARDING_OPENS_MS = 3 * 60 * 60 * 1000;
export const BOARDING_GRACE_MS = 6 * 60 * 60 * 1000;
