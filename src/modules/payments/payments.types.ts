import type { ClientSession, ObjectId } from 'mongodb';

/** What the student picks in the app. */
export const PAYMENT_METHODS = ['wave', 'orange_money'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Who actually moves the money. `simulated` stands in for both methods in development. */
export const PROVIDERS = ['wave', 'orange_money', 'simulated'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** What a payment pays for. Each purpose is owned by the module that registers its handler. */
export const PAYMENT_PURPOSES = ['taxi_seat', 'caravan_booking', 'event_booking', 'event_publication', 'banner', 'commerce_order'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PAYMENT_STATUSES = ['created', 'pending', 'succeeded', 'failed', 'expired', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type PaymentDoc = {
  _id: ObjectId;
  /** `PAY_…`, unique. Sent to the provider as the merchant reference; the app polls with it. */
  reference: string;
  userId: ObjectId;
  purpose: PaymentPurpose;
  /** The thing paid for, in the owning module (a taxi participant…). */
  purposeRef: ObjectId;
  amount: number;
  currency: 'XOF';
  method: PaymentMethod;
  provider: ProviderId;
  description: string;
  providerSessionId: string | null;
  providerTxnId: string | null;
  checkoutUrl: string | null;
  /** Where the checkout page sends the student back (app deep link). */
  returnUrl: string | null;
  status: PaymentStatus;
  /** Set by the purpose handler once the money arrived: `unfulfillable` triggers a refund. */
  fulfillment: 'pending' | 'fulfilled' | 'unfulfillable';
  expiresAt: Date;
  statusHistory: { status: PaymentStatus; at: Date; source: 'webhook' | 'system' | 'user' }[];
  createdAt: Date;
  updatedAt: Date;
};

/** Webhook inbox: one document per provider event, the unique index is what makes duplicates harmless. */
export type PaymentEventDoc = {
  _id: ObjectId;
  provider: ProviderId;
  providerEventId: string;
  type: string;
  payload: Record<string, unknown>;
  signatureValid: boolean;
  receivedAt: Date;
  processedAt: Date | null;
  outcome: string | null;
};

export const PAYOUT_KINDS = ['refund', 'organizer_claim'] as const;
export const PAYOUT_REASONS = [
  'taxi_left', 'taxi_cancelled', 'taxi_handover', 'taxi_claim', 'late_payment_unfulfillable',
  // Tickets (caravans now, other events later)
  'ticket_cancelled', 'event_cancelled', 'min_not_reached', 'event_claim',
  // Paid banners refused by the communication team
  'banner_rejected',
  // Restaurant and shop orders: refused or cancelled (refund), completed (to the business)
  'order_refused', 'order_cancelled', 'order_payout',
] as const;
export type PayoutReason = (typeof PAYOUT_REASONS)[number];
export const PAYOUT_STATUSES = ['requested', 'processing', 'succeeded', 'failed', 'manual_required'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * Money sent to someone's Wave / Orange Money number: refunds and organizer claims alike (decision log,
 * "refunds become disbursements").
 */
export type PayoutDoc = {
  _id: ObjectId;
  kind: (typeof PAYOUT_KINDS)[number];
  /** Who receives it, or for an organization's claim, the member who asked for it. */
  beneficiaryUserId: ObjectId;
  /** Organizer claims: paid to the organization's own payout number, not to the member's. */
  beneficiaryOrgId?: ObjectId | null;
  /** Snapshot of the payout number at creation. */
  phone: string;
  method: PaymentMethod;
  provider: ProviderId;
  amount: number;
  reason: PayoutReason;
  source: { type: 'payment' | 'taxi_participant' | 'taxi_trip' | 'ticket' | 'caravan_departure' | 'event' | 'banner' | 'order'; id: ObjectId };
  status: PayoutStatus;
  providerTransferId: string | null;
  /** Unique: the same business event can never pay twice. */
  idempotencyKey: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** What a module implements for its purpose. Both calls run inside the payment's transaction and must be idempotent. */
export type PurposeHandler = {
  /** Money arrived. `unfulfillable` (seat gone, trip cancelled…) refunds the student automatically. */
  onSucceeded(payment: PaymentDoc, session: ClientSession): Promise<'fulfilled' | 'unfulfillable'>;
  /** The payment ended without money (failed, cancelled on the provider page, expired): release what it held. */
  onClosed(payment: PaymentDoc, session: ClientSession): Promise<void>;
};

/**
 * The admins' switch for each provider, app-wide (one document, `_id: 'methods'`). A method listed in `off` takes no
 * payment until switched back on: cash keeps working.
 */
export type PaymentSettingsDoc = {
  _id: 'methods';
  off: Partial<Record<PaymentMethod, { since: Date; by: ObjectId; note: string | null }>>;
  updatedAt: Date;
};

/** What the app shows: each method, and since when it's off (with the admins' note). */
export type MethodStatus = { method: PaymentMethod; available: boolean; offSince: string | null; note: string | null };

export type NewPayout = {
  kind: PayoutDoc['kind'];
  beneficiaryUserId: ObjectId;
  /** Organizer claims: the organization and its payout number (instead of the member's own). */
  payTo?: { orgId: ObjectId; phone: string };
  method: PaymentMethod;
  amount: number;
  reason: PayoutReason;
  source: PayoutDoc['source'];
  idempotencyKey: string;
};
