import type { ObjectId } from 'mongodb';

import type { Campus } from '../accounts/index.js';

/** Places are documented by Référencement only: as many pictures as it takes, with a ceiling against slips. */
export const PLACE_MAX_PHOTOS = 30;

export const PLACE_CATEGORIES = ['Études', 'Restauration', 'Services', 'Sport', 'Santé', 'Administration', 'Logement', 'Culte', 'Transport'] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

/**
 * A place of the campus to know (library, rectorate, medical centre, barber…): where it is (GPS point for the map
 * and directions, in words), its hours, its photos. Managed by the communication team.
 */
export type PlaceDoc = {
  _id: ObjectId;
  name: string;
  category: PlaceCategory;
  description: string;
  /** In words students use: "Campus pédagogique · face à l'amphi A". */
  area: string;
  campus: Campus | null;
  location: { lat: number; lng: number };
  /** "8h-22h · lun.-sam."; null: always open or not relevant. */
  hours: string | null;
  /** Ionicons name, shown on the map and the cards. */
  icon: string;
  /** Uploaded (mediaId) or, for the first seeded places, an external picture (mediaId null). The first is the cover. */
  photos: { url: string; mediaId: ObjectId | null }[];
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};
