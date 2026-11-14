import type { ObjectId } from 'mongodb';

/**
 * Campus housing, between students: swapping rooms, hosting (or looking for a host: the newcomers), sharing a rent.
 *   swap       « J'ai Village E, chambre 12 · je cherche Village A ou C »
 *   host_offer « Je peux héberger » (a room on campus or in town, for a while)
 *   host_need  « Je cherche où dormir » (a newcomer, the first weeks)
 *   roommate   « Cherche colocataire » (a room in town: Sanar, Saint-Louis…)
 */
export const HOUSING_KINDS = ['swap', 'host_offer', 'host_need', 'roommate'] as const;
export type HousingKind = (typeof HOUSING_KINDS)[number];

/** Who the ad is for (shared rooms are girls' or boys'). */
export const HOUSING_FOR = ['any', 'girls', 'boys'] as const;
export type HousingFor = (typeof HOUSING_FOR)[number];

/** open: on the board · closed: « Trouvé ! » by its author · hidden: reported by several students. */
export const HOUSING_STATES = ['open', 'closed', 'hidden'] as const;
export type HousingState = (typeof HOUSING_STATES)[number];

/** Ads close on their own after two months (a hosting ad: the day after its last night, if sooner). */
export const HOUSING_TTL_DAYS = 60;
/** Open ads per student at once. */
export const HOUSING_MAX_OPEN = 3;
/** Reports (by different students) that take an ad off the board until the team looks. */
export const HOUSING_HIDE_AFTER = 3;

/** "Moussa S.": how a student appears to the others. Never the full name, nor the phone. */
export type Masked = { name: string; initials: string };

export type HousingAdDoc = {
  _id: ObjectId;
  kind: HousingKind;
  authorId: ObjectId;
  author: Masked;
  /** swap: my village · host_offer: where I host · host_need: where I'd like (null: anywhere). */
  village: string | null;
  /** swap: my room ("12", "B 104"). */
  room: string | null;
  /** swap: the villages I'd take. */
  wants: string[];
  /** In town, or a detail: "Sanar", "Saint-Louis · Pikine". */
  area: string | null;
  /** Hosting: the nights (first, last). */
  from: Date | null;
  to: Date | null;
  /** Roommate: my share of the rent (FCFA a month), the places left. */
  rent: number | null;
  places: number | null;
  for: HousingFor;
  note: string | null;
  state: HousingState;
  /** Who reported it (once each). */
  reports: ObjectId[];
  expiresAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A student wrote to the author: one chat per ad and person (a housing_contact conversation). */
export type HousingContactDoc = { _id: ObjectId; adId: ObjectId; authorId: ObjectId; otherId: ObjectId; createdAt: Date };
