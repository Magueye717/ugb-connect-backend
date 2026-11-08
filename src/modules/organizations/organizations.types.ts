import type { ObjectId } from 'mongodb';

import type { ImageRef } from '../../platform/media.js';

/** `Étudiant`: a student's own organization, created when they first organize an event (reviewed by admins). */
export const ORG_CATEGORIES = ['Entreprise', 'Amicale', 'Transporteur', 'Restaurant', 'Boutique', 'Étudiant'] as const;
export const ORG_LEVELS = ['nouveau', 'verifie', 'confirme'] as const;
/**
 * What the platform verified the organization for: `events` lets it sell tickets for parties, conferences, outings;
 * `restaurant` and `shop` give it a business space (menus or articles, orders paid in the app).
 */
export const ORG_CAPABILITIES = ['caravans', 'restaurant', 'shop', 'events'] as const;
/** owner: everything incl. team · manager: departures, menus, orders · scanner: boarding only · staff: restaurant orders. */
export const ORG_ROLES = ['owner', 'manager', 'scanner', 'staff'] as const;
/**
 * The spaces of an organization in the app: one entity (Khoulé & frère) may run a restaurant, a shop and caravans,
 * each its own space with its own team. Caravans and events share the organizer space.
 */
export const ORG_SPACES = ['organizer', 'restaurant', 'shop'] as const;

export type OrgCategory = (typeof ORG_CATEGORIES)[number];
export type OrgLevel = (typeof ORG_LEVELS)[number];
export type OrgCapability = (typeof ORG_CAPABILITIES)[number];
export type OrgRole = (typeof ORG_ROLES)[number];
/** The providers a payout goes through. */
export const PAYOUT_PROVIDERS = ['wave', 'orange_money'] as const;
export type PayoutProvider = (typeof PAYOUT_PROVIDERS)[number];
export type OrgSpace = (typeof ORG_SPACES)[number];

/** The spaces an organization's capabilities open. Without a restaurant or shop, it organizes (caravans, events). */
export function spacesOf(o: { capabilities: readonly string[] }): OrgSpace[] {
  const out: OrgSpace[] = [];
  if (o.capabilities.includes('caravans') || o.capabilities.includes('events') || !(o.capabilities.includes('restaurant') || o.capabilities.includes('shop'))) out.push('organizer');
  if (o.capabilities.includes('restaurant')) out.push('restaurant');
  if (o.capabilities.includes('shop')) out.push('shop');
  return out;
}

export type OrganizationDoc = {
  _id: ObjectId;
  slug: string;
  name: string;
  category: OrgCategory;
  capabilities: OrgCapability[];
  /** Set by an admin until a rating flow exists (Q-22). */
  level: OrgLevel;
  stats: { ratingAvg: number | null; ratingCount: number; tripsCount: number };
  status: 'pending' | 'active' | 'suspended';
  /** Where organizer claims are paid (decision Q-2): a Wave / Orange Money number. */
  payoutAccount: { phone: string } | null;
  /**
   * One number per provider (a business taking Wave on one phone and Orange Money on another). Paid there for that
   * provider; `payoutAccount` otherwise (older organizations, caravans).
   */
  payoutAccounts?: Partial<Record<PayoutProvider, string>>;
  /** Contact address, given at creation or later (admin or owner). Not unique: one contact may run several organizations. */
  email: string | null;
  /** Logo or profile picture, set through the media module (never a client-supplied URL). */
  logo: ImageRef | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MembershipDoc = {
  _id: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  /** One membership per space: a shop employee never works in the restaurant. The owner holds every space. */
  space: OrgSpace;
  roles: OrgRole[];
  status: 'active' | 'revoked';
  grantedBy: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};
