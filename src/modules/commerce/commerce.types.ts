import type { ObjectId } from 'mongodb';

import type { ImageRef } from '../../platform/media.js';
import type { Campus } from '../accounts/index.js';
import { PAYMENT_METHODS } from '../payments/index.js';

/** A private restaurant (menus, drinks) or a shop (articles), run by an organization with that capability. */
export const BUSINESS_KINDS = ['restaurant', 'shop'] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];

/** Where a business delivers, each with its own price: campus 1, campus 2, outside the campus. */
export const DELIVERY_ZONES = ['campus1', 'campus2', 'outside'] as const;
export type DeliveryZone = (typeof DELIVERY_ZONES)[number];
export const DELIVERY_ZONE_LABELS: Record<DeliveryZone, string> = { campus1: 'Campus 1', campus2: 'Campus 2', outside: 'Hors campus' };
/** FCFA per zone (0: free); null: no delivery there. All null: pickup only. */
export type DeliveryFees = Record<DeliveryZone, number | null>;

/** How an order is paid: in cash (to the business, no online payment) or online. */
export const ORDER_PAYMENT_METHODS = ['cash', ...PAYMENT_METHODS] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];
export const ORDER_PAYMENT_LABELS: Record<OrderPaymentMethod, string> = { cash: 'Espèces', wave: 'Wave', orange_money: 'Orange Money' };
/** A business's methods until its owner changes them: online only (cash is the owner's choice). */
/** Orders are paid in cash, at the delivery or the counter: Wave and Orange Money are only for UGB Connect's own fees. */
export const DEFAULT_PAYMENT_METHODS: OrderPaymentMethod[] = ['cash'];
/** A student absent at the delivery or the counter this many times within NO_SHOW_WINDOW_D can't order for NO_SHOW_BLOCK_D. */
export const NO_SHOW_LIMIT = 3;
export const NO_SHOW_WINDOW_D = 30;
export const NO_SHOW_BLOCK_D = 7;
/** Paid through Wave or Orange Money: only for a business the team has verified. */
export const ONLINE_PAYMENT_METHODS: OrderPaymentMethod[] = ['wave', 'orange_money'];
export const onlinePaymentsAllowed = (b: Pick<BusinessDoc, 'onlinePayments' | 'byStudent'>) => b.onlinePayments ?? !b.byStudent;

/** A business has one to MAX_SPECIALTIES of these (shown joined: "Sénégalais · Grillades"). */
export const MAX_SPECIALTIES = 4;

/** What a business may call its specialty: picked from these lists (the app reads them from GET /reference/commerce). */
export const SPECIALTIES: Record<BusinessKind, readonly string[]> = {
  restaurant: ['Sénégalais', 'Riz & sauces', 'Grillades', 'Plats du jour', 'Snacks', 'Fast-food', 'Petit-déjeuner', 'Pâtisserie', 'Jus & boissons', 'Africain', 'International', 'Végétarien'],
  shop: ['Fournitures', 'Épicerie', 'Téléphonie', 'Informatique', 'Vêtements', 'Cosmétiques', 'Impression & reprographie', 'Électroménager', 'Accessoires', 'Services', 'Autre'],
};

/** "13:00" to "15:00": the same every day. Several services: lunch and dinner. */
export type Service = { start: string; end: string };

/**
 * What students see of the business, set by an admin at creation then by its owner or managers: picture, where it is
 * (GPS point for directions, words, campus), contact, opening hours, delivery.
 */
export type BusinessDoc = {
  _id: ObjectId;
  /** The organization (members, payout number). One restaurant and one shop at most per organization. */
  orgId: ObjectId;
  kind: BusinessKind;
  name: string;
  /** One or several, from SPECIALTIES: "Sénégalais", "Grillades"; "Fournitures", "Impression & reprographie". */
  specialties: string[];
  description: string;
  photo: ImageRef | null;
  location: { lat: number; lng: number } | null;
  /** In words students use: "Près du Village E". */
  address: string;
  campus: Campus | null;
  phone: string;
  services: Service[];
  /** Delivery price per zone; all null: pickup only. */
  deliveryFees: DeliveryFees;
  /** How students may pay this business: cash (at delivery or at the counter), Wave, Orange Money. At least one. */
  paymentMethods: OrderPaymentMethod[];
  /** The owner can pause orders (closed today, out of stock) without touching the hours. */
  acceptingOrders: boolean;
  active: boolean;
  /** A student's own shop (products or services they sell on campus). */
  byStudent?: boolean;
  /**
   * May take Wave and Orange Money. A student's shop starts with cash only, until the team has checked who runs it;
   * missing: allowed for businesses the team created, not for students' (see `onlinePaymentsAllowed`).
   */
  onlinePayments?: boolean;
  /** The students' average rating of their orders (ratings module); missing until the first one. */
  rating?: { avg: number | null; count: number };
  createdAt: Date;
  updatedAt: Date;
};

/** Restaurants: menus of the day and drinks. Shops: articles (with a category of their own). */
export const ITEM_SECTIONS = ['menu', 'drink', 'article'] as const;
export type ItemSection = (typeof ITEM_SECTIONS)[number];

/** An article shown from several sides (a bag, a dress…): the cover and up to five more. */
export const MAX_ITEM_PHOTOS = 6;
/**
 * Référencement (the team documenting a restaurant or a shop) isn't held to the owners' limit: as many as a full
 * catalogue needs, with a ceiling only so that a slip can't fill the storage.
 */
export const EDITOR_MAX_ITEM_PHOTOS = 30;

export type CatalogItemDoc = {
  _id: ObjectId;
  businessId: ObjectId;
  section: ItemSection;
  /** Shops: "Fournitures", "Accessoires"… (free text, groups the articles). */
  category: string | null;
  name: string;
  detail: string;
  price: number;
  /** In order: the first is the cover (cards, the basket, order lines). Up to MAX_ITEM_PHOTOS. */
  photos: ImageRef[];
  /** Shops: units left (orders take them, refusals give them back); null: not counted. */
  stock: number | null;
  /** Shown and orderable today (the « indisponible aujourd’hui » switch). */
  available: boolean;
  /**
   * A restaurant's weekly menu: the days it's served, 1 (lundi) to 7 (dimanche). Absent or null: every day. Students
   * only see, and order, today's.
   */
  days?: number[] | null;
  /**
   * False: shown for information only (a service done on the spot: "Impression · 25 F la page"), never in an order.
   * Such an item has no stock.
   */
  orderable: boolean;
  /** Students who like it (a heart on the card): kept in step with `itemLikes`. */
  likes: number;
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Today, 1 (lundi) to 7 (dimanche), in Dakar (UTC). */
export const isoDay = (now: Date) => ((now.getUTCDay() + 6) % 7) + 1;
/** The catalog query for what's served today: every day, or today among its days. */
export const servedOn = (day: number) => ({ $or: [{ days: null }, { days: day }] });

/** Students like a shop's articles; a restaurant's dishes have no heart. */
export const LIKEABLE_KINDS: readonly BusinessKind[] = ['shop'];

/** One student likes one article or dish (at most once): its heart is filled for them, its count includes them. */
export type ItemLikeDoc = {
  _id: ObjectId;
  userId: ObjectId;
  itemId: ObjectId;
  businessId: ObjectId;
  createdAt: Date;
};

/**
 * pending_payment → placed (paid: the business is notified) → accepted (being prepared) → ready (on its way, or to
 * pick up) → completed (paid out to the business). The business can refuse a placed order and the student can cancel
 * it before it's accepted: refunded either way. Unpaid: expired.
 */
export const ORDER_STATUSES = ['pending_payment', 'placed', 'accepted', 'ready', 'completed', 'refused', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_MODES = ['delivery', 'pickup'] as const;
export type OrderMode = (typeof ORDER_MODES)[number];

export type OrderLine = { itemId: ObjectId; name: string; price: number; qty: number };

export type OrderDoc = {
  _id: ObjectId;
  /** Short, said at the counter: "C7KQ2M". */
  code: string;
  businessId: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  lines: OrderLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  mode: OrderMode;
  /** Delivery: the zone chosen (its price is `deliveryFee`). */
  zone: DeliveryZone | null;
  address: string | null;
  note: string | null;
  /** `cash`: no online payment; paid at delivery or at the counter. */
  method: OrderPaymentMethod;
  paymentId: ObjectId | null;
  status: OrderStatus;
  /** Every step, oldest first. */
  /** The student never came (« Client absent »): cancelled by the business, counted against them. */
  noShowAt?: Date | null;
  history: { status: OrderStatus; at: Date; by: ObjectId | null }[];
  refusal: string | null;
  payoutId: ObjectId | null;
  refundPayoutId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/** « Mes ventes »: the longest period asked at once (a year, and a leap day). */
export const SALES_MAX_DAYS = 366;
/** « Mes ventes »: the best sellers listed. */
export const SALES_TOP_ITEMS = 5;

/** Time to pay before the order (and the stock it holds) goes back. */
export const ORDER_PAY_WITHIN_MIN = 15;
/** Orders still in the business's hands after this are completed by the worker (and paid out). */
export const ORDER_AUTO_COMPLETE_H = 12;
