import type { ObjectId } from 'mongodb';

import type { ImageRef } from '../../platform/media.js';
import type { PaymentMethod } from '../payments/index.js';

/**
 * `ad`: a sponsored message (title, short text, picture, optional button). `event`: promotes an organization's
 * event; tapping it opens the event page (pictures, tickets).
 */
export const BANNER_KINDS = ['ad', 'event'] as const;
export type BannerKind = (typeof BANNER_KINDS)[number];

/**
 * pending_payment → (paid) pending_review → approved (shown from its start to its end) or rejected (refunded).
 * The owner can cancel before the review (refunded); the communication team can withdraw an approved one.
 */
export const BANNER_STATUSES = ['pending_payment', 'pending_review', 'approved', 'rejected', 'cancelled', 'withdrawn'] as const;
export type BannerStatus = (typeof BANNER_STATUSES)[number];

export const CTA_TARGETS = ['app', 'url', 'whatsapp', 'phone'] as const;
export type CtaTarget = (typeof CTA_TARGETS)[number];

/** A display period sold at a fixed price ("Week-end : 3 jours, 2 500 FCFA"), managed by an admin. */
export type BannerPackageDoc = { _id: ObjectId; code: string; name: string; days: number; price: number; active: boolean; sortOrder: number; createdAt: Date; updatedAt: Date };

export type BannerDoc = {
  _id: ObjectId;
  kind: BannerKind;
  /** Who paid (and is refunded if it's refused). */
  ownerId: ObjectId;
  /** Event banners: the organization and its event. */
  orgId: ObjectId | null;
  eventId: ObjectId | null;
  title: string;
  description: string;
  image: ImageRef;
  /** An event's banner with its own picture. Without (or missing on older ones), it shows the event's pictures. */
  ownImage?: boolean;
  /** Ads: "Voir", "Commander"… opening a screen of the app, a website, WhatsApp or a call. Events: the event page. */
  cta: { label: string; target: CtaTarget; value: string } | null;
  packageCode: string;
  days: number;
  price: number;
  method: PaymentMethod;
  startsAt: Date;
  endsAt: Date;
  /** Taken off the owner's « Mes publicités » (swipe), once settled: kept for the team and the accounts. */
  removedAt?: Date;
  status: BannerStatus;
  paymentId: ObjectId | null;
  review: { by: ObjectId; at: Date; reason: string | null } | null;
  refundPayoutId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/** At most this many banners on the home carousel on any day: sold out beyond. */
export const MAX_BANNERS_PER_DAY = 6;
/** Time to pay before the slot goes back. */
export const PAY_WITHIN_MIN = 15;
